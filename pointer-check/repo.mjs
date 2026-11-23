// One checkout: its files, its settings, its sibling checkouts, and the indexes a pointer resolves
// against (paths, headings, the names code declares and uses, ADR numbers), each built on first use.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import { headingTargetsIn } from "./headings.mjs";
import { extensionOf, IDENTIFIER, languageOf, readText, skipString } from "./scan.mjs";

// What an import of an extensionless specifier may land on, in the order a bundler tries.
export const MODULE_SUFFIXES = ["ts", "tsx", "mts", "js", "jsx", "mjs", "cjs"].flatMap((extension) => [
  `.${extension}`,
  `/index.${extension}`,
]);

const NAME = new RegExp(IDENTIFIER, "g");
const TYPE_KEYWORD = "(?:class|interface|record(?:\\s+(?:struct|class))?|struct)";
// What a declared class, interface, record or struct extends or implements.
const HERITAGE = new RegExp(
  `\\b${TYPE_KEYWORD}\\s+(${IDENTIFIER})(?:<[^>{]*>)?(?:\\([^)]*\\))?\\s*(?::|extends|implements)\\s*([^{;=]+)`,
  "g",
);
// A name a file declares: a type, namespace, function or binding keyword before it, or a key that
// opens an object type (`StorefrontProductDTO: {` in generated OpenAPI types).
export const DECLARATION =new RegExp(
  `\\b(?:${TYPE_KEYWORD}|enum|type|namespace|module|function\\*?|def|const|let|var)\\s+(${IDENTIFIER})|^\\s*(${IDENTIFIER})\\??\\s*:\\s*\\{`,
  "gm",
);
// A C# partial type: a source generator may add members in a part no tracked file holds.
const PARTIAL = new RegExp(`\\bpartial\\s+${TYPE_KEYWORD}\\s+(${IDENTIFIER})`, "g");
const MAX_HERITAGE_DEPTH = 5;
const STOPWORDS = new Set(
  "the and for its are was not but with from into that this than then them they our one all any can each has had have who why how what when where which while".split(
    " ",
  ),
);

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

// One checkout, and what a pointer resolves against in it.
export class Repo {
  constructor(root, siblingsBeside = root) {
    this.root = root;
    this.siblingsBeside = siblingsBeside;
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
    this.headingTargetsByFile = new Map();
  }

  static readConfig(root) {
    const path = join(root, ".pointer-check.jsonc");
    if (!existsSync(path)) return { exempt: [], siblings: {}, self: [] };
    const config = parseJsonc(readFileSync(path, "utf8"));
    return {
      exempt: config.exempt ?? [],
      siblings: config.siblings ?? {},
      self: config.self ?? [],
      historyLint: config.historyLint,
      failFileAndNamePointers: config.failFileAndNamePointers,
    };
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
      const found = paths.map((path) => resolve(this.siblingsBeside, path)).find((path) => existsSync(join(path, ".git")));
      this.siblings.set(name, found ? new Repo(found) : null);
    }
    return this.siblings.get(name);
  }

  siblingNames() {
    return Object.keys(this.config.siblings);
  }

  // Every name a prefix before a pointer may give: a sibling's, or this repo's own.
  prefixNames() {
    return [...this.siblingNames(), ...this.config.self];
  }

  resolvePath(path) {
    return this.pathTargets(path).length;
  }

  // What a path pointer lands on: an exact root-relative path (or the extensionless specifier an
  // import resolves) wins outright; otherwise every file or directory the path is a
  // segment-aligned suffix of.
  pathTargets(path) {
    const clean = path.replace(/\/+$/, "");
    if (this.hasExact(path)) return [clean];
    const base = clean.slice(clean.lastIndexOf("/") + 1);
    const suffix = `/${clean}`;
    const files = (this.byBase.get(base) ?? []).filter((file) => file.endsWith(suffix));
    const dirs = (this.dirsByBase.get(base) ?? []).filter((dir) => dir.endsWith(suffix));
    return [...files, ...dirs];
  }

  headingTargets(file) {
    if (!this.headingTargetsByFile.has(file)) {
      this.headingTargetsByFile.set(file, headingTargetsIn(readText(join(this.root, file)) ?? ""));
    }
    return this.headingTargetsByFile.get(file);
  }

  // An exact root-relative file or directory, or, for an extensionless module specifier, the file
  // an import of it lands on.
  hasExact(path) {
    const clean = path.replace(/\/+$/, "");
    if (clean === "" || this.fileSet.has(clean) || this.dirSet.has(clean)) return true;
    if (extensionOf(clean) || path.endsWith("/")) return false;
    return MODULE_SUFFIXES.some((suffix) => this.fileSet.has(`${clean}${suffix}`));
  }

  // A dot-led name with a second dot (`.spec.ts`) names a file-name suffix as often as a dotfile
  // (`.postcssrc.json`), so any file ending in it counts.
  hasBaseName(name) {
    if (this.byBase.has(name) || this.dirsByBase.has(name)) return true;
    if (!/^\.[^.]+\./.test(name)) return false;
    for (const base of this.byBase.keys()) if (base.endsWith(name)) return true;
    return false;
  }

  // Per code file, the names its code uses (with comments and strings blanked, and, separately,
  // with strings kept), the string literals that are exactly a name, the types it declares, which
  // of them are partial, and what each extends. A name only a comment, a log message or a
  // migration's column string still mentions is gone from code, which is how a rename is caught.
  get names() {
    if (!this._names) {
      const code = [];
      const withStrings = [];
      const literals = [];
      const declares = new Map();
      const partials = new Set();
      const bases = new Map();
      this.scanned.forEach((file) => {
        const language = languageOf(file);
        if (!language?.names) return;
        const text = readText(join(this.root, file));
        if (text === undefined) return;
        const scanned = language.scan(text);
        const index = code.length;
        code.push(new Set(scanned.code.match(NAME) ?? []));
        withStrings.push(new Set(scanned.withStrings.match(NAME) ?? []));
        literals.push(new Set(scanned.literals));
        for (const match of scanned.code.matchAll(DECLARATION)) push(declares, match[1] ?? match[2], index);
        for (const match of scanned.code.matchAll(PARTIAL)) partials.add(match[1]);
        for (const match of scanned.code.matchAll(HERITAGE)) {
          for (const base of match[2].split(/,|\bextends\b|\bimplements\b/)) {
            const name = base.trim().match(new RegExp(`^${IDENTIFIER}`))?.[0];
            if (name) push(bases, match[1], name);
          }
        }
      });
      this._names = { code, withStrings, literals, declares, partials, bases };
    }
    return this._names;
  }

  // `Type.member`: true when a file declaring the type, or one of ours it extends, uses the member;
  // undefined when the type is not ours at all. A type extending one we do not declare (Spiderly's
  // `BusinessObject<long>`), or a partial one, may get the member from code no tracked file holds,
  // so there it is enough that our code uses the type and the member together somewhere.
  memberOf(type, member, depth = 0) {
    const { code, declares, partials, bases } = this.names;
    const files = declares.get(type);
    if (!files) return undefined;
    if (files.some((file) => code[file].has(member))) return true;
    let unseen = partials.has(type);
    for (const base of depth < MAX_HERITAGE_DEPTH ? (bases.get(type) ?? []) : []) {
      const found = this.memberOf(base, member, depth + 1);
      if (found) return true;
      if (found === undefined) unseen = true;
    }
    return unseen && usedTogether(code, [type, member]);
  }

  // Only the head and its first member are checked: `Category.Products.Any()` goes on into a
  // library's API, which no declaration of ours can vouch for.
  resolveSymbol(text) {
    const [head, member] = text.replace(/\(.*\)$/, "").split(".");
    const { code, withStrings, literals, declares } = this.names;
    if (!member) return Number(declares.has(head) || usedTogether(code, [head]) || usedTogether(literals, [head]));
    return Number(this.memberOf(head, member) ?? usedTogether(withStrings, [head, member]));
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
