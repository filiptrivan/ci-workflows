// The pointer check's test fixtures: a real git repo written from a map of files, and a run of
// the CLI in it, its report lines without the summary.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "pointer-check.mjs");

export function writeTree(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

// A real git repo, because "tracked" is what the check resolves against.
export function repo(files, parent = mkdtempSync(join(tmpdir(), "pointer-check-")), name = "repo") {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeTree(dir, files);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

// A git command in `dir`, its output; a commit's author and committer are the test's, since CI's
// runner names none.
const IDENTITY = { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
export const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...IDENTITY } }).trim();

export function check(dir, ...args) {
  const run = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8" });
  const lines = run.stdout.split("\n").filter((line) => line.length > 0 && !line.startsWith("pointer-check:"));
  return { status: run.status, lines, stdout: run.stdout, stderr: run.stderr };
}
