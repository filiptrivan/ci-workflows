// Pins the No new plans check at its CLI, run as a pre-commit hook (`--staged`) and CI (whole-tree
// mode) run it: each test builds a real git repo in a temp folder and asserts only the exit code and
// the printed text.
//
//   node --test no-new-plans/no-new-plans.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "no-new-plans.mjs");

const git = (dir, ...args) =>
  execFileSync("git", ["-c", "user.name=Check", "-c", "user.email=check@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  }).trim();

/** Writes `files` into `dir` and stages them; a null content deletes its file. */
function stage(dir, files) {
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
function repo(t, head, staged = {}) {
  const dir = mkdtempSync(join(tmpdir(), "no-new-plans-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  stage(dir, { "README.md": "a repo\n", ...head });
  git(dir, "commit", "-q", "--no-verify", "-m", "the tree before this commit");
  stage(dir, staged);
  return dir;
}

function run(dir, ...args) {
  const { status, stdout, stderr } = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8" });
  return { status, output: stdout + stderr };
}

const LISTED = { ".plans-list": "old-plan\nsplit-plan\n", "docs/plans/old-plan.md": "old\n", "docs/plans/split-plan.md": "index\n" };

test("--staged refuses a new plan, naming the path and where its content goes", (t) => {
  const { status, output } = run(repo(t, LISTED, { "docs/plans/new-plan.md": "new\n" }), "--staged");
  assert.equal(status, 1);
  assert.match(output, /docs\/plans\/new-plan\.md/);
  assert.match(output, /ADR/);
  assert.match(output, /docs\/audits/);
});

test("--staged refuses a new file in a folder of its own, not only a top-level one", (t) => {
  const { status } = run(repo(t, LISTED, { "docs/plans/new-plan/part.md": "new\n" }), "--staged");
  assert.equal(status, 1);
});

test("--staged passes an edit of a listed plan", (t) => {
  const { status } = run(repo(t, LISTED, { "docs/plans/old-plan.md": "edited\n" }), "--staged");
  assert.equal(status, 0);
});

test("--staged passes a word-for-word split: a new file in the folder beside a listed plan", (t) => {
  const { status } = run(repo(t, LISTED, { "docs/plans/split-plan/decisions.md": "moved\n" }), "--staged");
  assert.equal(status, 0);
});

test("--staged passes a commit that touches no plan", (t) => {
  const { status } = run(repo(t, LISTED, { "src/a.mjs": "a\n" }), "--staged");
  assert.equal(status, 0);
});

test("--staged judges docs/plans at the repo's root only", (t) => {
  const { status } = run(repo(t, LISTED, { "tools/docs/plans/x.md": "x\n" }), "--staged");
  assert.equal(status, 0);
});

test("--staged refuses a line added to the list, even beside its plan", (t) => {
  const { status, output } = run(
    repo(t, LISTED, { ".plans-list": "old-plan\nsplit-plan\nnew-plan\n", "docs/plans/new-plan.md": "new\n" }),
    "--staged",
  );
  assert.equal(status, 1);
  assert.match(output, /line added/);
});

test("--staged passes a line removed from the list with its plan", (t) => {
  const { status } = run(repo(t, LISTED, { ".plans-list": "split-plan\n", "docs/plans/old-plan.md": null }), "--staged");
  assert.equal(status, 0);
});

test("--staged passes the commit that installs the list", (t) => {
  const { status } = run(repo(t, { "docs/plans/old-plan.md": "old\n" }, { ".plans-list": "old-plan\n" }), "--staged");
  assert.equal(status, 0);
});

test("the whole-tree mode refuses a tracked plan the list does not hold, as a --no-verify commit leaves", (t) => {
  const dir = repo(t, { ...LISTED, "docs/plans/new-plan.md": "new\n" });
  const { status, output } = run(dir);
  assert.equal(status, 1);
  assert.match(output, /docs\/plans\/new-plan\.md/);
});

test("the whole-tree mode passes when every plan is listed", (t) => {
  assert.equal(run(repo(t, LISTED)).status, 0);
});

test("the whole-tree mode refuses every plan once the list is deleted", (t) => {
  const dir = repo(t, LISTED, { ".plans-list": null });
  git(dir, "commit", "-q", "--no-verify", "-m", "drop the list");
  assert.equal(run(dir).status, 1);
});

test("--base refuses a line added since the base", (t) => {
  const dir = repo(t, LISTED);
  const base = git(dir, "rev-parse", "HEAD");
  stage(dir, { ".plans-list": "old-plan\nsplit-plan\nnew-plan\n", "docs/plans/new-plan.md": "new\n" });
  git(dir, "commit", "-q", "--no-verify", "-m", "a new plan and its line");
  const { status, output } = run(dir, "--base", base);
  assert.equal(status, 1);
  assert.match(output, /line added/);
});

test("--base exits 2 when it names no commit", (t) => {
  assert.equal(run(repo(t, LISTED), "--base", "no-such-ref").status, 2);
});
