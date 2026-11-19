// The file-and-name pointer, the pointer check's sixth form: prose names a file and a name together,
// in one of two shapes, read from a comment or a Markdown paragraph and wrapped over two lines at most:
//
//   the file, then the backticked name    prepare.mjs `runPrePushChecks`, prepare.mjs's `terraform`,
//                                         `scripts/agent-box/whats-waiting.mjs` `MINE`
//   the backticked name, "in" or "at",    `variantPlaceholderByKind` in @pa/shared/dictionary/base.ts
//   then the file
//
// A split often keeps the old file as an entry that composes its parts, so the old path still
// resolves as a file pointer and only the name went stale. The name is judged by the file's own
// declarations and imports, never by a match anywhere in the tree: a detector that accepts a name
// found anywhere misses a name that moved while its old file stays (Ratol and Robillard, "Detecting
// fragile comments", ASE 2017, read the code's scope for this reason). In this order, code and
// strings counting and a comment never:
//
//   1. the file declares or exports the name, a re-export included: it resolves;
//   2. the file imports the name under that same name: it fails, naming the import's file, even when
//      the file also calls it (an aliased import, `{ a as b }`, imports neither name);
//   3. the file uses the name in its code or strings: it resolves;
//   4. exactly one other tracked code file declares the name: it fails, naming that file. None or
//      several: skipped, as a name many files declare (`args`, `at`) gives no home to name.
//      In JavaScript, TypeScript or an HTML page's script only an export or a top-level
//      declaration counts: a local `const at` or `args` inside a function is no home of a name
//      prose points at.
//
// Not a file-and-name pointer: an arrow between the two (`server.ts` → `cachedFetch` names a call
// path), "(" or "from" between them (a parameter's type, where a value comes from), and a pointer
// right after "out of" (a history note: "Moved out of prepare.mjs's `terraform` row").
//
// A failing one is printed and fails nothing, until the repo's `.pointer-check.jsonc` sets
// `"failFileAndNamePointers": true`: CI in every repo runs ci-workflows' main at once, so a default
// here would fail each repo before its own fixes are pushed.

import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const NAME_SPAN = new RegExp(`^(${IDENTIFIER})(?:\\(\\))?$`);
const NAME = new RegExp(IDENTIFIER, "g");
const SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
// A file as prose writes it bare: `@pa/shared/dictionary/base.ts`, `./read.mjs`, `prepare.mjs`.
const FILE = "(?:\\.{1,2}/)?[\\w@~-][\\w@~./-]*\\.[A-Za-z0-9]+";
const FILE_BEFORE = new RegExp(`(?:^|[\\s(\\[*_"'“])(${FILE})(?:['’]s)?\\s+$`);
const FILE_AFTER = new RegExp(`^\\s+(?:in|at)\\s+(${FILE})(?![\\w/@~-]|\\.\\w)`);
const BACKTICKED_FILE = new RegExp(`^${FILE}(?::\\d+(?:-\\d+)?)?$`);
const OUT_OF = /\bout of\s*$/i;
const MODULE_SUFFIXES = ["ts", "tsx", "mts", "js", "jsx", "mjs", "cjs"].flatMap((extension) => [
  `.${extension}`,
  `/index.${extension}`,
]);
const MAX_REEXPORT_DEPTH = 5;

// Every file-and-name pointer that starts within the first `length` characters of `wrapped`, the
// prose line joined with the line after it, so a wrapped pointer is read whole and reported once,
// at its first line. Each is a pointer as pointersIn returns it, whose resolve() also sets its
// `refusal`, the message a failure prints.
export function fileAndNamePointers(wrapped, length, { repo, file, languageOf, declaration }) {
  const spans = [...wrapped.matchAll(SPAN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    content: match[2].trim(),
  }));
  const pointers = [];
  spans.forEach((span, index) => {
    const name = NAME_SPAN.exec(span.content)?.[1];
    if (!name) return;
    const previous = spans[index - 1];
    const next = spans[index + 1];
    const found = fileBefore(wrapped, span, previous) ?? fileAfter(wrapped, span, next);
    if (!found || found.start >= length || OUT_OF.test(wrapped.slice(0, found.start))) return;
    pointers.push(pointer(found, name, { repo, file, languageOf, declaration }));
  });
  return pointers;
}

// `prepare.mjs `name``, `prepare.mjs's `name``, or a backticked file before the backticked name.
function fileBefore(wrapped, span, previous) {
  const gap = wrapped.slice(previous?.end ?? 0, span.start);
  if (previous && /^(?:['’]s)?\s+$/.test(gap) && BACKTICKED_FILE.test(previous.content)) {
    return { start: previous.start, path: previous.content, display: `\`${previous.content}\`` };
  }
  const bare = FILE_BEFORE.exec(gap);
  if (!bare) return undefined;
  const start = (previous?.end ?? 0) + bare.index + bare[0].indexOf(bare[1]);
  return { start, path: bare[1], display: bare[1] };
}

// `name` in <file>, or `name` at <file>, the file bare or backticked.
function fileAfter(wrapped, span, next) {
  const gap = wrapped.slice(span.end, next?.start ?? wrapped.length);
  if (next && /^\s+(?:in|at)\s+$/.test(gap) && BACKTICKED_FILE.test(next.content)) {
    return { start: span.start, path: next.content, display: `\`${next.content}\`` };
  }
  const bare = FILE_AFTER.exec(gap);
  return bare ? { start: span.start, path: bare[1], display: bare[1] } : undefined;
}

function pointer(found, name, { repo, file, languageOf, declaration }) {
  const display = `${found.display} \`${name}\``;
  const result = {
    column: found.start,
    display,
    reportOnly: repo.config.failFileAndNamePointers !== true,
    resolve: () => {
      const located = locate(found.path, { repo, file });
      if (!located || !languageOf(located.path)?.names) return undefined;
      const verdict = judge(located.owner, located.path, name, { languageOf, declaration });
      if (verdict?.message) result.refusal = `${display}: ${verdict.message}`;
      return verdict?.targets;
    },
  };
  return result;
}

// The checkout and path a written file lands on, or undefined when it lands on none for sure:
// a sibling's file is read in that sibling, a workspace package's name maps through its
// `package.json`, and a name several files share takes the one nearest the commenting file.
function locate(written, { repo, file }) {
  let path = written.replace(/:\d+(-\d+)?$/, "");
  const own = repo.config.self.find((name) => path.startsWith(`${name}/`));
  if (own) path = path.slice(own.length + 1);
  if (path.startsWith("./") || path.startsWith("../")) {
    const inside = posix.normalize(posix.join(posix.dirname(file), path));
    return repo.fileSet.has(inside) ? { owner: repo, path: inside } : undefined;
  }
  const first = path.split("/")[0];
  if (path.includes("/") && repo.siblingNames().includes(first)) {
    const sibling = repo.sibling(first);
    const found = sibling && candidates(sibling, path.slice(first.length + 1));
    return found?.length === 1 ? { owner: sibling, path: found[0] } : undefined;
  }
  const found = candidates(repo, path);
  if (found.length === 1) return { owner: repo, path: found[0] };
  const nearest = nearestOf(found, file);
  return nearest ? { owner: repo, path: nearest } : undefined;
}

function candidates(owner, path) {
  if (path.startsWith("@")) {
    const mapped = packagePath(owner, path);
    return mapped ? [mapped] : [];
  }
  if (owner.fileSet.has(path)) return [path];
  const base = path.slice(path.lastIndexOf("/") + 1);
  return (owner.byBase.get(base) ?? []).filter((candidate) => candidate.endsWith(`/${path}`));
}

// The commenting file's own folder first, then each parent in turn: the first that holds any match
// gives it when it holds exactly one, since every folder above holds that many or more.
function nearestOf(found, file) {
  if (found.length < 2) return undefined;
  for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
    const under = dir === "." ? found : found.filter((candidate) => candidate.startsWith(`${dir}/`));
    if (under.length > 0) return under.length === 1 ? under[0] : undefined;
    if (dir === ".") return undefined;
  }
}

// `@pa/shared/dictionary/base.ts`: the tracked `package.json` whose `name` opens the path, and the
// first tracked file its `"exports"` map gives the rest (`"./*": "./src/*"`), or the rest under the
// package itself when it has no map.
function packagePath(owner, path) {
  for (const manifest of packages(owner)) {
    if (!path.startsWith(`${manifest.name}/`)) continue;
    const subpath = `./${path.slice(manifest.name.length + 1)}`;
    const targets = manifest.exports === undefined ? [subpath] : exported(manifest.exports, subpath);
    return targets
      .map((target) => posix.normalize(posix.join(manifest.dir, target)))
      .find((mapped) => owner.fileSet.has(mapped));
  }
  return undefined;
}

const PACKAGES = new WeakMap();

function packages(owner) {
  if (!PACKAGES.has(owner)) {
    const found = [];
    for (const file of owner.files) {
      if (!/(?:^|\/)package\.json$/.test(file) || file.includes("node_modules/")) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(owner.root, file), "utf8"));
        if (typeof manifest.name === "string") {
          found.push({ name: manifest.name, dir: posix.dirname(file), exports: manifest.exports });
        }
      } catch {
        // A broken manifest names no package.
      }
    }
    PACKAGES.set(owner, found);
  }
  return PACKAGES.get(owner);
}

// What an `"exports"` map gives a subpath, in its order: an exact key, else the longest `*` pattern
// that matches. A value may be a condition object or a list (`{ "types": ["./src/*.ts"], "default":
// "./src/*" }`), so every file path in it counts.
function exported(exports, subpath) {
  if (typeof exports !== "object" || exports === null || Array.isArray(exports)) return [];
  if (Object.hasOwn(exports, subpath)) return pathsIn(exports[subpath]);
  let best;
  for (const [key, value] of Object.entries(exports)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const [head, tail] = [key.slice(0, star), key.slice(star + 1)];
    if (!subpath.startsWith(head) || !subpath.endsWith(tail) || subpath.length < key.length - 1) continue;
    if (best && head.length <= best.head.length) continue;
    best = { head, value, part: subpath.slice(head.length, subpath.length - tail.length) };
  }
  return best ? pathsIn(best.value).map((path) => path.replaceAll("*", best.part)) : [];
}

function pathsIn(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(pathsIn);
  return [];
}

// The four steps of the header, as { targets, message }: undefined targets skip the pointer.
function judge(owner, path, name, context) {
  const facts = factsOf(owner, path, context);
  if (!facts) return undefined;
  if (holds(owner, path, name, context)) return { targets: 1 };
  const imported = facts.imports.get(name);
  if (imported) {
    return { targets: 0, message: `${path} imports it from ${specifierPath(owner, path, imported) ?? imported}` };
  }
  if (facts.uses.has(name)) return { targets: 1 };
  const declarers = (declarersOf(owner, context).get(name) ?? []).filter((declarer) => declarer !== path);
  if (declarers.length !== 1) return undefined;
  return { targets: 0, message: `${path} never names it in code; ${declarers[0]} declares it` };
}

// Declares or exports the name, following each `export * from` to the file it re-exports.
function holds(owner, path, name, context, depth = 0) {
  const facts = factsOf(owner, path, context);
  if (!facts) return false;
  if (facts.declares.has(name) || facts.exports.has(name)) return true;
  if (depth >= MAX_REEXPORT_DEPTH) return false;
  return facts.starFrom.some((specifier) => {
    const target = specifierPath(owner, path, specifier);
    return target !== undefined && owner.fileSet.has(target) && holds(owner, target, name, context, depth + 1);
  });
}

const IMPORT = /\bimport\s+(?:type\s+)?([^;'"`]*?)\s*\bfrom\s*(["'])([^"'\n]+)\2/g;
const DESTRUCTURED = /\{([^{}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*(["'])([^"'\n]+)\2\s*\)/g;
const EXPORT_LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;
const EXPORT_STAR_AS = new RegExp(`\\bexport\\s+\\*\\s+as\\s+(${IDENTIFIER})`, "g");
const EXPORT_STAR = /\bexport\s+\*\s+from\s*(["'])([^"'\n]+)\1/g;
const EXPORT_DECLARATION = new RegExp(
  `\\bexport\\s+(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|interface|type|enum|namespace)\\s+(${IDENTIFIER})`,
  "g",
);
// A declaration that opens its line, as a module's own names do and a function's locals do not.
const TOP_LEVEL = new RegExp(
  `^(?:export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|interface|type|enum|namespace)\\s+(${IDENTIFIER})`,
  "gm",
);
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|html)$/;

const FACTS = new WeakMap();

// One code file's declarations, exports, `export * from` specifiers, same-name imports (name to
// specifier), the names its code and strings use outside its imports, and the names it is a home
// of for step 4; undefined for a file whose language holds no names.
function factsOf(owner, path, { languageOf, declaration }) {
  if (!FACTS.has(owner)) FACTS.set(owner, new Map());
  const cache = FACTS.get(owner);
  if (!cache.has(path)) {
    const language = languageOf(path);
    const text = language?.names ? readText(join(owner.root, path)) : undefined;
    cache.set(path, text === undefined ? undefined : parse(language.scan(text), declaration, SCRIPT_FILE.test(path)));
  }
  return cache.get(path);
}

function parse({ code, withStrings }, declaration, script) {
  const declares = new Set();
  for (const match of code.matchAll(declaration)) declares.add(match[1] ?? match[2]);
  const exports = new Set();
  for (const match of withStrings.matchAll(EXPORT_LIST)) {
    for (const entry of match[1].split(",")) {
      const exportedName = entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(-1);
      if (exportedName) exports.add(exportedName);
    }
  }
  for (const match of withStrings.matchAll(EXPORT_STAR_AS)) exports.add(match[1]);
  const starFrom = [...withStrings.matchAll(EXPORT_STAR)].map((match) => match[2]);
  const imports = new Map();
  let outside = withStrings;
  for (const pattern of [IMPORT, DESTRUCTURED]) {
    for (const match of withStrings.matchAll(pattern)) {
      outside = outside.slice(0, match.index) + " ".repeat(match[0].length) + outside.slice(match.index + match[0].length);
      const braces = pattern === IMPORT ? /\{([^}]*)\}/.exec(match[1])?.[1] : match[1];
      for (const entry of (braces ?? "").split(",")) {
        const imported = entry.trim().replace(/^type\s+/, "");
        if (new RegExp(`^${IDENTIFIER}$`).test(imported)) imports.set(imported, match[3]);
      }
    }
  }
  for (const match of code.matchAll(EXPORT_DECLARATION)) exports.add(match[1]);
  const homes = script ? new Set([...exports].filter((name) => declares.has(name))) : declares;
  if (script) for (const match of code.matchAll(TOP_LEVEL)) homes.add(match[1]);
  return { declares, exports, starFrom, imports, uses: new Set(outside.match(NAME) ?? []), homes };
}

// The tracked file a relative or workspace-package specifier lands on, the way a bundler tries it;
// undefined for a library's.
function specifierPath(owner, from, specifier) {
  if (specifier.startsWith("@")) return packagePath(owner, specifier);
  if (!specifier.startsWith(".")) return undefined;
  const path = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (owner.fileSet.has(path)) return path;
  const stem = path.replace(/\.(?:js|mjs|cjs)$/, "");
  return MODULE_SUFFIXES.map((suffix) => `${stem}${suffix}`).find((candidate) => owner.fileSet.has(candidate)) ?? path;
}

const DECLARERS = new WeakMap();

// Every tracked code file that is a home of each name, built once per checkout on the first pointer that
// reaches step 4.
function declarersOf(owner, context) {
  if (!DECLARERS.has(owner)) {
    const declarers = new Map();
    for (const file of owner.scanned) {
      for (const name of factsOf(owner, file, context)?.homes ?? []) {
        const list = declarers.get(name);
        if (list) list.push(file);
        else declarers.set(name, [file]);
      }
    }
    DECLARERS.set(owner, declarers);
  }
  return DECLARERS.get(owner);
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
