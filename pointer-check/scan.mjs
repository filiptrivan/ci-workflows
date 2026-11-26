// Which parts of a file are prose and which are code. Prose is a Markdown file's lines outside its
// fences, a code file's comments, and the guides of a root `.size-cap.json`. A name resolves
// against a code file's code, with its comments and strings blanked (repo.mjs).

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SNAPSHOT_HEADER = /^(>\s*)?Snapshot as of \d{4}-\d{2}-\d{2}\b/;

export const IDENTIFIER = "[A-Za-z_$][\\w$]*";

// How comments are written, per extension. `names` marks a language whose code declares and uses
// the names a symbol pointer resolves against; config, style and markup files only carry comments.
const LANGUAGES = [
  { extensions: "ts tsx mts cts js jsx mjs cjs cs", scan: (text) => scanC(text, { slash: true }), names: true },
  { extensions: "scss less", scan: (text) => scanC(text, { slash: true }) },
  { extensions: "css", scan: (text) => scanC(text, {}) },
  // `tsconfig.json`, `angular.json` and .NET's `appsettings.json` all take comments.
  { extensions: "json jsonc json5", scan: (text) => scanC(text, { slash: true }) },
  { extensions: "sh bash zsh", scan: (text) => scanHash(text, {}), names: true },
  // A workflow's expressions call names (`always()`, `hashFiles()`) and its keys are names too.
  { extensions: "yml yaml toml bats", scan: (text) => scanHash(text, {}), names: true },
  { extensions: "py", scan: (text) => scanHash(text, { python: true }), names: true },
  { extensions: "sql", scan: (text) => scanC(text, { dashes: true }), names: true },
  { extensions: "html", scan: (text) => scanMarkup(text), names: true },
  { extensions: "csproj props targets xml", scan: (text) => scanMarkup(text) },
  { extensions: "tf hcl", scan: (text) => scanC(text, { slash: true, hash: true }), names: true },
];
const LANGUAGE_OF = new Map(
  LANGUAGES.flatMap((language) => language.extensions.split(" ").map((extension) => [extension, language])),
);
export const MARKDOWN_EXTENSIONS = new Set(["md", "mdx"]);

// As written, not lowercased: `migrationBuilder.Sql` is a member, `schema.sql` a file.
export function extensionOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

export function languageOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return LANGUAGE_OF.get(/^Dockerfile(\.|$)/.test(base) ? "sh" : extensionOf(path).toLowerCase());
}

export function readText(path) {
  try {
    if (statSync(path).size > 8 * 1024 * 1024) return undefined;
    const text = readFileSync(path, "utf8");
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

// What every scanner returns, from the comment and string ranges it found: the comments, one
// entry per line a comment touches; the code with every comment and string blanked; the code with
// only the comments blanked; and the string literals that are exactly a name. Scanners are
// approximate on purpose: a mis-scanned line costs a missed pointer at worst.
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
  const literals = strings
    .map(([from, to]) => /^(["'`])(.*)\1$/s.exec(text.slice(from, to))?.[2])
    .filter((inner) => inner !== undefined && new RegExp(`^${IDENTIFIER}$`).test(inner));
  return { comments, code, withStrings, literals };
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

export function skipString(text, start, quote) {
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
export function markdownLines(text) {
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

export const SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;

// The text with each code span blanked to spaces, so columns still line up.
export function maskSpans(text) {
  return text.replace(SPAN, (span) => " ".repeat(span.length));
}

// A Size cap refusal prints each guide of a repo's `.size-cap.json` (size-cap/size-cap.mjs), so a
// guide is prose and its pointers are checked; every other JSON string is data.
const SIZE_CAP_SETTINGS = ".size-cap.json";

function sizeCapGuides(text) {
  let guides;
  try {
    guides = JSON.parse(text)?.guides;
  } catch {
    return [];
  }
  if (typeof guides !== "object" || guides === null) return [];
  return Object.values(guides)
    .filter((guide) => typeof guide === "string")
    .map((guide) => {
      const at = text.indexOf(JSON.stringify(guide));
      return { line: at === -1 ? 1 : text.slice(0, at).split("\n").length, text: guide, kind: "comment" };
    });
}

export function prose(repo, file) {
  const extension = extensionOf(file);
  const text = readText(join(repo.root, file));
  if (text === undefined) return [];
  if (SNAPSHOT_HEADER.test(text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n")))) return [];
  if (MARKDOWN_EXTENSIONS.has(extension)) return markdownLines(text).map((line) => ({ ...line, kind: "markdown" }));
  if (file === SIZE_CAP_SETTINGS) return sizeCapGuides(text);
  const language = languageOf(file);
  if (!language) return [];
  return language.scan(text).comments.map((line) => ({ ...line, kind: "comment" }));
}
