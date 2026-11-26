// Pins the file path pointer at the pointer check's CLI: what a path resolves against, and
// which paths it skips as untracked on purpose.
// What an agent observes is a pointer that resolves or does not, and an exit code that fails CI
// or passes. How a file is parsed is not pinned.
//
//   node --test pointer-check/paths.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { check, repo, writeTree } from "./pointer-check.fixtures.mjs";

test("a path that resolves passes and the run exits zero", () => {
  const dir = repo({
    "src/orders/place-order.ts": "export function placeOrder() {}\n",
    "README.md": "Orders are placed in `src/orders/place-order.ts`.\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, []);
  assert.equal(result.status, 0);
});

test("a path that resolves to nothing fails with its file and line", () => {
  const dir = repo({
    "src/orders/place-order.ts": "export function placeOrder() {}\n",
    "docs/guide.md": "# Guide\n\nOrders are placed in `src/orders/submit-order.ts`.\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, ["docs/guide.md:3: `src/orders/submit-order.ts` resolves to nothing"]);
  assert.equal(result.status, 1);
});

test("a path suffix matching two files resolves to two targets", () => {
  const dir = repo({
    "apps/rs/src/app/page.tsx": "export default function Page() {}\n",
    "apps/ba/src/app/page.tsx": "export default function Page() {}\n",
    "docs/guide.md": "The home page is `src/app/page.tsx`.\nThe RS one is `apps/rs/src/app/page.tsx`.\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, ["docs/guide.md:1: `src/app/page.tsx` resolves to 2 targets"]);
  assert.equal(result.status, 1);
});

test("a directory pointer resolves when a tracked file sits under it", () => {
  const dir = repo({
    "scripts/evals/ledger.mjs": "export const x = 1;\n",
    "docs/guide.md": "Evals live in `scripts/evals/`; the old `scripts/legacy/` is gone.\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, ["docs/guide.md:1: `scripts/legacy/` resolves to nothing"]);
});

test("a Markdown link resolves relative to the file that holds it", () => {
  const dir = repo({
    "docs/adr/0001-one.md": "# 0001. One\n",
    "docs/guide.md": "See [the first](./adr/0001-one.md) and [the gone](./adr/0009-gone.md#context).\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, ["docs/guide.md:1: `./adr/0009-gone.md` resolves to nothing"]);
});

test("a symlinked directory is not scanned twice but can be pointed into", () => {
  const dir = repo({
    ".agents/skills/grill/SKILL.md": "# Grill\n",
    "docs/live.md": "The skill is `.claude/skills/grill/SKILL.md`.\n",
  });
  mkdirSync(join(dir, ".claude/skills"), { recursive: true });
  symlinkSync("../../.agents/skills/grill", join(dir, ".claude/skills/grill"));
  execFileSync("git", ["add", "-A"], { cwd: dir });
  assert.deepEqual(check(dir).lines, []);
});

test("a path the repo ignores names a file that is untracked on purpose and is skipped", () => {
  const dir = repo({
    ".gitignore": "*.local.json\n.secrets/\n",
    "config/base.json": "{}\n",
    "docs/live.md": "Keys go in `config/app.local.json` and `.secrets/token`; `config/app.json` is gone.\n",
  });
  assert.deepEqual(check(dir).lines, ["docs/live.md:1: `config/app.json` resolves to nothing"]);
});

test("a data file named without a real top-level directory is a run's output, not a pointer", () => {
  const dir = repo({
    "data/kept.json": "{}\n",
    "docs/live.md":
      "A run writes `batch.json` and `review/review.json`; the bank sends `EXTRA.CARDBRAND`.\n" +
      "The tracked one is `data/kept.json`; `data/gone.json` is not.\n",
  });
  assert.deepEqual(check(dir).lines, ["docs/live.md:2: `data/gone.json` resolves to nothing"]);
});

test("an ignored directory named with its trailing slash is skipped", () => {
  const dir = repo({
    ".gitignore": "/backups/\n",
    "docs/live.md": "Dumps go to [the backups](../backups/) and `backups/`.\n",
  });
  assert.deepEqual(check(dir).lines, []);
});

test("a module specifier without its extension resolves the way an import does", () => {
  const dir = repo({
    "src/env.ts": "export const env = 1;\n",
    "src/api/index.ts": "export const api = 1;\n",
    "src/a.ts": "// reads `./env` and `./api`, never `./env-private`\nexport const a = 1;\n",
  });
  assert.deepEqual(check(dir).lines, ["src/a.ts:1: `./env-private` resolves to nothing"]);
});

test("a library's compiled file named where it bites is an outside fact, not a pointer", () => {
  const dir = repo({
    "src/a.ts":
      "// Next's `get-img-props.js` and `dist/client/script.js` decide this; so does\n" +
      "// `getHash([VERSION, href, width])`, Meta's `fbevents.js` too.\nexport const a = 1;\n",
  });
  assert.deepEqual(check(dir).lines, []);
});

test("an extension is matched as written, so a member called `Sql` is not a .sql file", () => {
  const dir = repo({
    "src/Migration.cs": "public class Migration { void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql(\"\"); }\n",
    "docs/live.md": "Raw SQL goes through `migrationBuilder.Sql`, never `schema.sql`.\n",
  });
  assert.deepEqual(check(dir).lines, ["docs/live.md:1: `schema.sql` resolves to nothing"]);
});

test("a dot-led name is a file-name suffix too, so `.spec.ts` names a kind of file", () => {
  const dir = repo({
    "src/cart.spec.ts": "export {};\n",
    "src/.postcssrc.json": "{}\n",
    "docs/live.md": "Specs end in `.spec.ts`; the config is `.postcssrc.json`; `.e2e.ts` matches nothing.\n",
  });
  assert.deepEqual(check(dir).lines, ["docs/live.md:1: `.e2e.ts` resolves to nothing"]);
});

test("an ignored path through a symlinked directory is skipped and does not sink the others", () => {
  const dir = repo({
    ".gitignore": "node_modules/\n*.local.json\n",
    "config/base.json": "{}\n",
    "docs/live.md":
      "Next documents it in `node_modules/next/dist/docs/caching.md`; keys go in `config/app.local.json`;\n" +
      "`docs/gone.md` is gone.\n",
  });
  mkdirSync(join(dir, "node_modules/.pnpm/next/dist/docs"), { recursive: true });
  writeFileSync(join(dir, "node_modules/.pnpm/next/dist/docs/caching.md"), "# Caching\n");
  symlinkSync(".pnpm/next", join(dir, "node_modules/next"));
  assert.deepEqual(check(dir).lines, ["docs/live.md:2: `docs/gone.md` resolves to nothing"]);
});

test("a path into an ignored directory that is itself a symlink, as a worktree's node_modules is, is skipped", () => {
  const outside = mkdtempSync(join(tmpdir(), "pointer-check-modules-"));
  mkdirSync(join(outside, "spiderly/docs"), { recursive: true });
  writeFileSync(join(outside, "spiderly/docs/index.md"), "# Docs\n");
  const dir = repo({
    ".gitignore": "/Frontend/node_modules\n",
    "Frontend/app.ts": "export const app = 1;\n",
    "docs/live.md": "Spiderly's docs: `Frontend/node_modules/spiderly/docs/index.md`; `Frontend/gone.ts` is gone.\n",
  });
  symlinkSync(outside, join(dir, "Frontend/node_modules"));
  assert.deepEqual(check(dir).lines, ["docs/live.md:1: `Frontend/gone.ts` resolves to nothing"]);
});

// A worktree whose node_modules links to its main checkout's: a trailing-slash rule matches no
// link, so the link itself is what the repository ignores, in its info/exclude.

test("a pointer through an ignored symlink to a directory is skipped, the link itself asked about", () => {
  const main = mkdtempSync(join(tmpdir(), "pointer-check-main-"));
  writeTree(main, { "spiderly/agent/docs/e2e-testing/index.md": "# E2E\n" });
  const dir = repo({
    ".gitignore": "**/node_modules/\n",
    "docs/live.md": "Read `Frontend/node_modules/spiderly/agent/docs/e2e-testing/index.md`; `docs/gone.md` is gone.\n",
  });
  mkdirSync(join(dir, "Frontend"));
  symlinkSync(main, join(dir, "Frontend/node_modules"));
  writeFileSync(join(dir, ".git/info/exclude"), "/Frontend/node_modules\n");
  assert.deepEqual(check(dir).lines, ["docs/live.md:1: `docs/gone.md` resolves to nothing"]);
});
