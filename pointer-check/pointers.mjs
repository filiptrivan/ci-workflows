// Every pointer in one line of prose, by its form: a file path, a symbol, an ADR number, a heading
// (headings.mjs), any of these behind a sibling repo's name, and a file and a name
// (file-and-name.mjs). Each pointer carries its resolve(), which the run calls (check.mjs).

import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileAndNamePointers } from "./file-and-name.mjs";
import { headingPointerAfter } from "./headings.mjs";
import { DECLARATION } from "./repo.mjs";
import { extensionOf, IDENTIFIER, languageOf, maskSpans, SPAN } from "./scan.mjs";

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

const PATH_CHARS = /^[A-Za-z0-9_.\-/[\]()+@~]+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(rs|ba|com|net|org|io|dev|app|me|co|ai|sh|eu|de|uk|in)$/;

// A call is `name()` or `name("literal")`: an identifier argument (`chore(deps)`) or a number
// (`oklch(0.5 0 0)`) is code being quoted, not a name being pointed at.
const CALL_SUFFIX = `\\((?:"[^"]*"|'[^']*')?\\)`;
const QUALIFIED = new RegExp(`^${IDENTIFIER}(\\.${IDENTIFIER})+(${CALL_SUFFIX})?$`);
const CALL = new RegExp(`^${IDENTIFIER}${CALL_SUFFIX}$`);
// A dotted name ending in one of these is a file, not `Type.Member`: `Gateway_Guide_v3.pdf`.
const FILE_EXTENSIONS = new Set(
  (
    "pdf png jpg jpeg gif svg webp avif ico txt xml csv tsv xls xlsx doc docx ppt pptx zip gz tgz tar " +
    "log env lock dat bak db sqlite pem key crt p12 pfx woff woff2 ttf otf mp4 mov webm mp3 wav htm " +
    "ini cfg conf config plist bin exe dll so dylib map snap tfvars tfstate local example sample"
  ).split(" "),
);

// A comment line's decoration (` * `, `// `, `# `), which is not text of the prose it carries.
const DECORATION = /^[\s*#/]*/;

// Every pointer in one line of prose, as { column, display, resolve } where resolve() returns how
// many targets the pointer lands on, or undefined when it cannot be checked here; a path pointer
// also carries located(), the checkout and path it names, a heading pointer `heading: true`, and an
// unquoted heading `refusal`, its message.
// `previous` and `next` are the prose lines around this one: wrapped prose leaves a repo's name at
// the end of one line and its pointer at the start of the next, or a heading pointer's arrow or
// quoted text on the next.
export function pointersIn(text, { repo, file, kind, previous = "", next = "" }) {
  const pointers = [];
  const masked = maskSpans(text);
  const siblingPrefix = siblingPrefixPattern(repo);
  // Markdown has no decoration: a wrapped line may open with text's own `/` or `#`.
  const wrapped = `${text} ${kind === "comment" ? next.replace(DECORATION, "") : next}`;

  for (const match of text.matchAll(SPAN)) {
    const content = match[2].trim();
    const before = text.slice(0, match.index);
    const prefix = prefixBefore(before, previous, repo, siblingPrefix);
    const afterSee = kind === "comment" && /\bsee\s+$/i.test(before);
    const pointer = classify(content, { repo, file, prefix, bareSymbols: afterSee });
    if (pointer) {
      pointers.push({ column: match.index, ...pointer });
      const after = wrapped.slice(match.index + match[0].length);
      const heading = headingPointerAfter(pointer, match[0], after, { repo, file });
      if (heading) pointers.push({ column: match.index, ...heading });
    } else if (/^ADRs? ?-?\d{4}$/.test(content)) {
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

  const adrMentions = /\bADRs?[- ]?(\d{4})(?![-\d])((?:\s*(?:,|and|&|or|\/)\s*\d{4}(?![-\d]))*)/g;
  for (const match of masked.matchAll(adrMentions)) {
    const start = match.index;
    const prefix = prefixBefore(text.slice(0, start), previous, repo, siblingPrefix);
    const numbers = [match[1], ...(match[2].match(/\d{4}/g) ?? [])];
    const context = text.slice(Math.max(0, start - 100), start + match[0].length + 160);
    for (const number of numbers) {
      const display = numbers.length === 1 ? match[0] : `ADR ${number}`;
      pointers.push(adrPointer({ repo, prefix, number, display: shown(prefix, display), context, column: start }));
    }
  }

  if (kind === "comment") {
    for (const match of masked.matchAll(/\bsee\s+(?:also\s+)?([^\s`'",;]+)/gi)) {
      const pointer = classify(trimSeeTarget(match[1]), { repo, file, bareSymbols: true });
      if (pointer) pointers.push({ column: match.index, ...pointer });
    }
  }

  pointers.push(...fileAndNamePointers(wrapped, text.length, { previous, repo, file, languageOf, declaration: DECLARATION }));
  return pointers;
}

// Sentence punctuation after a `see` target goes; the `()` of a call stays.
function trimSeeTarget(raw) {
  let token = raw;
  for (;;) {
    const trimmed = token.replace(/[.,;:\]]+$/, "");
    const unbalanced = trimmed.endsWith(")") && trimmed.split("(").length < trimmed.split(")").length;
    token = unbalanced ? trimmed.slice(0, -1) : trimmed;
    if (token === trimmed) return token;
  }
}

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// The sibling a repo name just before a pointer names, on its line or, when the pointer opens the
// line, at the end of the previous one; undefined for no name or this repo's own. The name matches
// in any case, as a sentence opens on "Umbrella `GLOSSARY.md`", and is returned as configured.
function prefixBefore(before, previous, repo, pattern) {
  if (!pattern) return undefined;
  const lead = before.replace(DECORATION, "") === "" ? `${previous.trimEnd()} ` : before;
  const written = pattern.exec(lead)?.[1]?.toLowerCase();
  const named = repo.prefixNames().find((name) => name.toLowerCase() === written);
  return repo.config.self.includes(named) ? undefined : named;
}

function siblingPrefixPattern(repo) {
  const names = repo.prefixNames();
  if (names.length === 0) return undefined;
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|");
  return new RegExp(`(?:^|[\\s(\\[*_"'])(${alternatives})(?:'s)?:?\\s+$`, "i");
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
      located: () => ({ owner: ownerOf(repo, prefix), path }),
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
      located: () => ({ owner: repo.sibling(first), path: rest }),
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
    located: () => ({ owner: ownerOf(repo, prefix), path }),
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
    located,
  };
}
