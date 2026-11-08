// The builders and expected texts size-cap.test.mjs pins the Size cap with: a real git repo in a
// temp folder, the CLI run in it, and each refusal's words as the check must print them.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "size-cap.mjs");

export const git = (dir, ...args) =>
  execFileSync("git", ["-c", "user.name=Size Cap", "-c", "user.email=size-cap@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  }).trim();

/** Writes `files` into `dir` and stages them; a null content deletes its file. */
export function stage(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(dir, path));
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  }
  git(dir, "add", "-A");
}

/** A real git repo whose HEAD holds `head` and whose index holds `staged` on top of it. */
export function repo(head, staged = {}) {
  const dir = mkdtempSync(join(tmpdir(), "size-cap-"));
  git(dir, "init", "-q", "-b", "main");
  stage(dir, { "README.md": "a repo\n", ...head });
  git(dir, "commit", "-q", "--no-verify", "-m", "the tree before this commit");
  stage(dir, staged);
  return dir;
}

/** Commits what `dir` stages, as the commit CI then judges; HEAD's sha before it. */
export function commit(dir) {
  const before = git(dir, "rev-parse", "HEAD");
  git(dir, "commit", "-q", "--no-verify", "-m", "the commit");
  return before;
}

export function run(dir, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });
  return { status: result.status, out: result.stdout + result.stderr };
}

/** `bytes` bytes of text, in lines. */
export const text = (bytes) => `${"x".repeat(79)}\n`.repeat(Math.ceil(bytes / 80)).slice(0, bytes);

export const SPLIT =
  "Split it before you commit, as its own commit, before your change. Split by design, never by\n" +
  "line count: each new file does one job behind a small interface and is named for that job.\n" +
  "A split that only spreads the same code over more files fails review.";

export const FOOTER =
  "If a script or tool writes this file, mark it `linguist-generated` in .gitattributes in this\n" +
  "same commit instead. --no-verify does not help: CI runs the same check on the push.";

export const CODE_RECIPE =
  "1. List the jobs this file does: groups of functions that call each other and share state,\n" +
  "   and seldom call the rest.\n" +
  "2. Move each job into its own file, behind the smallest interface its callers need. The\n" +
  "   original file keeps the entry point and composes them.\n" +
  "3. C#: a class over the cap holds more than one responsibility. Extract a class (a policy,\n" +
  "   a calculator, a builder), never a `partial` class that only spreads one class over files.\n" +
  "4. Run the tests. Behavior does not change in this commit.";

export const RECIPES = {
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
  code: CODE_RECIPE,
};

export const LISTED = (path) => `size cap: ${path}: on the Over-cap list but now under the cap (or deleted, or renamed): remove its line in this commit`;
export const ADDED = (path) => `size cap: ${path}: a line added to the Over-cap list: the list only shrinks; split the file instead`;
/** Each refusal's first line, a size refusal's cut to `size cap: <path> is over`. */
export const sizeLines = (out) =>
  out
    .split("\n")
    .filter((line) => /^size cap: \S+(?:: | is )/.test(line))
    .map((line) => line.replace(/ is [\d,]+ bytes.*/, " is over"));
