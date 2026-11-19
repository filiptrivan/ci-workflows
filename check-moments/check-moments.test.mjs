// Pins which Pre-push checks each moment runs (check-moments.mjs): one table, in memory, over a
// manifest with fast and slow checks and changed paths that reach some checks and not others.
//
//   node --test check-moments/check-moments.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checksAt, commandAt, MOMENTS } from "./check-moments.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "check-moments.mjs");

const MANIFEST = {
  checks: [
    { name: "backend", command: "lane_backend", reaches: ["^Backend/"], hook: true, fast: false, docker: true, track: ".NET" },
    { name: "admin", command: "lane_admin", reaches: ["^Frontend/"], hook: true, fast: false },
    { name: "contract", command: "run_contract", reaches: ["^Backend/"], fast: false },
    { name: "size cap", commands: { commit: "size --staged", push: "size --base origin/main" }, fast: true, ciWorkflows: true },
    { name: "pointer check", commands: { commit: "pointers --staged" }, fast: true },
    { name: "probe", command: "probe", reaches: ["^Backend/[^/]+$"], fast: true },
  ],
};

const BACKEND = ["Backend/Business/Order.cs"];
const BACKEND_ROOT = ["Backend/Directory.Build.props"];
const DOCS = ["docs/readme.md"];

test("each moment runs the checks the table names, each with its command for that moment, in the manifest's order", () => {
  const rows = [
    ["factory-commit", DOCS, ["size cap: size --staged", "pointer check: pointers --staged"]],
    ["factory-commit", BACKEND_ROOT, ["size cap: size --staged", "pointer check: pointers --staged", "probe: probe"]],
    ["commit", DOCS, ["size cap: size --staged", "pointer check: pointers --staged"]],
    ["commit", BACKEND, ["backend: lane_backend", "size cap: size --staged", "pointer check: pointers --staged"]],
    ["commit", BACKEND_ROOT, ["backend: lane_backend", "size cap: size --staged", "pointer check: pointers --staged", "probe: probe"]],
    ["commit", ["Frontend/a.ts", ...BACKEND], ["backend: lane_backend", "admin: lane_admin", "size cap: size --staged", "pointer check: pointers --staged"]],
    ["close", DOCS, []],
    ["close", BACKEND, ["backend: lane_backend"]],
    ["close", ["Frontend/a.ts"], ["admin: lane_admin"]],
    ["push", DOCS, ["size cap: size --base origin/main"]],
    ["push", BACKEND, ["backend: lane_backend", "contract: run_contract", "size cap: size --base origin/main"]],
    ["push", BACKEND_ROOT, ["backend: lane_backend", "contract: run_contract", "size cap: size --base origin/main", "probe: probe"]],
  ];
  for (const [moment, paths, expected] of rows) {
    const got = checksAt(MANIFEST, moment, paths).map(({ name, command }) => `${name}: ${command}`);
    assert.deepEqual(got, expected, `${moment} on ${paths.join(" ")}`);
  }
});

test("a check keeps its other fields, and one with no `fast` is slow", () => {
  const [backend] = checksAt(MANIFEST, "close", BACKEND);
  assert.deepEqual(backend, { ...MANIFEST.checks[0] });
  const unmarked = { checks: [{ name: "old", command: "old", hook: true }] };
  assert.deepEqual(checksAt(unmarked, "factory-commit", DOCS), []);
  assert.deepEqual(checksAt(unmarked, "close", DOCS).map(({ name }) => name), ["old"]);
});

test("commandAt gives a check's one command at every moment, or the command it names for that moment, else null", () => {
  assert.equal(commandAt({ command: "x" }, "close"), "x");
  assert.equal(commandAt({ commands: { commit: "c" } }, "factory-commit"), "c");
  assert.equal(commandAt({ commands: { commit: "c" } }, "push"), null);
  assert.throws(() => commandAt({ command: "x" }, "lunch"), /no moment lunch; the moments are factory-commit, commit, close, push/);
  assert.deepEqual(MOMENTS, ["factory-commit", "commit", "close", "push"]);
});

test("the CLI prints each check of a moment as one line of fields split by the unit separator, from the manifest it names and the paths on stdin", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "check-moments-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(MANIFEST));
  const { status, stdout, stderr } = spawnSync("node", [CLI, "--moment", "commit", "--manifest", join(dir, "manifest.json")], {
    input: `${BACKEND.join("\n")}\n`,
    encoding: "utf8",
  });
  assert.equal(status, 0, stderr);
  assert.deepEqual(stdout.split("\n").filter(Boolean).map((line) => line.split("\x1f")), [
    ["backend", "false", "true", ".NET", "false", "lane_backend"],
    ["size cap", "true", "false", "", "true", "size --staged"],
    ["pointer check", "true", "false", "", "false", "pointers --staged"],
  ]);
});
