// Pins the rule every `ubuntu-slim` job keeps. GitHub runs that runner "inside a container rather
// than a full VM instance", unprivileged and with no Docker-in-Docker, and "The job timeout for
// single-CPU runners is 15 minutes", after which the job is terminated and fails (GitHub's
// GitHub-hosted runners reference, read 2026-10-30). So a slim job names no `docker` and sets a
// `timeout-minutes` of 15 or less.
//
// Two halves: the checker fails on what it exists to catch, then it runs over the workflows here.
//
//   node --test workflow-policy/slim-jobs.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { effectiveWorkflows, slimJobProblems } from "./slim-jobs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A workflow lint job moved onto slim, its lint still run through `docker run`. */
const SLIM_DOCKER = `
jobs:
  actionlint:
    name: actionlint
    runs-on: ubuntu-slim
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - name: Lint every workflow
        run: |
          docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color
`;

/* --------------------------------------------------- the checker fails when it should */

test("a slim job that runs docker is caught, naming its workflow and job", () => {
  const problems = slimJobProblems([{ name: "workflow-lint.yml", text: SLIM_DOCKER }]);
  assert.deepEqual(problems, ["workflow-lint.yml: job `actionlint` runs on ubuntu-slim but names docker (line 11), which slim does not have"]);
});

/** The pointer check's job on slim, its `timeout-minutes` left out. */
const SLIM_UNTIMED = `
jobs:
  pointers:
    name: pointer check
    runs-on: ubuntu-slim
    permissions:
      contents: read

    steps:
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: 22

      - name: Check every pointer in prose
        timeout-minutes: 3
        run: node checker/pointer-check/pointer-check.mjs --root repo
`;

test("a slim job with no timeout-minutes of its own is caught, a step's timeout not counting", () => {
  const problems = slimJobProblems([{ name: "pointer-check.yml", text: SLIM_UNTIMED }]);
  assert.deepEqual(problems, ["pointer-check.yml: job `pointers` runs on ubuntu-slim with no timeout-minutes; slim terminates a job at 15 minutes, so it sets 15 or less"]);
  assert.deepEqual(slimJobProblems([{ name: "pointer-check.yml", text: SLIM_UNTIMED.replaceAll("\n", "\r\n") }]), problems, "a file checked out with CRLF reads the same");
});

test("a slim job whose timeout-minutes is past 15, or not a number, is caught, and 15 itself passes", () => {
  const timed = (minutes) => SLIM_UNTIMED.replace("    runs-on: ubuntu-slim\n", `    runs-on: ubuntu-slim\n    timeout-minutes: ${minutes}\n`);
  assert.deepEqual(slimJobProblems([{ name: "pointer-check.yml", text: timed(20) }]), [
    "pointer-check.yml: job `pointers` runs on ubuntu-slim with timeout-minutes 20; slim terminates a job at 15 minutes, so it sets 15 or less",
  ]);
  assert.deepEqual(slimJobProblems([{ name: "pointer-check.yml", text: timed("${{ inputs.minutes }}") }]), [
    "pointer-check.yml: job `pointers` runs on ubuntu-slim with timeout-minutes ${{ inputs.minutes }}; slim terminates a job at 15 minutes, so it sets 15 or less",
  ]);
  assert.deepEqual(slimJobProblems([{ name: "pointer-check.yml", text: timed(15) }]), []);
  assert.deepEqual(slimJobProblems([{ name: "pointer-check.yml", text: timed('"10"') }]), [], "a quoted number is its number");
});

test("a job that names slim through its matrix is held to the rule too", () => {
  const text = SLIM_UNTIMED.replace("    runs-on: ubuntu-slim\n", "    strategy:\n      matrix:\n        os: [ubuntu-latest, ubuntu-slim]\n    runs-on: ${{ matrix.os }}\n");
  assert.deepEqual(slimJobProblems([{ name: "pointer-check.yml", text }]), [
    "pointer-check.yml: job `pointers` runs on ubuntu-slim with no timeout-minutes; slim terminates a job at 15 minutes, so it sets 15 or less",
  ]);
});

test("docker in a comment, or in a job off slim, passes, and the slim job beside it is read alone", () => {
  const text = `${SLIM_DOCKER.replace("ubuntu-slim", "ubuntu-latest")}
  pointers:
    # ubuntu-slim: a thin job, no Docker, done in a minute
    runs-on:
      - ubuntu-slim
    timeout-minutes: 5
    steps:
      - run: node check.mjs # not docker
`;
  assert.deepEqual(slimJobProblems([{ name: "lint.yml", text }]), []);
  assert.deepEqual(slimJobProblems([{ name: "lint.yml", text: text.replace("- ubuntu-slim\n    timeout-minutes: 5\n", "- ubuntu-slim\n") }]), [
    "lint.yml: job `pointers` runs on ubuntu-slim with no timeout-minutes; slim terminates a job at 15 minutes, so it sets 15 or less",
  ]);
});

/* ---------------------------------------- and the workflows here, as they take effect */

// A workflow edit can wait in the tree as `.afk/workflows/<file>.patch`, `git diff` output against
// the committed workflow, until it is applied and `.afk/` removed. The workflows that run are the
// patched ones, so the rule reads those.
test("a workflow's pending patch is applied before the rule reads it", () => {
  const repo = mkdtempSync(join(tmpdir(), "slim-jobs-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const workflow = join(repo, ".github/workflows/pointer-check.yml");
  const committed = SLIM_UNTIMED.replace("ubuntu-slim", "ubuntu-latest").replace("    permissions:", "    timeout-minutes: 5\n    permissions:");
  mkdirSync(dirname(workflow), { recursive: true });
  writeFileSync(workflow, committed);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "the workflow");
  assert.deepEqual(slimJobProblems(effectiveWorkflows(repo)), []);

  writeFileSync(workflow, SLIM_UNTIMED.replace("ubuntu-slim", "ubuntu-slim # thin"));
  mkdirSync(join(repo, ".afk/workflows"), { recursive: true });
  writeFileSync(join(repo, ".afk/workflows/pointer-check.yml.patch"), git("diff", "HEAD", "--", ".github/workflows/pointer-check.yml"));
  git("checkout", "--", ".github/workflows/pointer-check.yml");

  assert.equal(readFileSync(workflow, "utf8"), committed, "the committed workflow is left as it was");
  assert.deepEqual(slimJobProblems(effectiveWorkflows(repo)), [
    "pointer-check.yml: job `pointers` runs on ubuntu-slim with no timeout-minutes; slim terminates a job at 15 minutes, so it sets 15 or less",
  ]);
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    assert.deepEqual(effectiveWorkflows("."), effectiveWorkflows(repo), "a root given relative reads the same");
  } finally {
    process.chdir(cwd);
  }
});

test("every workflow here, with its pending patch applied, keeps the slim rule", () => {
  const workflows = effectiveWorkflows(ROOT);
  assert.ok(workflows.some(({ name }) => name === "pointer-check.yml"), "the workflow directory was not read");
  assert.ok(workflows.some(({ text }) => /^\s*runs-on: ubuntu-slim\b/m.test(text)), "no job here runs on ubuntu-slim, so the rule checked nothing");
  assert.deepEqual(slimJobProblems(workflows), []);
});
