#!/usr/bin/env node
// The Size cap: a hand-written file holds at most 5,000 tokens, counted as its bytes / 4, so
// 20,000 bytes (a file at exactly 20,000 passes), unless its repo's Over-cap list holds it.
//
// A `size-cap=<bytes>` mark in the repo's `.gitattributes` narrows the cap of each file it matches
// to that whole number under 20,000 (`/CLAUDE.md size-cap=10000`, for a resident file every
// session loads), beside the marks that exempt a file, so a file's cap is read in one place. A mark
// that narrows nothing (`size-cap=10,000`) fails, so a narrowed cap never quietly stops binding; no
// mark raises the cap.
//
//   node size-cap.mjs --staged         a pre-commit hook's call: the files the commit adds or
//                                      modifies, and the staged list against HEAD's
//   node size-cap.mjs [--base <ref>]   CI's call: every file HEAD tracks, and its list against
//                                      <ref>'s, a pull request's base or a push's previous tip
//   node size-cap.mjs --write-list     writes the list from the staged tree, as the commit that
//                                      installs the check does: every judged file over the cap
//
// Exits 1 printing every refusal, 0 otherwise, 2 when it cannot run (git fails, --base names no
// commit, or the repo's `.size-cap.json` is broken).
//
// What is judged: every tracked text file, measured as its blob, at pre-commit the staged one,
// never the working-tree file another session may be editing; unless the repo's `.gitattributes`
// marks it `linguist-generated` or `linguist-vendored`, or git treats it as binary. No list of
// extensions: one lets through every hand-written kind it forgets. A refusal prints the file's
// size and cap, then only the recipe for its kind (see kindOf), then the footer; size-cap.test.mjs
// pins their words.
//
// The recipes name no repo's files, so every repo, a public one too, reads the same words. A repo
// that writes down how a kind of file stays small says where in its own `.size-cap.json`, read
// from the judged tree as the Over-cap list is: `{ "guides": { "resident": "docs/rules.md" } }`
// prints "This repo's guide: docs/rules.md." under each resident file's recipe. A kind it does not
// know, or a guide that is not text, stops the check, so a typo never silently drops a guide.
//
// The Over-cap list, `.over-cap-list` at the repo's root, one path per line, itself never judged:
//   - a listed file over the cap passes;
//   - a listed file now under the cap, deleted or renamed fails until the commit removes its line;
//   - a line added fails, so the list only shrinks, and a renamed file is a new, unlisted path.
// A line is stale when its file is gone or no longer over the cap; a mark or a NUL that exempts a
// listed file leaves its line alone, since the file is still over the cap. Where HEAD or the base
// holds no list, the list is compared with the last one their history holds, so deleting the list
// in one push never lets the next add a line; a history that never held one is the commit that
// installs the check, and adds no line. At pre-commit a line is judged only when the commit
// touches its file or removes the line, so another file's stale line never blocks a commit; CI
// judges every line.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const CAP_BYTES = 20_000;
const LIST = ".over-cap-list";
const SETTINGS = ".size-cap.json";
const CAP_MARK = "size-cap";

const STALE_LINE = "on the Over-cap list but now under the cap (or deleted, or renamed): remove its line in this commit";
const ADDED_LINE = "a line added to the Over-cap list: the list only shrinks; split the file instead";
const BAD_MARK = `narrows nothing: a ${CAP_MARK} mark takes a whole number of bytes under 20,000, as ${CAP_MARK}=10000`;

const SPLIT =
  "Split it before you commit, as its own commit, before your change. Split by design, never by\n" +
  "line count: each new file does one job behind a small interface and is named for that job.\n" +
  "A split that only spreads the same code over more files fails review.";

const FOOTER =
  "If a script or tool writes this file, mark it `linguist-generated` in .gitattributes in this\n" +
  "same commit instead. --no-verify does not help: CI runs the same check on the push.";

const RECIPES = {
  code:
    "1. List the jobs this file does: groups of functions that call each other and share state,\n" +
    "   and seldom call the rest.\n" +
    "2. Move each job into its own file, behind the smallest interface its callers need. The\n" +
    "   original file keeps the entry point and composes them.\n" +
    "3. C#: a class over the cap holds more than one responsibility. Extract a class (a policy,\n" +
    "   a calculator, a builder), never a `partial` class that only spreads one class over files.\n" +
    "4. Run the tests. Behavior does not change in this commit.",
  test:
    "Split with the code under test: one test file per module. If the module stays whole, split by\n" +
    "behavior, one file per top-level describe, and move the shared fixtures and builders into\n" +
    "<name>.fixtures.<ext>.",
  template: "Extract a child component for each panel or repeated block, with inputs and outputs.",
  markdown:
    "Keep <name>.md at its path as the index. Move each ## section word for word into <name>/.\n" +
    "The index is a table whose first cell is each moved section's old heading, so every\n" +
    "`<name>.md → \"Section\"` pointer still resolves. Lose nothing; reword nothing.",
  glossary: "Split the group by kind of work into two groups, and update their lines in GLOSSARY.md.",
  skill:
    "Move a branch beyond the core steps into a sibling file in the skill's folder, behind a\n" +
    "pointer that names the branch.",
  resident:
    "Starting with the lines you added, keep only what most sessions that load this file need. Move\n" +
    "each other line to the doc or skill where its reader looks, leaving at most a one-line pointer.",
  data: "Split by concern: a workflow per group of jobs, translations per feature, alert rules per area.",
};

/**
 * Which recipe a file takes, read from its path. Among Markdown, a resident file first, since a
 * directory-scoped `CLAUDE.md` sits in `.claude/skills/` too. Only a skill's Markdown takes the
 * skill's recipe, which moves a branch of prose; its scripts and data take their own kind's (on
 * 2026-11-04 three over-cap files in skill folders were Python scripts).
 */
function kindOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/\.(test|spec)\./.test(name) || name.endsWith("Tests.cs")) return "test";
  if (name.endsWith(".component.html")) return "template";
  if (/\.mdx?$/.test(name)) {
    if (name === "CLAUDE.md" || name === "AGENTS.md") return "resident";
    if (path.startsWith("glossary/")) return "glossary";
    if (/(^|\/)\.claude\/skills\//.test(path)) return "skill";
    return "markdown";
  }
  if (/\.(ya?ml|jsonc?)$/.test(name)) return "data";
  return "code";
}

// git's own test for binary content, buffer_is_binary(): a NUL in the first 8,000 bytes.
const BINARY_PROBE_BYTES = 8_000;

/** Why the check cannot run: git failed, --base names no commit, or `.size-cap.json` is broken. */
class CannotRun extends Error {}

/**
 * git's stdout for `args`, a Buffer; throws CannotRun when git fails. A mark exempts a file only
 * from the repo's own `.gitattributes`, so a person's global attributes file and the system's are
 * not read; a clone's `.git/info/attributes` still is, since git has no switch for it.
 */
function git(args, input) {
  const run = spawnSync("git", ["-c", "core.quotePath=false", "-c", "core.attributesFile=/dev/null", ...args], {
    input,
    maxBuffer: 2 ** 30,
    env: { ...process.env, GIT_ATTR_NOSYSTEM: "1" },
  });
  if (run.status !== 0) throw new CannotRun(`git ${args.join(" ")}: ${(run.stderr ?? "").toString().trim() || run.error?.message}`);
  return run.stdout;
}

const nulSeparated = (buffer) => buffer.toString("utf8").split("\0").filter(Boolean);

// A regular file's mode, 100644 or 100755: never a symlink (120000) or a submodule (160000).
const REGULAR = /^100[0-7]{3}$/;

/**
 * Each regular file `args` lists, as `{ path, sha }`: `ls-files -s` and `ls-tree -r` both print
 * `<mode> <fields>\t<path>`, the sha the `shaAt`th field.
 */
function regularFiles(args, shaAt) {
  return nulSeparated(git(args)).flatMap((entry) => {
    const tab = entry.indexOf("\t");
    const fields = entry.slice(0, tab).split(" ");
    return REGULAR.test(fields[0]) ? [{ path: entry.slice(tab + 1), sha: fields[shaAt] }] : [];
  });
}

const stagedFiles = () => regularFiles(["ls-files", "-s", "-z"], 1);
const committedFiles = (ref) => regularFiles(["ls-tree", "-r", "-z", ref], 2);

const isCommit = (ref) => spawnSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).status === 0;

/** `files` with each blob's `bytes`. */
function withSizes(files) {
  if (files.length === 0) return [];
  const sizes = git(["cat-file", "--batch-check=%(objectsize)"], files.map((file) => `${file.sha}\n`).join(""))
    .toString("utf8")
    .split("\n");
  return files.map((file, at) => ({ ...file, bytes: Number(sizes[at]) }));
}

const isSet = (value) => value === "set" || value === "true";

/**
 * Each of `files`' marks in `.gitattributes`, read where `attributeSource` (a `git check-attr`
 * flag) says: a Map from its path to `{ <attribute>: <value> }`.
 */
function marksOf(files, attributeSource) {
  const marks = new Map(files.map((file) => [file.path, {}]));
  if (files.length === 0) return marks;
  // `-z` prints `<path>\0<attribute>\0<value>\0` for each, and a value may be empty (`attr=`).
  const fields = git(
    ["check-attr", "-z", "--stdin", ...attributeSource, CAP_MARK, "linguist-generated", "linguist-vendored", "diff"],
    files.map((file) => `${file.path}\0`).join(""),
  )
    .toString("utf8")
    .split("\0");
  for (let at = 0; at + 2 < fields.length; at += 3) marks.get(fields[at])[fields[at + 1]] = fields[at + 2];
  return marks;
}

/**
 * The files of `files` the cap judges: unless their `marks` mark one generated or vendored, or git
 * treats it as binary.
 */
function judgedFiles(files, marks) {
  const text = files.filter(({ path }) => {
    const mark = marks.get(path);
    return !isSet(mark["linguist-generated"]) && !isSet(mark["linguist-vendored"]) && mark.diff !== "unset";
  });
  if (text.length === 0) return [];
  // `--batch` prints each blob as `<sha> blob <size>\n<content>\n`.
  const blobs = git(["cat-file", "--batch"], text.map((file) => `${file.sha}\n`).join(""));
  let offset = 0;
  return text.filter((file) => {
    const start = blobs.indexOf(0x0a, offset) + 1;
    offset = start + file.bytes + 1;
    return !blobs.subarray(start, start + Math.min(file.bytes, BINARY_PROBE_BYTES)).includes(0);
  });
}

const narrows = (value) => /^[1-9]\d*$/.test(value) && Number(value) < CAP_BYTES;

/**
 * The files of `files` over their cap, each with its `cap`: `big`, the path of every one, and
 * `judged`, those the cap judges, `.gitattributes` read as `attributeSource` says; and `badMarks`,
 * each file whose size-cap mark narrows nothing, with its `mark`.
 */
function overCap(files, attributeSource) {
  const sized = withSizes(files.filter((file) => file.path !== LIST));
  const marks = marksOf(sized, attributeSource);
  const big = [];
  const badMarks = [];
  for (const file of sized) {
    const mark = marks.get(file.path)[CAP_MARK];
    const narrowed = narrows(mark);
    if (!narrowed && mark !== "unspecified" && mark !== "unset") badMarks.push({ path: file.path, mark });
    const cap = narrowed ? Number(mark) : CAP_BYTES;
    if (file.bytes > cap) big.push({ ...file, cap });
  }
  return { big: new Set(big.map((file) => file.path)), judged: judgedFiles(big, marks), badMarks };
}

/** The text of `path` in `treeish` (`HEAD`, a base, or "" for the index), or null when it holds none. */
function blobAt(treeish, path) {
  // `--batch` answers `<spec> missing` for a path the tree lacks, or a HEAD not yet born.
  const out = git(["cat-file", "--batch"], `${treeish}:${path}\n`);
  const header = out.subarray(0, out.indexOf(0x0a)).toString("utf8");
  if (header.endsWith(" missing")) return null;
  return out.subarray(header.length + 1, header.length + 1 + Number(header.split(" ")[2])).toString("utf8");
}

/** The Over-cap list `treeish` holds as a Set, or null when it holds none. */
function listAt(treeish) {
  const list = blobAt(treeish, LIST);
  return list === null ? null : new Set(list.split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean));
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** The guides `treeish`'s `.size-cap.json` names, by kind; none when it holds no such file. */
function guidesAt(treeish) {
  const text = blobAt(treeish, SETTINGS);
  if (text === null) return {};
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new CannotRun(`${SETTINGS} is not JSON (${error.message})`);
  }
  const guides = settings?.guides ?? {};
  const known = ([kind, guide]) => Object.hasOwn(RECIPES, kind) && typeof guide === "string" && guide !== "";
  if (!isObject(settings) || Object.keys(settings).some((key) => key !== "guides") || !isObject(guides) || !Object.entries(guides).every(known)) {
    const shape = '{ "guides": { "<kind>": "<where this repo says how such a file stays small>" } }';
    throw new CannotRun(`${SETTINGS} holds ${shape}, each kind one of ${Object.keys(RECIPES).join(", ")}`);
  }
  return guides;
}

/** The list `ref` holds, else the last its history held (before the commit that deleted it), else null. */
function lastListAt(ref) {
  const list = listAt(ref);
  if (list || !isCommit(ref)) return list;
  const deleting = git(["log", "-1", "--format=%H", ref, "--", LIST]).toString("utf8").trim();
  return deleting ? listAt(`${deleting}^`) : null;
}

const grouped = (number) => String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const tokens = (bytes) => `${grouped(Math.ceil(bytes / 4))} tokens`;

/**
 * The refusal of a file over its cap: its size and cap, then the recipe for its kind and the repo's
 * guide for that kind from `guides`, then the footer. A resident file is cut line by line, so it
 * takes no split.
 */
function sizeRefusal({ path, bytes, cap }, guides) {
  const limit = `${tokens(cap)} (${grouped(cap)} bytes)`;
  const capIs = cap === CAP_BYTES ? `The cap is ${limit}.` : `Its cap is ${limit}, narrowed by its ${CAP_MARK} mark in .gitattributes.`;
  const kind = kindOf(path);
  const advice = [kind === "resident" ? RECIPES.resident : `${SPLIT}\n\n${RECIPES[kind]}`];
  if (guides[kind]) advice.push(`This repo's guide: ${guides[kind]}.`);
  return `size cap: ${path} is ${grouped(bytes)} bytes = ${tokens(bytes)} (bytes/4). ${capIs}\n\n${advice.join("\n\n")}\n\n${FOOTER}\n`;
}

/**
 * Every refusal, sorted by path: each `judged` file `list` lacks, with its kind's guide from
 * `guides`, each of the `badMarks`, and each line of `list` that `before` (the list it is compared
 * with; null when no line counts as added) lacks, or whose file `judgesLine` and is not among the
 * `big` ones.
 */
function refusalsOf({ big, judged, badMarks }, guides, list, before, judgesLine) {
  const refusals = judged.filter((file) => !list.has(file.path)).map((file) => ({ path: file.path, text: sizeRefusal(file, guides) }));
  for (const { path, mark } of badMarks) refusals.push({ path, text: `size cap: ${path}: its mark ${mark === "set" ? CAP_MARK : `${CAP_MARK}=${mark}`} ${BAD_MARK}\n` });
  for (const path of list) {
    if (before && !before.has(path)) refusals.push({ path, text: `size cap: ${path}: ${ADDED_LINE}\n` });
    else if (judgesLine(path) && !big.has(path)) refusals.push({ path, text: `size cap: ${path}: ${STALE_LINE}\n` });
  }
  return refusals.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A pre-commit hook's call: the files the commit adds or modifies, and each whose line it removes
 * from the list; the staged list's added lines against HEAD's, and its lines whose files the
 * commit touches.
 */
function stagedRefusals() {
  const head = lastListAt("HEAD");
  const list = listAt("") ?? new Set();
  const diff = (...filter) => new Set(nulSeparated(git(["diff", "--cached", "--name-only", "-z", "--no-renames", ...filter])));
  const touched = diff();
  const addedOrModified = diff("--diff-filter=AMT");
  const unlisted = new Set([...(head ?? [])].filter((path) => !list.has(path)));
  const files = stagedFiles().filter((file) => addedOrModified.has(file.path) || unlisted.has(file.path));
  return { refusals: refusalsOf(overCap(files, ["--cached"]), guidesAt(""), list, head, (path) => touched.has(path)), judged: files.length };
}

/** CI's call: every file HEAD tracks and every line of its list, the list against `base`'s when given. */
function treeRefusals(base) {
  if (base !== undefined && !isCommit(base)) throw new CannotRun(`--base ${base} names no commit in this repo`);
  const files = committedFiles("HEAD");
  const list = listAt("HEAD") ?? new Set();
  const before = base === undefined ? null : lastListAt(base);
  return { refusals: refusalsOf(overCap(files, ["--source", "HEAD"]), guidesAt("HEAD"), list, before, () => true), judged: files.length };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Writes the list from the staged tree, the one the commit that installs the check lands. */
function writeList() {
  const paths = overCap(stagedFiles(), ["--cached"])
    .judged.map((file) => file.path)
    .sort();
  writeFileSync(join(git(["rev-parse", "--show-toplevel"]).toString("utf8").trim(), LIST), paths.map((path) => `${path}\n`).join(""));
  process.stdout.write(`size cap: wrote ${LIST}, ${plural(paths.length, "file")} over the cap\n`);
}

function main(argv) {
  let staged = false;
  let base;
  let write = false;
  for (let at = 0; at < argv.length; at++) {
    if (argv[at] === "--staged") staged = true;
    else if (argv[at] === "--write-list") write = true;
    else if (argv[at] === "--base") {
      if (at + 1 === argv.length) {
        process.stderr.write("size cap: --base needs a ref\n");
        return 2;
      }
      base = argv[++at];
    } else {
      process.stderr.write(`size cap: unknown option ${argv[at]}\n`);
      return 2;
    }
  }
  if (staged + write + (base !== undefined) > 1) {
    process.stderr.write("size cap: --staged, --base and --write-list each run alone\n");
    return 2;
  }
  try {
    if (write) {
      writeList();
      return 0;
    }
    const { refusals, judged } = staged ? stagedRefusals() : treeRefusals(base);
    process.stdout.write(refusals.map((refusal) => `${refusal.text}\n`).join(""));
    process.stdout.write(
      refusals.length > 0
        ? `size cap: ${plural(refusals.length, "refusal")}\n`
        : `size cap: no file over the cap outside the Over-cap list (${plural(judged, "file")} judged)\n`,
    );
    return refusals.length > 0 ? 1 : 0;
  } catch (error) {
    if (!(error instanceof CannotRun)) throw error;
    process.stderr.write(`size cap: ${error.message}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
