// Pins what the three checks judge in a merge commit, at each one's `--staged` CLI as a pre-commit
// hook runs it: each test builds a real git repo stopped in a conflicted merge, its conflict resolved
// and staged, and asserts only the exit code and the printed text (pacms-workspace#1752).
//
//   node --test own-changes/own-changes.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE_CAP = "size-cap/size-cap.mjs";
const NO_NEW_PLANS = "no-new-plans/no-new-plans.mjs";
const POINTER_CHECK = "pointer-check/pointer-check.mjs";

const IDENTITY = ["-c", "user.name=Check", "-c", "user.email=check@example.com", "-c", "commit.gpgsign=false"];

const git = (dir, ...args) => execFileSync("git", [...IDENTITY, ...args], { cwd: dir, encoding: "utf8" }).trim();

/** Writes `files` into `dir`; a null content deletes its file. */
function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(dir, path));
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  }
}

function commitAll(dir, files) {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-verify", "-m", "a commit");
}

/**
 * A real git repo stopped in the merge of its branch `origin` into `main`. Both branches start from
 * `base`; then `main` commits `ours` and `origin` commits `theirs`, and each writes its own
 * notes.md, so the merge stops on a conflict there. The resolution writes notes.md and
 * `resolution`, and stages them.
 */
function conflictedMerge(t, { base = {}, ours = {}, theirs = {}, resolution = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "own-changes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  commitAll(dir, { "README.md": "a repo\n", "notes.md": "base\n", ...base });
  git(dir, "checkout", "-q", "-b", "origin");
  commitAll(dir, { "notes.md": "theirs\n", ...theirs });
  git(dir, "checkout", "-q", "main");
  commitAll(dir, { "notes.md": "ours\n", ...ours });
  const merge = spawnSync("git", [...IDENTITY, "merge", "-q", "--no-verify", "origin"], { cwd: dir, encoding: "utf8" });
  assert.equal(merge.status, 1, `the merge stops on its conflict: ${merge.stdout}${merge.stderr}`);
  write(dir, { "notes.md": "resolved\n", ...resolution });
  git(dir, "add", "-A");
  return dir;
}

function run(dir, check) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [join(ROOT, check), "--staged"], { cwd: dir, encoding: "utf8" });
  return { status, out: stdout + stderr };
}

/** `bytes` bytes of text, in lines. */
const text = (bytes) => `${"x".repeat(79)}\n`.repeat(Math.ceil(bytes / 80)).slice(0, bytes);

const OVER_CAP = text(20_001);

/* ------------------------------------------------------------------------------------ Size cap */

test("the Size cap passes a file over the cap that origin's side brought into the merge unchanged", (t) => {
  const { status, out } = run(conflictedMerge(t, { theirs: { "big.txt": OVER_CAP } }), SIZE_CAP);
  assert.equal(status, 0, out);
});

test("the Size cap refuses the same bytes when the resolution writes them", (t) => {
  const { status, out } = run(conflictedMerge(t, { theirs: { "big.txt": OVER_CAP }, resolution: { "notes.md": OVER_CAP } }), SIZE_CAP);
  assert.equal(status, 1, out);
  assert.match(out, /^size cap: notes\.md is 20,001 bytes/m);
  assert.doesNotMatch(out, /big\.txt/);
});

const LISTED = { ".over-cap-list": "listed.txt\n", "listed.txt": OVER_CAP };

test("the Size cap counts no line as added that origin's Over-cap list holds", (t) => {
  const theirs = { ".over-cap-list": "big.txt\nlisted.txt\n", "big.txt": OVER_CAP };
  const { status, out } = run(conflictedMerge(t, { base: LISTED, theirs }), SIZE_CAP);
  assert.equal(status, 0, out);
});

test("the Size cap refuses a line that no parent's Over-cap list holds and the resolution adds", (t) => {
  const resolution = { ".over-cap-list": "listed.txt\nmine.txt\n", "mine.txt": OVER_CAP };
  const { status, out } = run(conflictedMerge(t, { base: LISTED, resolution }), SIZE_CAP);
  assert.equal(status, 1, out);
  assert.match(out, /^size cap: mine\.txt: a line added/m);
});

/* ------------------------------------------------------------------------------- No new plans */

const PLANNED = { ".plans-list": "old-plan\n", "docs/plans/old-plan.md": "old\n" };

test("the no new plans check passes a plan that origin's side brought into the merge unchanged", (t) => {
  const { status, out } = run(conflictedMerge(t, { base: PLANNED, theirs: { "docs/plans/origin-plan.md": "a plan\n" } }), NO_NEW_PLANS);
  assert.equal(status, 0, out);
});

test("the no new plans check refuses the same plan when the resolution adds it", (t) => {
  const merge = conflictedMerge(t, {
    base: PLANNED,
    theirs: { "docs/plans/origin-plan.md": "a plan\n" },
    resolution: { "docs/plans/my-plan.md": "a plan\n" },
  });
  const { status, out } = run(merge, NO_NEW_PLANS);
  assert.equal(status, 1, out);
  assert.match(out, /^docs\/plans\/my-plan\.md: /m);
  assert.doesNotMatch(out, /origin-plan/);
});

test("the no new plans check counts no line as added that origin's .plans-list holds", (t) => {
  const theirs = { ".plans-list": "old-plan\norigin-plan\n", "docs/plans/origin-plan.md": "a plan\n" };
  const { status, out } = run(conflictedMerge(t, { base: PLANNED, theirs }), NO_NEW_PLANS);
  assert.equal(status, 0, out);
});

test("the no new plans check refuses a line that no parent's .plans-list holds and the resolution adds", (t) => {
  const resolution = { ".plans-list": "old-plan\nmy-plan\n" };
  const { status, out } = run(conflictedMerge(t, { base: PLANNED, resolution }), NO_NEW_PLANS);
  assert.equal(status, 1, out);
  assert.match(out, /^\.plans-list: my-plan: a line added/m);
});

/* ------------------------------------------------------------------------------ Pointer check */

const STALE_POINTER = "The orders are placed in `src/orders/gone.ts`.\n";

test("the pointer check passes a stale pointer that origin's side brought into the merge unchanged", (t) => {
  const { status, out } = run(conflictedMerge(t, { theirs: { "docs/origin.md": STALE_POINTER } }), POINTER_CHECK);
  assert.equal(status, 0, out);
});

test("the pointer check refuses the same pointer when the resolution writes it", (t) => {
  const merge = conflictedMerge(t, { theirs: { "docs/origin.md": STALE_POINTER }, resolution: { "notes.md": STALE_POINTER } });
  const { status, out } = run(merge, POINTER_CHECK);
  assert.equal(status, 1, out);
  assert.match(out, /^notes\.md:1: `src\/orders\/gone\.ts` resolves to nothing$/m);
  assert.doesNotMatch(out, /docs\/origin\.md/);
});
