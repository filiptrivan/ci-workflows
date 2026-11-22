// Pins the file-and-name pointer at the pointer check's CLI: which pairs of a file and a name it
// reads, how it judges them, and that a failure is report-only until the repo's settings turn it on.
//
//   node --test pointer-check/file-and-name.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "pointer-check.mjs");

// A real git repo, because "tracked" is what the check resolves against.
function repo(files, parent = mkdtempSync(join(tmpdir(), "file-and-name-")), name = "repo") {
  const dir = join(parent, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function check(dir) {
  const run = spawnSync("node", [CLI], { cwd: dir, encoding: "utf8" });
  const lines = run.stdout.split("\n").filter((line) => line.length > 0 && !line.startsWith("pointer-check:"));
  return { status: run.status, lines, stdout: run.stdout };
}

// The deploy-watch files of the known stale cases, as they stood before their fixes.
const DEPLOY_WATCH = {
  "scripts/deploy-watch/push-subagent-reports.mjs":
    "export function outcomeOf(report) { return report.outcome; }\nexport function waitsOnOther(report) { return report.waits; }\n",
  "scripts/deploy-watch/push-subagent.mjs":
    'import { outcomeOf } from "./push-subagent-reports.mjs";\n// waitsOnOther moved out.\nexport function startSubagent(report) { return outcomeOf(report); }\n',
  "scripts/deploy-watch/pre-push-checks.mjs": "export async function runPrePushChecks() {}\n",
  "scripts/deploy-watch/prepare.mjs": 'import * as checks from "./pre-push-checks.mjs";\nexport const terraform = () => checks;\n',
  "scripts/prepare-add-products/prepare.mjs": "export function prepareCard() {}\n",
  "scripts/deploy-watch/push-status-waits.mjs": "export function reviewHolds(batch) { return batch.held; }\n",
  "scripts/deploy-watch/pre-push-checks-and-review.mjs":
    'import { reviewHolds } from "./push-status-waits.mjs";\nexport function judge(batch) { return reviewHolds(batch); }\n',
};

test("each of the umbrella's known stale cases is reported with its line and the file that holds the name", () => {
  const dir = repo({
    ...DEPLOY_WATCH,
    "scripts/deploy-watch/watch.mjs": [
      "// The outcome is push-subagent.mjs `outcomeOf`, and the wait",
      "// push-subagent.mjs `waitsOnOther`.",
      "// The checks run in prepare.mjs `runPrePushChecks`.",
      "// The review waits on pre-push-checks-and-review.mjs `reviewHolds`.",
      "export const watch = 1;",
      "",
    ].join("\n"),
  });
  const result = check(dir);
  assert.deepEqual(result.lines, [
    "scripts/deploy-watch/watch.mjs:1: push-subagent.mjs `outcomeOf`: scripts/deploy-watch/push-subagent.mjs imports it from scripts/deploy-watch/push-subagent-reports.mjs (report only)",
    "scripts/deploy-watch/watch.mjs:2: push-subagent.mjs `waitsOnOther`: scripts/deploy-watch/push-subagent.mjs never names it in code; scripts/deploy-watch/push-subagent-reports.mjs declares it (report only)",
    "scripts/deploy-watch/watch.mjs:3: prepare.mjs `runPrePushChecks`: scripts/deploy-watch/prepare.mjs never names it in code; scripts/deploy-watch/pre-push-checks.mjs declares it (report only)",
    "scripts/deploy-watch/watch.mjs:4: pre-push-checks-and-review.mjs `reviewHolds`: scripts/deploy-watch/pre-push-checks-and-review.mjs imports it from scripts/deploy-watch/push-status-waits.mjs (report only)",
  ]);
  assert.equal(result.status, 0);
});

test("a workspace package's path maps through its name and exports, and a pointer wrapped over two lines is read", () => {
  const dir = repo({
    "packages/shared/package.json": JSON.stringify({ name: "@pa/shared", exports: { "./*": "./src/*" } }),
    "packages/ui/package.json": JSON.stringify({
      name: "@pa/ui",
      exports: { "./*": { types: ["./src/*.ts", "./src/*/index.ts"], default: "./src/*" } },
    }),
    "packages/ui/src/button.ts": "export const button = 1;\n",
    "packages/ui/src/size.ts": "export const buttonSize = 1;\n",
    "packages/shared/src/dictionary/base.ts": 'import { product } from "./base/product";\nexport const base = { ...product };\n',
    "packages/shared/src/dictionary/base/product.ts":
      "const variantPlaceholderByKind = {};\nexport const product = { variantPlaceholderByKind };\n",
    "apps/rs/src/variant.ts": [
      "// The placeholder comes from `variantPlaceholderByKind` in",
      "// @pa/shared/dictionary/base.ts, and the base from `base` in @pa/shared/dictionary/base.ts.",
      "// The size is `buttonSize` at @pa/ui/button.ts, and the button is `button` in @pa/ui/button.ts.",
      "export const variant = 1;",
      "",
    ].join("\n"),
    "docs/variants.md": "Each placeholder is\n`variantPlaceholderByKind` in `@pa/shared/dictionary/base.ts`.\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, [
    "apps/rs/src/variant.ts:1: @pa/shared/dictionary/base.ts `variantPlaceholderByKind`: packages/shared/src/dictionary/base.ts never names it in code; packages/shared/src/dictionary/base/product.ts declares it (report only)",
    "apps/rs/src/variant.ts:3: @pa/ui/button.ts `buttonSize`: packages/ui/src/button.ts never names it in code; packages/ui/src/size.ts declares it (report only)",
    "docs/variants.md:2: `@pa/shared/dictionary/base.ts` `variantPlaceholderByKind`: packages/shared/src/dictionary/base.ts never names it in code; packages/shared/src/dictionary/base/product.ts declares it (report only)",
  ]);
});

test("the four steps hold in their order: a declaration or export, then an import, then a use, then a declaration elsewhere", () => {
  const dir = repo({
    "src/held.mjs": "export function held() {}\nexport const kept = 1;\n",
    "src/entry.mjs": [
      'import { held, kept } from "./held.mjs";',
      'export { kept } from "./held.mjs";',
      'export * from "./more.mjs";',
      "function own() {}",
      "export const run = () => held() + own() + kept;",
      'const label = "usedOnlyHere";',
      "",
    ].join("\n"),
    "src/more.mjs": "export function deeper() {}\n",
    "src/other.mjs": "export function elsewhere() {}\n",
    "docs/guide.md": [
      "Declared: entry.mjs `own`. Exported: entry.mjs `kept`. Re-exported: entry.mjs `deeper`.",
      "Imported and called: entry.mjs `held`.",
      "Used in a string: entry.mjs `usedOnlyHere`.",
      "Declared elsewhere: entry.mjs `elsewhere`. Declared nowhere: entry.mjs `nowhere`.",
      "",
    ].join("\n"),
  });
  const result = check(dir);
  assert.deepEqual(result.lines, [
    "docs/guide.md:2: entry.mjs `held`: src/entry.mjs imports it from src/held.mjs (report only)",
    "docs/guide.md:4: entry.mjs `elsewhere`: src/entry.mjs never names it in code; src/other.mjs declares it (report only)",
  ]);
});

test("a name only the file's comment names is not in use", () => {
  const dir = repo({
    "src/a.mjs": "// helper lives elsewhere now\nexport const a = 1;\n",
    "src/b.mjs": "export function helper() {}\n",
    "README.md": "See a.mjs `helper`.\n",
  });
  assert.deepEqual(check(dir).lines, [
    "README.md:1: a.mjs `helper`: src/a.mjs never names it in code; src/b.mjs declares it (report only)",
  ]);
});

test("an aliased import imports neither name, and the file's own declaration resolves", () => {
  const dir = repo({
    "scripts/agent-box/whats-waiting/read.mjs": "export function readWaiting() {}\n",
    "scripts/deploy-watch/call-listing.mjs": [
      'import { readWaiting as readGitHub } from "../agent-box/whats-waiting/read.mjs";',
      "export function readWaiting() { return readGitHub(); }",
      "",
    ].join("\n"),
    "scripts/deploy-watch/notes.mjs": "// The listing reads call-listing.mjs `readWaiting`.\nexport const notes = 1;\n",
  });
  assert.deepEqual(check(dir).lines, []);
});

test("an arrow, a parenthesis, a from, or out of before the pair is not a file-and-name pointer", () => {
  const dir = repo({
    "apps/rs/server.ts": "export const server = 1;\n",
    "apps/rs/cache.ts": "export function cachedFetch() {}\n",
    "scripts/part.mjs": "// Each part has `held`.\nexport const part = 1;\n",
    "scripts/kept.mjs": "export const held = 1;\n",
    "scripts/layout.mjs": "export function cronStartsFile() {}\n",
    "scripts/ship-storefront.mjs": "export const ship = 1;\n",
    "scripts/env.mjs": "export const storefrontDeployEnv = 1;\n",
    "scripts/deploy-watch/prepare.mjs": "export const rows = [];\n",
    "scripts/deploy-watch/terraform.mjs": "export const terraform = 1;\n",
    "scripts/deploy-watch/notes.mjs": [
      "// A call runs `server.ts` → `cachedFetch`, and part.mjs → `held` names a member.",
      "// It takes `home` (layout.mjs `cronStartsFile`) and `storefrontDeployEnv`, from ship-storefront.mjs.",
      "// Moved 2026-10-28 out of prepare.mjs's `terraform` row.",
      "// The row moved out of",
      "// prepare.mjs `terraform` on the same day.",
      "export const notes = 1;",
      "",
    ].join("\n"),
  });
  assert.deepEqual(check(dir).lines, []);
});

test("the half after a parenthesis is still a pointer", () => {
  const dir = repo({
    "scripts/layout.mjs": "export const layout = 1;\n",
    "scripts/starts.mjs": "export function cronStartsFile() {}\n",
    "scripts/notes.mjs": "// It takes `home` (layout.mjs `cronStartsFile`).\nexport const notes = 1;\n",
  });
  assert.deepEqual(check(dir).lines, [
    "scripts/notes.mjs:1: layout.mjs `cronStartsFile`: scripts/layout.mjs never names it in code; scripts/starts.mjs declares it (report only)",
  ]);
});

test("a bare file name several files share takes the match nearest the commenting file, and none is skipped", () => {
  const dir = repo({
    ...DEPLOY_WATCH,
    "scripts/deploy-watch/push/notes.mjs": "// prepare.mjs `prepareCard` prepares a card.\nexport const notes = 1;\n",
    "scripts/prepare-add-products/notes.mjs": "// prepare.mjs `prepareCard` prepares a card.\nexport const notes = 1;\n",
    "scripts/notes.mjs": "// prepare.mjs `prepareCard` prepares a card.\nexport const notes = 1;\n",
  });
  assert.deepEqual(check(dir).lines, [
    "scripts/deploy-watch/push/notes.mjs:1: prepare.mjs `prepareCard`: scripts/deploy-watch/prepare.mjs never names it in code; scripts/prepare-add-products/prepare.mjs declares it (report only)",
  ]);
});

test("a backticked path and a possessive file name are read; a file whose language holds no names is not", () => {
  const dir = repo({
    "scripts/agent-box/whats-waiting.mjs": "export const MINE = 1;\n",
    "scripts/deploy-watch/prepare.mjs": "export const rows = [];\n",
    "scripts/deploy-watch/terraform.mjs": "export const terraform = 1;\n",
    "docs/guide.md": [
      "Mine is `scripts/agent-box/whats-waiting.mjs` `MINE`; the row is prepare.mjs's `terraform`.",
      "The settings are package.json `scripts`.",
      "",
    ].join("\n"),
    "package.json": "{}\n",
  });
  assert.deepEqual(check(dir).lines, [
    "docs/guide.md:1: prepare.mjs `terraform`: scripts/deploy-watch/prepare.mjs never names it in code; scripts/deploy-watch/terraform.mjs declares it (report only)",
  ]);
});

test("a sibling's file is judged in that sibling, and skipped when the sibling is absent", () => {
  const parent = mkdtempSync(join(tmpdir(), "file-and-name-"));
  repo(
    {
      "Backend/Orders.mjs": "export const orders = 1;\n",
      "Backend/Placed.mjs": "export function placeOrder() {}\n",
    },
    parent,
    "pa-cms",
  );
  const settings = { ".pointer-check.jsonc": '{ "siblings": { "pa-cms": "../pa-cms", "pa-storefront": "../pa-storefront" } }\n' };
  const dir = repo(
    {
      ...settings,
      "README.md": "Orders: pa-cms/Backend/Orders.mjs `placeOrder`, pa-storefront/app/cart.ts `addToCart`.\n",
    },
    parent,
  );
  assert.deepEqual(check(dir).lines, [
    "README.md:1: pa-cms/Backend/Orders.mjs `placeOrder`: Backend/Orders.mjs never names it in code; Backend/Placed.mjs declares it (report only)",
  ]);
});

test("report-only never changes the exit code; the repo's failFileAndNamePointers makes the form fail", () => {
  const files = {
    "src/a.mjs": "export const a = 1;\n",
    "src/b.mjs": "export function helper() {}\n",
    "README.md": "See a.mjs `helper`.\n",
  };
  const reported = check(repo(files));
  assert.equal(reported.status, 0);
  assert.match(reported.stdout, /1 failing pointer in 1 file \(report only\)/);
  const failing = check(repo({ ...files, ".pointer-check.jsonc": '{ "failFileAndNamePointers": true }\n' }));
  assert.deepEqual(failing.lines, ["README.md:1: a.mjs `helper`: src/a.mjs never names it in code; src/b.mjs declares it"]);
  assert.equal(failing.status, 1);
});

test("a name several files declare at their top gives no home and is skipped; a function's local is no home", () => {
  const dir = repo({
    "scripts/run.mjs": "export const run = 1;\n",
    "scripts/cli-a.mjs": "const args = process.argv.slice(2);\nexport const a = args;\n",
    "scripts/cli-b.mjs": "const args = process.argv.slice(2);\nexport const b = args;\n",
    "scripts/shape.mjs": "export function shape() {\n  const at = 1;\n  return at;\n}\n",
    "README.md": "Called with run.mjs `args`, read at run.mjs `at`.\n",
  });
  assert.deepEqual(check(dir).lines, []);
});
