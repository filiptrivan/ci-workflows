// Pins the rule that no job runs on `ubuntu-latest`, and that every package a job fetches from npm at
// run time names a version. GitHub moves `ubuntu-latest` to a new Ubuntu on its own schedule
// ("between October 19 and November 19, 2026" for 26.04, its changelog of 2026-09-17, which advises
// "pin your workflows to ubuntu-24.04"); on 2026-11-02 the move broke pa-storefront's Component Gate
// (RS) ("Playwright does not support chromium-headless-shell on ubuntu26.04-x64"). An unversioned
// `npm install -g verdaccio` took Verdaccio 7, which kept spiderly's CI red for five days until
// spiderly 217f0752 (2026-11-02) named `verdaccio@6`. `npx -y` fetches a package just as
// `npm install -g` does.
//
// Two halves: the checker fails on what it exists to catch, then it runs over the workflows here.
//
//   node --test workflow-policy/pins.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { pinProblems } from "./pins.mjs";
import { effectiveWorkflows } from "./workflows.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = fileURLToPath(new URL("./pins.mjs", import.meta.url));

/** spiderly's unit-test job, its steps cut to the ones the rule reads. */
const LATEST = `
name: CI

jobs:
  unit:
    name: Unit Tests (.NET)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v6
      - run: dotnet test -c Release
`;

/* --------------------------------------------------- the checker fails when it should */

test("a job on ubuntu-latest is caught, naming its workflow, job and line", () => {
  assert.deepEqual(pinProblems([{ name: "test.yml", text: LATEST }]), ["test.yml: job `unit` runs on ubuntu-latest (line 7); name a version, ubuntu-24.04"]);
});

/** spiderly's Verdaccio step as it stood before `verdaccio@6`, on a versioned runner. */
const GLOBAL_INSTALL = `
jobs:
  integration-test:
    name: Test CLI Generated Application
    runs-on: ubuntu-24.04
    steps:
      - name: Setup Verdaccio and publish spiderly package
        run: |
          npm install -g verdaccio

          verdaccio --config ~/.config/verdaccio/config.yaml &
`;

test("an npm install -g with no version is caught, naming the package", () => {
  assert.deepEqual(pinProblems([{ name: "ci.yml", text: GLOBAL_INSTALL }]), [
    "ci.yml: job `integration-test` installs verdaccio globally with no version (line 9); name one, verdaccio@<version>",
  ]);
});

/** spiderly's Playwright config as its CI wrote it before `serve@14.2.6`, a heredoc in a `run:` block. */
const NPX_IN_HEREDOC = `
jobs:
  integration-test:
    runs-on: ubuntu-24.04
    steps:
      - name: Create Playwright config
        run: |
          cat > "$FRONTEND_PATH/playwright.config.ts" <<'PLAYWRIGHTCONFIG'
          export default defineConfig({
            webServer: [
              {
                command: 'npx -y serve dist/\${{ env.TEST_APP_NAME }}/browser -l 4200 -s',
                url: 'http://localhost:4200',
              },
            ],
          });
          PLAYWRIGHTCONFIG
`;

test("an npx -y with no version is caught wherever its line stands, a heredoc's included", () => {
  assert.deepEqual(pinProblems([{ name: "ci.yml", text: NPX_IN_HEREDOC }]), [
    "ci.yml: job `integration-test` runs serve through npx -y with no version (line 12); name one, serve@<version>",
  ]);
});

/** A job on a versioned runner whose one step runs `command`, written on line 6. */
const running = (command) => `
jobs:
  tools:
    runs-on: ubuntu-24.04
    steps:
      - run: ${command}
`;

const VERDACCIO = "installs verdaccio globally with no version (line 6); name one, verdaccio@<version>";

for (const [form, command, problem] of [
  ["npm's `i` alias", "npm i -g verdaccio", VERDACCIO],
  ["--global, after the package", "npm install verdaccio --global", VERDACCIO],
  ["--location=global", "npm install --location=global verdaccio", VERDACCIO],
  ["an option's value before install", "npm --prefix tools install -g verdaccio", VERDACCIO],
  ["a scoped package", "npm install -g @anthropic-ai/claude-code", "installs @anthropic-ai/claude-code globally with no version (line 6); name one, @anthropic-ai/claude-code@<version>"],
  ["quoted", `npm install -g "verdaccio"`, VERDACCIO],
  ["npm's latest tag, which names no version", "npm install -g verdaccio@latest", "installs verdaccio@latest globally with no version (line 6); name one, verdaccio@<version>"],
  ["the second of two packages", "npm install -g typescript@5.9.3 verdaccio", VERDACCIO],
  ["the second command on the line", "npm ci && npm install -g verdaccio", VERDACCIO],
  ["a line continued onto the next", "npm install -g \\\n          verdaccio", VERDACCIO],
  ["--yes", "npx --yes serve dist -l 4200", "runs serve through npx -y with no version (line 6); name one, serve@<version>"],
  ["--package, its command a binary of it", "npx -y --package @angular/cli ng new app", "runs @angular/cli through npx -y with no version (line 6); name one, @angular/cli@<version>"],
]) {
  test(`an unversioned global package is caught written as ${form}`, () => {
    assert.deepEqual(pinProblems([{ name: "tools.yml", text: running(command) }]), [`tools.yml: job \`tools\` ${problem}`]);
  });
}

test("a job that names ubuntu-latest through its matrix is caught at that line", () => {
  const text = LATEST.replace("    runs-on: ubuntu-latest\n", "    strategy:\n      matrix:\n        os: [ubuntu-latest, ubuntu-slim]\n    runs-on: ${{ matrix.os }}\n");
  assert.deepEqual(pinProblems([{ name: "test.yml", text }]), ["test.yml: job `unit` runs on ubuntu-latest (line 9); name a version, ubuntu-24.04"]);
});

test("a runs-on written after the job's steps is caught too", () => {
  const text = LATEST.replace("    runs-on: ubuntu-latest\n", "").replace("dotnet test -c Release\n", "dotnet test -c Release\n    runs-on: ubuntu-latest\n");
  assert.deepEqual(pinProblems([{ name: "test.yml", text }]), ["test.yml: job `unit` runs on ubuntu-latest (line 11); name a version, ubuntu-24.04"]);
});

test("slim, versioned images, versioned packages, local binaries and comments pass, as the seven repos write them", () => {
  const text = `
jobs:
  slim:
    # ubuntu-latest moved to 26.04; this job stays on slim
    runs-on: ubuntu-slim
    timeout-minutes: 5
    steps:
      - run: npm install -g verdaccio@6 # not npm install -g verdaccio
      - run: npm install -g @anthropic-ai/claude-code@2.1.316
      - run: npx --yes bats@1.12.0 deploy/test
      - run: npx playwright install --with-deps --only-shell chromium
      - run: npx vercel@54.0.0 alias set "$host" master.preview.prodavnicaalata.rs
      - run: npm install && npm ci && pnpm install --frozen-lockfile
      - run: npm install -g --prefix tools typescript@5.9.3 "$TOOL" ./local-tool
  arm:
    runs-on: ubuntu-24.04-arm
    steps:
      - run: |
          command: 'npx -y serve@14.2.6 dist/\${{ env.TEST_APP_NAME }}/browser -l 4200 -s',
  versioned:
    runs-on: ubuntu-24.04
    steps:
      - run: npx -y --package @angular/cli@19 ng new app
      - name: No job on ubuntu-latest, no unversioned npm package
        run: |
          echo "ubuntu-latest moved to 26.04"
    timeout-minutes: 5
`;
  assert.deepEqual(pinProblems([{ name: "ok.yml", text }]), []);
});

/* ------------------------------- the command another repo's step runs, over its workflows */

/** `node pins.mjs …args`'s exit code and output. */
function runPins(...args) {
  const run = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: run.status, output: run.stdout + run.stderr };
}

test("the command reads a tree's workflows with their pending patch applied, failing one that moves a job to ubuntu-latest", () => {
  const repo = mkdtempSync(join(tmpdir(), "pins-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    const workflow = join(repo, ".github/workflows/test.yml");
    mkdirSync(dirname(workflow), { recursive: true });
    writeFileSync(workflow, LATEST.replace("ubuntu-latest", "ubuntu-24.04"));
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "the workflow");
    assert.deepEqual(runPins("--root", repo), { status: 0, output: "pins: no job runs on ubuntu-latest or fetches an npm package with no version (1 workflow)\n" });

    writeFileSync(workflow, LATEST);
    mkdirSync(join(repo, ".afk/workflows"), { recursive: true });
    writeFileSync(join(repo, ".afk/workflows/test.yml.patch"), git("diff", "HEAD", "--", ".github/workflows/test.yml"));
    git("checkout", "--", ".github/workflows/test.yml");

    assert.deepEqual(runPins("--root", repo), { status: 1, output: "test.yml: job `unit` runs on ubuntu-latest (line 7); name a version, ubuntu-24.04\npins: 1 problem\n" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the command fails a root with no workflow to read, so a wrong --root never passes", () => {
  const empty = mkdtempSync(join(tmpdir(), "pins-"));
  try {
    assert.deepEqual(runPins("--root", empty), { status: 1, output: `pins: no workflow read under ${join(empty, ".github/workflows")}, so nothing was checked\n` });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

/* ---------------------------------------- and the workflows here, as they take effect */

test("every workflow here, with its pending patch applied, keeps the pin rule", () => {
  const workflows = effectiveWorkflows(ROOT);
  assert.ok(workflows.some(({ name }) => name === "test.yml"), "the workflow directory was not read");
  assert.deepEqual(pinProblems(workflows), []);
  assert.equal(runPins("--root", ROOT).status, 0);
});
