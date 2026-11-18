// The builders of size-cap.test.mjs: a git repo in a temp folder, the CLI run in it, each refusal's
// first line.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ADDED_LINE, STALE_LINE } from "./size-cap.mjs";

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

export const LISTED = (path) => `size cap: ${path}: ${STALE_LINE}`;
export const ADDED = (path) => `size cap: ${path}: ${ADDED_LINE}`;
/** Each refusal's first line, a size refusal's cut to `size cap: <path> is over`. */
export const sizeLines = (out) =>
  out
    .split("\n")
    .filter((line) => /^size cap: \S+(?:: | is )/.test(line))
    .map((line) => line.replace(/ is [\d,]+ bytes.*/, " is over"));
