#!/usr/bin/env node
// The Size cap: a hand-written file holds at most 5,000 tokens, counted as its bytes / 4, so
// 20,000 bytes (a file at exactly 20,000 passes), unless its repo's Over-cap list holds it.
//
//   node size-cap.mjs --staged         a pre-commit hook's call: the files the commit adds or
//                                      modifies, and the staged list against HEAD's
//   node size-cap.mjs [--base <ref>]   CI's call: every file HEAD tracks, and its list against
//                                      <ref>'s, a pull request's base or a push's previous tip
//   node size-cap.mjs --write-list     writes the list from the staged tree, as the commit that
//                                      installs the check does: every judged file over the cap
//
// Exits 1 printing every refusal, 0 otherwise, 2 when it cannot run (git fails, or --base names
// no commit).
//
// What is judged: every tracked text file, measured as its blob, at pre-commit the staged one,
// never the working-tree file another session may be editing; unless the repo's `.gitattributes`
// marks it `linguist-generated` or `linguist-vendored`, or git treats it as binary. No list of
// extensions: one lets through every hand-written kind it forgets. A refusal prints the file's
// size, then only the recipe for its kind (see kindOf), then the footer; size-cap.test.mjs pins
// their words.
//
// The Over-cap list, `.over-cap-list` at the repo's root, one path per line, itself never judged:
//   - a listed file over the cap passes;
//   - a listed file now under the cap, deleted or renamed fails until the commit removes its line;
//   - a line added fails, so the list only shrinks, and a renamed file is a new, unlisted path.
// A list compared with none (HEAD or the base holds no list) adds no line: that is the commit
// that installs the check. At pre-commit a line is judged only when the commit touches its file
// or removes the line, so another file's stale line never blocks a commit; CI judges every line.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const CAP_BYTES = 20_000;
const LIST = ".over-cap-list";

const LISTED = "on the Over-cap list but now under the cap (or deleted, or renamed): remove its line in this commit";
const ADDED = "a line added to the Over-cap list: the list only shrinks; split the file instead";

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
    'pointer that names the branch (.claude/skills/CLAUDE.md → "Writing a skill").',
  resident:
    'Move the full telling to its home (docs/agents/domain.md → "Where a fact goes") and keep\n' +
    "one line here.",
  data: "Split by concern: a workflow per group of jobs, translations per feature, alert rules per area.",
};

/**
 * Which recipe a file takes, read from its path. Among Markdown, a resident file first, since a
 * directory-scoped `CLAUDE.md` sits in `.claude/skills/` too; a skill's script or data file takes
 * the code recipe, not the skill's, which moves a branch of prose (on 2026-11-04 three of the
 * umbrella's over-cap files there were Python scripts).
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

class GitError extends Error {}

/**
 * git's stdout for `args`, a Buffer; throws a GitError when git fails. A mark exempts a file only
 * from the repo's own `.gitattributes`, so a person's global attributes file and the system's are
 * not read; a clone's `.git/info/attributes` still is, since git has no switch for it.
 */
function git(args, input) {
  const run = spawnSync("git", ["-c", "core.quotePath=false", "-c", "core.attributesFile=/dev/null", ...args], {
    input,
    maxBuffer: 2 ** 30,
    env: { ...process.env, GIT_ATTR_NOSYSTEM: "1" },
  });
  if (run.status !== 0) throw new GitError(`git ${args.join(" ")}: ${(run.stderr ?? "").toString().trim() || run.error?.message}`);
  return run.stdout;
}

const nulSeparated = (buffer) => buffer.toString("utf8").split("\0").filter(Boolean);

// A regular file's mode, 100644 or 100755: never a symlink (120000) or a submodule (160000).
const REGULAR = /^100[0-7]{3}$/;

/** Each regular file the index holds, as `{ path, sha }`. */
function stagedFiles() {
  return nulSeparated(git(["ls-files", "-s", "-z"])).flatMap((entry) => {
    const [mode, sha] = entry.split(" ");
    return REGULAR.test(mode) ? [{ path: entry.slice(entry.indexOf("\t") + 1), sha }] : [];
  });
}

/** Each regular file `ref`'s tree holds, as `{ path, sha }`. */
function committedFiles(ref) {
  return nulSeparated(git(["ls-tree", "-r", "-z", ref])).flatMap((entry) => {
    const [mode, , sha] = entry.split(/[ \t]/);
    return REGULAR.test(mode) ? [{ path: entry.slice(entry.indexOf("\t") + 1), sha }] : [];
  });
}

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
 * The files of `files` the cap judges: unless `.gitattributes`, read where `attributeSource` (a
 * `git check-attr` flag) says, marks one generated or vendored, or git treats it as binary.
 */
function judgedFiles(files, attributeSource) {
  if (files.length === 0) return [];
  const fields = nulSeparated(
    git(["check-attr", "-z", "--stdin", ...attributeSource, "linguist-generated", "linguist-vendored", "diff"], files.map((file) => `${file.path}\0`).join("")),
  );
  const marks = new Map(files.map((file) => [file.path, {}]));
  for (let at = 0; at + 2 < fields.length; at += 3) marks.get(fields[at])[fields[at + 1]] = fields[at + 2];
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

/** The files of `files` over the cap that the cap judges, `.gitattributes` read as `attributeSource` says. */
function overCap(files, attributeSource) {
  return judgedFiles(
    withSizes(files.filter((file) => file.path !== LIST)).filter((file) => file.bytes > CAP_BYTES),
    attributeSource,
  );
}

/** The Over-cap list `treeish` holds (`HEAD`, a base, or "" for the index) as a Set, or null when it holds none. */
function listAt(treeish) {
  // `--batch` answers `<spec> missing` for a path the tree lacks, or a HEAD not yet born.
  const out = git(["cat-file", "--batch"], `${treeish}:${LIST}\n`);
  const header = out.subarray(0, out.indexOf(0x0a)).toString("utf8");
  if (header.endsWith(" missing")) return null;
  const lines = out.subarray(header.length + 1, header.length + 1 + Number(header.split(" ")[2])).toString("utf8").split("\n");
  return new Set(lines.map((line) => line.replace(/\r$/, "")).filter(Boolean));
}

const grouped = (number) => String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The refusal of a file over the cap: its size, then the recipe for its kind, then the footer. */
function sizeRefusal({ path, bytes }) {
  const size = `${grouped(bytes)} bytes = ${grouped(Math.ceil(bytes / 4))} tokens (bytes/4)`;
  return `size cap: ${path} is ${size}. The cap is 5,000 tokens (20,000 bytes).\n\n${SPLIT}\n\n${RECIPES[kindOf(path)]}\n\n${FOOTER}\n`;
}

/**
 * Every refusal, sorted by path: each file of `over` that `list` lacks, and each line of `list`
 * that `before` (the list it is compared with; null when no line counts as added) lacks, or whose
 * file `judgesLine` and that `over` lacks.
 */
function refusalsOf(over, list, before, judgesLine) {
  const refusals = over.filter((file) => !list.has(file.path)).map((file) => ({ path: file.path, text: sizeRefusal(file) }));
  const overPaths = new Set(over.map((file) => file.path));
  for (const path of list) {
    if (before && !before.has(path)) refusals.push({ path, text: `size cap: ${path}: ${ADDED}\n` });
    else if (judgesLine(path) && !overPaths.has(path)) refusals.push({ path, text: `size cap: ${path}: ${LISTED}\n` });
  }
  return refusals.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A pre-commit hook's call: the files the commit adds or modifies, and each whose line it removes
 * from the list; the staged list's added lines against HEAD's, and its lines whose files the
 * commit touches.
 */
function stagedRefusals() {
  const head = listAt("HEAD");
  const list = listAt("") ?? new Set();
  const diff = (...filter) => new Set(nulSeparated(git(["diff", "--cached", "--name-only", "-z", "--no-renames", ...filter])));
  const touched = diff();
  const changed = diff("--diff-filter=AMT");
  const unlisted = new Set([...(head ?? [])].filter((path) => !list.has(path)));
  const files = stagedFiles().filter((file) => changed.has(file.path) || unlisted.has(file.path));
  return { refusals: refusalsOf(overCap(files, ["--cached"]), list, head, (path) => touched.has(path)), judged: files.length };
}

/** CI's call: every file HEAD tracks and every line of its list, the list against `base`'s when given. */
function treeRefusals(base) {
  if (base !== undefined && spawnSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`]).status !== 0) {
    throw new GitError(`--base ${base} names no commit in this repo`);
  }
  const files = committedFiles("HEAD");
  const list = listAt("HEAD") ?? new Set();
  const before = base === undefined ? null : listAt(base);
  return { refusals: refusalsOf(overCap(files, ["--source", "HEAD"]), list, before, () => true), judged: files.length };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Writes the list from the staged tree, the one the commit that installs the check lands. */
function writeList() {
  const paths = overCap(stagedFiles(), ["--cached"])
    .map((file) => file.path)
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
    else if (argv[at] === "--base" && at + 1 < argv.length) base = argv[++at];
    else {
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
    if (!(error instanceof GitError)) throw error;
    process.stderr.write(`size cap: ${error.message}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
