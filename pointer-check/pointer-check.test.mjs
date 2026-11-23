// Pins the pointer check's command: its options, what it prints and its exit codes.
// What an agent observes is a pointer that resolves or does not, and an exit code that fails CI
// or passes. How a file is parsed is not pinned.
//
//   node --test pointer-check/pointer-check.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { check, repo, writeTree } from "./pointer-check.fixtures.mjs";

test("--staged checks the files the index stages, as a pre-commit hook asks, and with none staged checks nothing", () => {
  const dir = repo({ "src/a.ts": "export const a = 1;\n", "docs/staged.md": "`src/gone.ts`\n" });
  writeTree(dir, { "docs/draft.md": "another session's `src/also-gone.ts`\n" });
  assert.deepEqual(check(dir, "--staged").lines, ["docs/staged.md:1: `src/gone.ts` resolves to nothing"]);
  execFileSync("git", ["commit", "-qm", "seed", "--no-verify"], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@a", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@a" } });
  const none = check(dir, "--staged");
  assert.deepEqual(none.lines, []);
  assert.equal(none.status, 0);
});

test("report-only prints every failure and exits zero", () => {
  const dir = repo({ "docs/live.md": "`src/gone.ts`\n" });
  const result = check(dir, "--report-only");
  assert.deepEqual(result.lines, ["docs/live.md:1: `src/gone.ts` resolves to nothing"]);
  assert.match(result.stdout, /pointer-check: 1 failing pointer in 1 file/);
  assert.equal(result.status, 0);
});

test("paths after the options limit which files are checked, not what resolves", () => {
  const dir = repo({
    "src/kept.ts": "export const kept = 1;\n",
    "docs/a.md": "`src/gone.ts` and `src/kept.ts`\n",
    "docs/b.md": "`src/gone.ts`\n",
  });
  assert.deepEqual(check(dir, "docs/a.md").lines, ["docs/a.md:1: `src/gone.ts` resolves to nothing"]);
});

test("an unknown option exits 2, the retired --fail-headings among them", () => {
  const dir = repo({ "README.md": "Nothing to point at.\n" });
  const result = check(dir, "--fail-headings");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option --fail-headings/);
});
