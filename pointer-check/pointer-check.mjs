#!/usr/bin/env node
// Fails when prose names a file, a symbol or an ADR that does not exist, or names it ambiguously.
//
//   node pointer-check.mjs [--root <dir>] [--report-only] [path ...]
//
// Prose is every Markdown file and every comment in a code file, minus the exempt set. A pointer
// is one of four explicit forms; anything else, a bare backticked word above all, is never one,
// because a missed pointer costs less than a false failure that teaches people to ignore the check:
//
//   a file path       `apps/rs/next.config.ts`, `scripts/evals/`, a relative Markdown link;
//                     resolves when exactly one tracked file or directory ends with it
//   a symbol          `Type.Member` or `name()` in backticks, or `see someName` in a comment;
//                     resolves when a file that declares the type uses the member in its code
//                     (strings and comments blanked); a library's type, used but never declared
//                     here (`DateTime.UtcNow`), only needs its names used together in one file
//   an ADR number     ADR 0047, ADR-0047; resolves when exactly one docs/adr/ file has it, or
//                     when the words beside it pick one of the files that share it
//   any of the above prefixed with a sibling repo's name (`pa-cms/Backend/X.cs`, pa-cms `X.Y`,
//                     pa-cms ADR 0009); checked in that sibling when it is checked out beside
//                     this one, skipped when it is not, so a lone clone's CI never fails on it
//
// The whole tree is scanned on every run, never a diff: a rename in one file strands a pointer
// in another file the diff does not touch.
//
// Per-repo settings live in `.pointer-check.jsonc` at the root (JSON with comments):
//   {
//     "exempt": ["path/prefix/", "glob/**/*.md", "!re/included.md"],  // last match wins
//     "siblings": { "name": ["../name", "name"] },  // present when a path holds a `.git`
//     "self": ["name"]                               // this repo's own names, as a prefix
//   }

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

const SNAPSHOT_HEADER = /^(>\s*)?Snapshot as of \d{4}-\d{2}-\d{2}\b/;

// Dated snapshots stay true as of their date, so a pointer in one is history, not a claim.
const DEFAULT_EXEMPT = ["docs/adr/", "docs/plans/", "docs/incidents/", "**/node_modules/**"];

// A bare `name.ext` is a file path only with one of these. Left out are served URLs (`robots.txt`,
// `sitemap.xml`), assets, data files a run writes (`batch.json`) and a library's compiled `.js`
// (`fbevents.js`, `get-img-props.js`): prose names those as outside facts where they bite (ADR
// 0047), not as files of ours.
const SOURCE_EXTENSIONS = new Set(
  (
    "md mdx ts tsx mts cts jsx mjs cs csproj sln props targets yml yaml sh bash " +
    "py sql html scss css toml tf hcl ps1 bats razor cshtml"
  ).split(" "),
);

// How comments are written, per extension. `names` marks a language whose code declares and uses
// the names a symbol pointer resolves against; config, style and markup files only carry comments.
const LANGUAGES = [
  { extensions: "ts tsx mts cts js jsx mjs cjs cs", scan: (text) => scanC(text, { slash: true }), names: true },
  { extensions: "scss less", scan: (text) => scanC(text, { slash: true }) },
  { extensions: "css", scan: (text) => scanC(text, {}) },
  { extensions: "sh bash zsh", scan: (text) => scanHash(text, {}), names: true },
  { extensions: "yml yaml toml bats", scan: (text) => scanHash(text, {}) },
  { extensions: "py", scan: (text) => scanHash(text, { python: true }), names: true },
  { extensions: "sql", scan: (text) => scanC(text, { dashes: true }), names: true },
  { extensions: "html", scan: (text) => scanMarkup(text), names: true },
  { extensions: "csproj props targets xml", scan: (text) => scanMarkup(text) },
  { extensions: "tf hcl", scan: (text) => scanC(text, { slash: true, hash: true }), names: true },
];
const LANGUAGE_OF = new Map(
  LANGUAGES.flatMap((language) => language.extensions.split(" ").map((extension) => [extension, language])),
);
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx"]);

const PATH_CHARS = /^[A-Za-z0-9_.\-/[\]()+@~]+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(rs|ba|com|net|org|io|dev|app|me|co|ai|sh|eu|de|uk|in)$/;
const IDENTIFIER = "[A-Za-z_$][\\w$]*";
// A call is `name()` or `name("literal")`: an identifier argument (`chore(deps)`) or a number
// (`oklch(0.5 0 0)`) is code being quoted, not a name being pointed at.
const CALL_SUFFIX = `\\((?:"[^"]*"|'[^']*')?\\)`;
const QUALIFIED = new RegExp(`^${IDENTIFIER}(\\.${IDENTIFIER})+(${CALL_SUFFIX})?$`);
// What an import of an extensionless specifier may land on, in the order a bundler tries.
const MODULE_SUFFIXES = ["ts", "tsx", "mts", "js", "jsx", "mjs", "cjs"].flatMap((extension) => [
  `.${extension}`,
  `/index.${extension}`,
]);
const CALL = new RegExp(`^${IDENTIFIER}${CALL_SUFFIX}$`);
// A dotted name ending in one of these is a file, not `Type.Member`: `Gateway_Guide_v3.pdf`.
const FILE_EXTENSIONS = new Set(
  (
    "pdf png jpg jpeg gif svg webp avif ico txt xml csv tsv xls xlsx doc docx ppt pptx zip gz tgz tar " +
    "log env lock dat bak db sqlite pem key crt p12 pfx woff woff2 ttf otf mp4 mov webm mp3 wav htm " +
    "ini cfg conf config plist bin exe dll so dylib map snap tfvars tfstate local example sample"
  ).split(" "),
);
const NAME = /[A-Za-z_$][\w$]*/g;
// What a declared class, interface, record or struct extends or implements.
const HERITAGE =
  /\b(?:class|interface|record(?:\s+(?:struct|class))?|struct)\s+([A-Za-z_$][\w$]*)(?:<[^>{]*>)?(?:\([^)]*\))?\s*(?::|extends|implements)\s*([^{;=]+)/g;
// A name a file declares: a type, namespace, function or binding keyword before it, or a key that
// opens an object type (`StorefrontProductDTO: {` in generated OpenAPI types).
const DECLARATION =
  /\b(?:class|interface|record(?:\s+(?:struct|class))?|struct|enum|type|namespace|module|function\*?|def|const|let|var)\s+([A-Za-z_$][\w$]*)|^\s*([A-Za-z_$][\w$]*)\??\s*:\s*\{/gm;
const STOPWORDS = new Set(
  "the and for its are was not but with from into that this than then them they our one all any can each has had have who why how what when where which while".split(
    " ",
  ),
);

function extensionOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function languageOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return LANGUAGE_OF.get(/^Dockerfile(\.|$)/.test(base) ? "sh" : extensionOf(path));
}

function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      source += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function exemptMatcher(entries) {
  const tests = entries.map((raw) => {
    const include = raw.startsWith("!");
    const entry = include ? raw.slice(1) : raw;
    if (/[*?]/.test(entry)) {
      const pattern = globToRegExp(entry.endsWith("/") ? `${entry}**` : entry);
      return { include, test: (path) => pattern.test(path) };
    }
    const prefix = entry.endsWith("/") ? entry : `${entry}/`;
    return { include, test: (path) => path === entry || path.startsWith(prefix) };
  });
  return (path) => {
    let exempt = false;
    for (const { include, test } of tests) if (test(path)) exempt = !include;
    return exempt;
  };
}

// JSON plus `//` and `/* */` comments and trailing commas, the way editors read a `.jsonc` file.
function parseJsonc(text) {
  let json = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const end = skipString(text, i, '"');
      json += text.slice(i, end);
      i = end - 1;
    } else if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
      json += "\n";
    } else if (text.startsWith("/*", i)) {
      i = text.indexOf("*/", i + 2) + 1 || text.length;
    } else json += text[i];
  }
  return JSON.parse(json.replace(/,(\s*[}\]])/g, "$1"));
}

function words(text) {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
}

// One checkout: its files, and the indexes a pointer resolves against, built on first use.
class Repo {
  constructor(root) {
    this.root = root;
    this.config = Repo.readConfig(root);
    const { files, linked } = Repo.listFiles(root);
    // `scanned` are real files; `files` adds the paths that reach a file through a symlinked
    // directory, which resolve but are never scanned twice.
    this.scanned = files;
    this.files = [...files, ...linked];
    this.fileSet = new Set(this.files);
    this.dirSet = new Set();
    this.byBase = new Map();
    this.dirsByBase = new Map();
    for (const file of this.files) {
      const segments = file.split("/");
      push(this.byBase, segments.at(-1), file);
      for (let i = 1; i < segments.length; i++) {
        const dir = segments.slice(0, i).join("/");
        if (!this.dirSet.has(dir)) {
          this.dirSet.add(dir);
          push(this.dirsByBase, segments[i - 1], dir);
        }
      }
    }
    this.topLevel = new Set(this.files.map((file) => file.split("/")[0]));
    this.siblings = new Map();
  }

  static readConfig(root) {
    const path = join(root, ".pointer-check.jsonc");
    if (!existsSync(path)) return { exempt: [], siblings: {}, self: [] };
    const config = parseJsonc(readFileSync(path, "utf8"));
    return { exempt: config.exempt ?? [], siblings: config.siblings ?? {}, self: config.self ?? [] };
  }

  // Tracked plus untracked-and-unignored, so a file written this session can be pointed at before
  // it is staged; minus anything deleted from the working tree. A tracked symlink to a directory
  // in the repo contributes the files under its target at its own path, since that path works.
  static listFiles(root) {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const listed = [...new Set(out.split("\0").filter(Boolean))];
    const files = [];
    const links = [];
    for (const file of listed) {
      let stat;
      try {
        stat = lstatSync(join(root, file));
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) links.push(file);
      else if (stat.isFile()) files.push(file);
    }
    const real = new Set(files);
    const linked = [];
    for (const link of links) {
      const target = readlinkSync(join(root, link));
      if (isAbsolute(target)) continue;
      const targetPath = posix.normalize(posix.join(posix.dirname(link), target.split(sep).join("/")));
      if (targetPath.startsWith("..")) continue;
      for (const file of real) {
        if (file.startsWith(`${targetPath}/`)) linked.push(`${link}${file.slice(targetPath.length)}`);
      }
    }
    return { files, linked };
  }

  sibling(name) {
    if (!Object.hasOwn(this.config.siblings, name)) return undefined;
    if (!this.siblings.has(name)) {
      const paths = [this.config.siblings[name]].flat();
      const found = paths.map((path) => resolve(this.root, path)).find((path) => existsSync(join(path, ".git")));
      this.siblings.set(name, found ? new Repo(found) : null);
    }
    return this.siblings.get(name);
  }

  siblingNames() {
    return Object.keys(this.config.siblings);
  }

  // Counts what a path pointer lands on: an exact root-relative path wins outright; otherwise
  // every file or directory the path is a segment-aligned suffix of.
  resolvePath(path) {
    if (this.hasExact(path)) return 1;
    const clean = path.replace(/\/+$/, "");
    const base = clean.slice(clean.lastIndexOf("/") + 1);
    const suffix = `/${clean}`;
    const files = (this.byBase.get(base) ?? []).filter((file) => file.endsWith(suffix));
    const dirs = (this.dirsByBase.get(base) ?? []).filter((dir) => dir.endsWith(suffix));
    return files.length + dirs.length;
  }

  // An exact root-relative file or directory, or, for an extensionless module specifier, the file
  // an import of it lands on.
  hasExact(path) {
    const clean = path.replace(/\/+$/, "");
    if (clean === "" || this.fileSet.has(clean) || this.dirSet.has(clean)) return true;
    if (extensionOf(clean) || path.endsWith("/")) return false;
    return MODULE_SUFFIXES.some((suffix) => this.fileSet.has(`${clean}${suffix}`));
  }

  hasBaseName(name) {
    return this.byBase.has(name) || this.dirsByBase.has(name);
  }

  // Per code file, the names its code uses (with comments and strings blanked, and, separately,
  // with strings kept), the types it declares and what each of them extends. A name only a
  // comment, a log message or a migration's column string still mentions is gone from code, which
  // is how a rename is caught.
  get names() {
    if (!this._names) {
      const code = [];
      const all = [];
      const declares = new Map();
      const bases = new Map();
      this.scanned.forEach((file) => {
        const language = languageOf(file);
        if (!language?.names) return;
        const text = readText(join(this.root, file));
        if (text === undefined) return;
        const scanned = language.scan(text);
        const index = code.length;
        code.push(new Set(scanned.code.match(NAME) ?? []));
        all.push(new Set(scanned.withStrings.match(NAME) ?? []));
        for (const match of scanned.code.matchAll(DECLARATION)) push(declares, match[1] ?? match[2], index);
        for (const match of scanned.code.matchAll(HERITAGE)) {
          for (const base of match[2].split(/,|\bextends\b|\bimplements\b/)) {
            const name = base.trim().match(/^[A-Za-z_$][\w$]*/)?.[0];
            if (name) push(bases, match[1], name);
          }
        }
      });
      this._names = { code, all, declares, bases };
    }
    return this._names;
  }

  // `Type.member`: true when a file declaring the type, or one of ours it extends, uses the member;
  // undefined when the type is not ours at all. A type extending one we do not declare (Spiderly's
  // `BusinessObject<long>`) may inherit the member from it, so there it is enough that our code
  // uses the type and the member together somewhere.
  memberOf(type, member, depth = 0) {
    const { code, declares, bases } = this.names;
    const files = declares.get(type);
    if (!files) return undefined;
    if (files.some((file) => code[file].has(member))) return true;
    let outside = false;
    for (const base of depth < 5 ? (bases.get(type) ?? []) : []) {
      const found = this.memberOf(base, member, depth + 1);
      if (found) return true;
      if (found === undefined) outside = true;
    }
    return outside && usedTogether(code, [type, member]);
  }

  // Only the head and its first member are checked: `Category.Products.Any()` goes on into a
  // library's API, which no declaration of ours can vouch for.
  resolveSymbol(text) {
    const [head, member] = text.replace(/\(.*\)$/, "").split(".");
    const { all, declares } = this.names;
    if (!member) return Number(declares.has(head) || usedTogether(all, [head]));
    const ours = this.memberOf(head, member);
    // A library's type (`DateTime.UtcNow`, `JSON.parse`) needs only its names used together.
    return Number(ours ?? usedTogether(all, [head, member]));
  }

  get adrs() {
    if (!this._adrs) {
      this._adrs = new Map();
      for (const file of this.files) {
        const match = /^docs\/adr\/(\d{4})-(.+)\.md$/.exec(file);
        if (match) push(this._adrs, match[1], { file, words: new Set(words(match[2])) });
      }
    }
    return this._adrs;
  }

  // Two ADRs may share a number (ADRs are immutable, so it is never fixed by renumbering); the
  // words around the mention then have to pick one: at least two words of its title that the
  // other titles do not have, and more of them than any other candidate.
  resolveAdr(number, context) {
    const candidates = this.adrs.get(number) ?? [];
    if (candidates.length <= 1) return candidates.length;
    const said = new Set(words(context));
    const scores = candidates.map((candidate) => {
      let score = 0;
      for (const word of candidate.words) {
        if (!said.has(word)) continue;
        if (candidates.every((other) => other === candidate || !other.words.has(word))) score++;
      }
      return score;
    });
    const best = Math.max(...scores);
    return best >= 2 && scores.filter((score) => score === best).length === 1 ? 1 : candidates.length;
  }
}

function usedTogether(files, names) {
  return files.some((tokens) => names.every((name) => tokens.has(name)));
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function readText(path) {
  try {
    if (statSync(path).size > 8 * 1024 * 1024) return undefined;
    const text = readFileSync(path, "utf8");
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}

// Each scanner splits a code file into its comments, one entry per line a comment touches, and
// its code with every comment and string literal blanked. They are approximate on purpose: a
// mis-scanned line costs a missed pointer at worst.

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function collect(text, ranges, strings = []) {
  const starts = lineStarts(text);
  const comments = [];
  let code = "";
  let last = 0;
  let withStrings = "";
  let lastComment = 0;
  for (const [from, to] of ranges) {
    withStrings += text.slice(lastComment, from) + text.slice(from, to).replace(/[^\n]/g, " ");
    lastComment = to;
  }
  withStrings += text.slice(lastComment);
  const blanked = [...ranges.map((range) => [...range, true]), ...strings].sort((a, b) => a[0] - b[0]);
  for (const [from, to, comment] of blanked) {
    code += text.slice(last, from) + text.slice(from, to).replace(/[^\n]/g, " ");
    last = to;
    if (!comment) continue;
    let line = upperBound(starts, from) - 1;
    let cursor = from;
    while (cursor < to) {
      const lineEnd = Math.min(to, line + 1 < starts.length ? starts[line + 1] - 1 : text.length);
      comments.push({ line: line + 1, text: text.slice(cursor, lineEnd) });
      line++;
      cursor = lineEnd + 1;
    }
  }
  code += text.slice(last);
  return { comments, code, withStrings };
}

function upperBound(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

const REGEX_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">"]);

function scanC(text, { slash, hash, dashes }) {
  const ranges = [];
  const strings = [];
  let i = 0;
  let previous = "";
  const templateDepth = [];
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (templateDepth.length && char === "}" && templateDepth.at(-1) === 0) {
      templateDepth.pop();
      const end = skipTemplate(text, i + 1, templateDepth);
      strings.push([i, end]);
      i = end;
      previous = "`";
      continue;
    }
    if (templateDepth.length && char === "{") templateDepth[templateDepth.length - 1]++;
    if (templateDepth.length && char === "}") templateDepth[templateDepth.length - 1]--;
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const to = end === -1 ? text.length : end + 2;
      ranges.push([i, to]);
      i = to;
      continue;
    }
    if ((slash && char === "/" && next === "/") || (hash && char === "#") || (dashes && char === "-" && next === "-")) {
      const end = text.indexOf("\n", i);
      const to = end === -1 ? text.length : end;
      ranges.push([i, to]);
      i = to;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = skipString(text, i, char);
      strings.push([i, end]);
      i = end;
      previous = char;
      continue;
    }
    if (char === "`" && slash) {
      const end = skipTemplate(text, i + 1, templateDepth);
      strings.push([i, end]);
      i = end;
      previous = "`";
      continue;
    }
    if (char === "/" && slash && (previous === "" || REGEX_BEFORE.has(previous) || /\breturn$/.test(text.slice(Math.max(0, i - 8), i).trimEnd()))) {
      const end = skipRegex(text, i);
      if (end > i + 1) strings.push([i, end]);
      i = end;
      previous = "/";
      continue;
    }
    if (!/\s/.test(char)) previous = char;
    i++;
  }
  return collect(text, ranges, strings);
}

function skipString(text, start, quote) {
  let i = start + 1;
  while (i < text.length && text[i] !== quote && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

// Returns the index after the closing backtick, or the index after `${` with a new depth pushed,
// so the caller scans the interpolation as code.
function skipTemplate(text, start, depth) {
  let i = start;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === "`") return i + 1;
    else if (text[i] === "$" && text[i + 1] === "{") {
      depth.push(0);
      return i + 2;
    } else i++;
  }
  return i;
}

function skipRegex(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length && text[i] !== "\n") {
    if (text[i] === "\\") i += 2;
    else if (text[i] === "[") inClass = true, i++;
    else if (text[i] === "]") inClass = false, i++;
    else if (text[i] === "/" && !inClass) return i + 1;
    else i++;
  }
  return start + 1;
}

// `#` starts a comment at the start of a line or after whitespace, outside a quoted string. A
// quote opens a string only where a value can start, so the apostrophe in `don't` does not.
function scanHash(text, { python }) {
  const ranges = [];
  const strings = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (python && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const close = text.indexOf(text.slice(i, i + 3), i + 3);
      const end = close === -1 ? text.length : close + 3;
      strings.push([i, end]);
      i = end;
      continue;
    }
    const before = i === 0 ? "\n" : text[i - 1];
    if (char === "#" && /\s/.test(before)) {
      const end = text.indexOf("\n", i);
      const to = end === -1 ? text.length : end;
      ranges.push([i, to]);
      i = to;
      continue;
    }
    if ((char === '"' || char === "'") && (python || /[\s:=([{,]/.test(before))) {
      const end = skipString(text, i, char);
      strings.push([i, end]);
      i = end;
      continue;
    }
    i++;
  }
  return collect(text, ranges, strings);
}

function scanMarkup(text) {
  const ranges = [];
  let at = text.indexOf("<!--");
  while (at !== -1) {
    const end = text.indexOf("-->", at + 4);
    const to = end === -1 ? text.length : end + 3;
    ranges.push([at, to]);
    at = text.indexOf("<!--", to);
  }
  return collect(text, ranges);
}

// Markdown prose, one entry per line, without fenced code blocks: a fence holds commands and
// sample code, where a path is an argument, not a claim about the tree.
function markdownLines(text) {
  const lines = [];
  let fence = null;
  text.split("\n").forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return;
    }
    if (marker) {
      fence = marker[1];
      return;
    }
    lines.push({ line: index + 1, text: line });
  });
  return lines;
}

const SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;

// Every pointer in one line of prose, as { column, display, resolve } where resolve() returns how
// many targets the pointer lands on, or undefined when it cannot be checked here.
function pointersIn(text, { repo, file, kind }) {
  const pointers = [];
  const masked = text.replace(SPAN, (span) => " ".repeat(span.length));
  const siblingPrefix = siblingPrefixPattern(repo);

  for (const match of text.matchAll(SPAN)) {
    const content = match[2].trim();
    const before = text.slice(0, match.index);
    const named = siblingPrefix && siblingPrefix.exec(before)?.[1];
    const prefix = repo.config.self.includes(named) ? undefined : named;
    const afterSee = kind === "comment" && /\bsee\s+$/i.test(before);
    const pointer = classify(content, { repo, file, prefix, bareSymbols: afterSee });
    if (pointer) pointers.push({ column: match.index, ...pointer });
    else if (/^ADRs? ?-?\d{4}$/.test(content)) {
      const number = content.match(/\d{4}/)[0];
      pointers.push(adrPointer({ repo, prefix, number, display: shown(prefix, content), context: text, column: match.index }));
    }
  }

  if (kind === "markdown") {
    const links = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|^\s*\[(?!\^)[^\]]+\]:\s*(\S+)/g;
    for (const match of masked.matchAll(links)) {
      const target = text.slice(match.index, match.index + match[0].length).match(/\]\(([^)\s]+)|\]:\s*(\S+)/);
      const raw = (target[1] ?? target[2]).replace(/^<|>$/g, "");
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") || raw.startsWith("/")) continue;
      const path = decodeURIComponentSafe(raw.replace(/[#?].*$/, ""));
      if (!path) continue;
      pointers.push({ column: match.index, ...relativePointer(path, { repo, file }) });
    }
  }

  const adrMentions = /(?:([\w.-]+?)(?:'s)?\s+)?\bADRs?[- ]?(\d{4})(?![-\d])((?:\s*(?:,|and|&|or|\/)\s*\d{4}(?![-\d]))*)/g;
  for (const match of masked.matchAll(adrMentions)) {
    const prefix = match[1] && repo.siblingNames().includes(match[1]) ? match[1] : undefined;
    const numbers = [match[2], ...(match[3].match(/\d{4}/g) ?? [])];
    const start = match.index + (match[1] ? match[0].indexOf("ADR") : 0);
    const context = text.slice(Math.max(0, start - 100), start + match[0].length + 160);
    for (const number of numbers) {
      const display = numbers.length === 1 ? match[0].slice(match[0].indexOf("ADR")) : `ADR ${number}`;
      pointers.push(adrPointer({ repo, prefix, number, display: shown(prefix, display), context, column: start }));
    }
  }

  if (kind === "comment") {
    for (const match of masked.matchAll(/\bsee\s+(?:also\s+)?([^\s`'",;]+)/gi)) {
      const token = match[1].replace(/[.,;:)\]]+$/, "");
      const pointer = classify(token, { repo, file, bareSymbols: true });
      if (pointer) pointers.push({ column: match.index, ...pointer });
    }
  }

  return pointers;
}

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function siblingPrefixPattern(repo) {
  const names = [...repo.siblingNames(), ...repo.config.self];
  if (names.length === 0) return undefined;
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|");
  return new RegExp(`(?:^|[\\s(\\[*_"'])(${alternatives})(?:'s)?:?\\s+$`);
}

// The checkout a pointer resolves in: this repo, or the sibling its prefix names (undefined when
// that sibling is not checked out, and then the pointer is skipped).
function ownerOf(repo, prefix) {
  return prefix ? repo.sibling(prefix) : repo;
}

function shown(prefix, text) {
  return prefix ? `${prefix} ${text}` : text;
}

function adrPointer({ repo, prefix, number, display, context, column }) {
  return {
    column,
    display,
    resolve: () => ownerOf(repo, prefix)?.resolveAdr(number, context),
  };
}

// What a backticked span or a `see` target is: a path, a symbol, or not a pointer at all.
function classify(content, { repo, file, prefix, bareSymbols }) {
  const path = pathPointer(content, { repo, file, prefix });
  if (path) return path;
  const symbol = content.trim();
  // `vercel.deployment.ready` and `local.kupac.svi` are an outside system's dotted names; ours
  // start with a type, so a lowercase head is a symbol only where a comment says `see` before it.
  const qualified = QUALIFIED.test(symbol) && (bareSymbols || /^[A-Z]/.test(symbol));
  const shape = qualified || CALL.test(symbol) || (bareSymbols && codeShaped(symbol));
  // `EXTRA.CARDBRAND` is a wire field of an outside system, not a type and member of ours.
  if (/^[A-Z0-9_]+(\.[A-Z0-9_]+)+$/.test(symbol)) return undefined;
  if (!shape || DOMAIN.test(symbol) || FILE_EXTENSIONS.has(extensionOf(symbol.replace(/\(.*$/, "")))) return undefined;
  return { display: shown(prefix, symbol), resolve: () => ownerOf(repo, prefix)?.resolveSymbol(symbol) };
}

// A lone word after `see` is a symbol only when it is shaped like code, not like English or a
// brand: a camelCase hump, an inner underscore, or PascalCase with a hump.
function codeShaped(word) {
  if (!new RegExp(`^${IDENTIFIER}$`).test(word)) return false;
  return /^[a-z_$][\w$]*[a-z0-9][A-Z]/.test(word) || /\w_\w/.test(word) || /^[A-Z][a-z0-9]+[A-Z]/.test(word);
}

function pathPointer(content, { repo, file, prefix }) {
  let path = content.replace(/#.*$/, "").replace(/:\d+(-\d+)?$/, "");
  const own = repo.config.self.find((name) => path.startsWith(`${name}/`));
  if (own && !prefix) path = path.slice(own.length + 1);
  if (path.startsWith("./") || path.startsWith("../")) {
    if (!PATH_CHARS.test(path)) return undefined;
    return relativePointer(path, { repo, file });
  }
  if (!PATH_CHARS.test(path) || /^[@/~-]/.test(path) || path.includes("//")) return undefined;
  const extension = extensionOf(path);
  const hasSlash = path.includes("/");
  if (!hasSlash) {
    if (!SOURCE_EXTENSIONS.has(extension) || DOMAIN.test(path)) return undefined;
    // A bare file name names a kind of file as often as one file ("each repo's `CLAUDE.md`"),
    // so it fails only when no file has that name at all.
    return {
      display: shown(prefix, path),
      resolve: () => {
        const owner = ownerOf(repo, prefix);
        return owner ? Number(owner.hasBaseName(path)) : undefined;
      },
      ignorable: () => ({ owner: ownerOf(repo, prefix), path }),
    };
  }
  const first = path.split("/")[0];
  const adr = /(?:^|\/)docs\/adr\/(\d{4})\/?$/.exec(path);
  if (adr) {
    const sibling = !prefix && repo.siblingNames().includes(first) ? first : prefix;
    return adrPointer({ repo, prefix: sibling, number: adr[1], display: shown(prefix, path), context: content, column: 0 });
  }
  if (!prefix && repo.siblingNames().includes(first)) {
    const rest = path.slice(first.length + 1);
    return {
      display: path,
      resolve: () => {
        const sibling = repo.sibling(first);
        return sibling && rest ? sibling.resolvePath(rest) : undefined;
      },
      ignorable: () => ({ owner: repo.sibling(first), path: rest }),
    };
  }
  if (DOMAIN.test(first)) return undefined;
  if (!SOURCE_EXTENSIONS.has(extension)) {
    // Without a source extension, `origin/master` and `next/cache` look like paths; only one that
    // starts at a real top-level entry is one. The cost: a pointer under a top-level directory
    // deleted whole goes unchecked; one under a deleted subtree (`docs/decisions/x/`) is caught.
    const owner = ownerOf(repo, prefix);
    if (owner && !owner.topLevel.has(first)) return undefined;
  }
  return {
    display: shown(prefix, path),
    resolve: () => ownerOf(repo, prefix)?.resolvePath(path),
    ignorable: () => ({ owner: ownerOf(repo, prefix), path }),
  };
}

// A path relative to the file holding it, as a Markdown link is. It may climb into a sibling
// checkout; it is skipped when it climbs anywhere this run cannot see.
function relativePointer(path, { repo, file }) {
  const located = () => {
    const absolute = resolve(repo.root, dirname(file), path);
    const inside = relative(repo.root, absolute).split(sep).join("/");
    if (!inside.startsWith("..") && !isAbsolute(inside)) {
      const first = inside.split("/")[0];
      if (repo.siblingNames().includes(first) && !repo.topLevel.has(first)) {
        return { owner: repo.sibling(first), path: inside.slice(first.length + 1) };
      }
      return { owner: repo, path: path.endsWith("/") && inside ? `${inside}/` : inside };
    }
    for (const name of repo.siblingNames()) {
      const sibling = repo.sibling(name);
      if (!sibling) continue;
      const within = relative(sibling.root, absolute).split(sep).join("/");
      if (!within.startsWith("..") && !isAbsolute(within)) return { owner: sibling, path: within };
    }
    return { owner: undefined, path: inside };
  };
  return {
    display: path,
    resolve: () => {
      const { owner, path: within } = located();
      return owner ? Number(owner.hasExact(within)) : undefined;
    },
    ignorable: located,
  };
}

function prose(repo, file) {
  const extension = extensionOf(file);
  const text = readText(join(repo.root, file));
  if (text === undefined) return [];
  if (SNAPSHOT_HEADER.test(text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n")))) return [];
  if (MARKDOWN_EXTENSIONS.has(extension)) return markdownLines(text).map((line) => ({ ...line, kind: "markdown" }));
  const language = languageOf(file);
  if (!language) return [];
  return language.scan(text).comments.map((line) => ({ ...line, kind: "comment" }));
}

function check(root, { only = [] } = {}) {
  const repo = new Repo(root);
  const exempt = exemptMatcher([...DEFAULT_EXEMPT, ...repo.config.exempt]);
  const selected = (file) =>
    only.length === 0 || only.some((path) => file === path || file.startsWith(path.endsWith("/") ? path : `${path}/`));
  const failures = [];
  let pointerCount = 0;
  let fileCount = 0;
  for (const file of repo.scanned) {
    if (exempt(file) || !selected(file)) continue;
    const lines = prose(repo, file);
    if (lines.length === 0) continue;
    fileCount++;
    for (const { line, text, kind } of lines) {
      for (const pointer of pointersIn(text, { repo, file, kind })) {
        const targets = pointer.resolve();
        if (targets === undefined) continue;
        pointerCount++;
        if (targets === 1) continue;
        failures.push({
          file,
          line,
          column: pointer.column,
          ignorable: targets === 0 ? pointer.ignorable?.() : undefined,
          message: `\`${pointer.display}\` ${targets === 0 ? "resolves to nothing" : `resolves to ${targets} targets`}`,
        });
      }
    }
  }
  dropIgnored(failures);
  failures.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column));
  return { failures, pointerCount, fileCount };
}

// A path the repo's ignore rules match names a file that is untracked on purpose (a local secrets
// file, build output), so it is not a pointer that went stale. The rules are tracked, which keeps
// this the same in CI as on a laptop where the file happens to exist.
function dropIgnored(failures) {
  const byOwner = new Map();
  for (const failure of failures) {
    const target = failure.ignorable;
    if (!target?.owner || !target.path || target.path.startsWith("..")) continue;
    push(byOwner, target.owner, target.path);
  }
  const ignored = new Set();
  for (const [owner, paths] of byOwner) {
    const run = spawnSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
      cwd: owner.root,
      input: `${paths.join("\0")}\0`,
      encoding: "utf8",
    });
    for (const path of run.stdout.split("\0").filter(Boolean)) ignored.add(`${owner.root}\0${path}`);
  }
  for (let i = failures.length - 1; i >= 0; i--) {
    const target = failures[i].ignorable;
    if (target?.owner && ignored.has(`${target.owner.root}\0${target.path}`)) failures.splice(i, 1);
  }
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function main(argv) {
  let root;
  let reportOnly = false;
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report-only") reportOnly = true;
    else if (argv[i] === "--root") root = argv[++i];
    else if (argv[i].startsWith("--")) {
      process.stderr.write(`pointer-check: unknown option ${argv[i]}\n`);
      return 2;
    } else only.push(argv[i].replace(/^\.\//, ""));
  }
  root = resolve(root ?? execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  const { failures, pointerCount, fileCount } = check(root, { only });
  for (const failure of failures) process.stdout.write(`${failure.file}:${failure.line}: ${failure.message}\n`);
  const failingFiles = new Set(failures.map((failure) => failure.file)).size;
  process.stdout.write(
    failures.length === 0
      ? `pointer-check: no failing pointers (${plural(pointerCount, "pointer")} checked in ${plural(fileCount, "file")})\n`
      : `pointer-check: ${plural(failures.length, "failing pointer")} in ${plural(failingFiles, "file")}${reportOnly ? " (report only)" : ""}\n`,
  );
  return failures.length > 0 && !reportOnly ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
