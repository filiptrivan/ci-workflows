// Pins the pointer check at its CLI: what an agent observes is a pointer that resolves or does
// not, and an exit code that fails CI or passes. How a file is parsed is not pinned.
//
//   node --test pointer-check/pointer-check.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "pointer-check.mjs");

function writeTree(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

// A real git repo, because "tracked" is what the check resolves against.
function repo(files, parent = mkdtempSync(join(tmpdir(), "pointer-check-")), name = "repo") {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeTree(dir, files);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function check(dir, ...args) {
  const run = spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8" });
  const lines = run.stdout.split("\n").filter((line) => line.length > 0 && !line.startsWith("pointer-check:"));
  return { status: run.status, lines, stdout: run.stdout, stderr: run.stderr };
}

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

test("a declared symbol resolves and an undeclared one does not", () => {
  const dir = repo({
    "src/OrderService.cs": "public class OrderService { public void PlaceOrder() {} }\n",
    "src/redirect.ts":
      "// see outOfRangePageRedirect for the 404 case\nexport function outOfRangePageRedirect() {}\n" +
      "// see missingPageRedirect for the other one\n",
    "docs/guide.md": "Call `OrderService.PlaceOrder` or `OrderService.CancelOrder()`.\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, [
    "docs/guide.md:1: `OrderService.CancelOrder()` resolves to nothing",
    "src/redirect.ts:3: `missingPageRedirect` resolves to nothing",
  ]);
});

test("a name that only a comment mentions is not declared", () => {
  const dir = repo({
    "src/a.ts": "// renamedAwayHelper was the old name\nexport const kept = 1;\n",
    "src/b.ts": "// see renamedAwayHelper\nexport const other = 2;\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, ["src/b.ts:1: `renamedAwayHelper` resolves to nothing"]);
});

test("an ADR number resolves when one ADR has it", () => {
  const dir = repo({
    "docs/adr/0007-orders-are-event-sourced.md": "# 0007. Orders are event sourced\n",
    "docs/guide.md": "Orders follow ADR 0007; ADR-0008 was never written.\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, ["docs/guide.md:1: `ADR-0008` resolves to nothing"]);
});

test("an ADR number two files share resolves only with the title beside it", () => {
  const dir = repo({
    "docs/adr/0047-an-architecture-review-proposes-no-change-to-a-cron.md": "# 0047. A review\n",
    "docs/adr/0047-prose-never-restates-the-code.md": "# 0047. Prose\n",
    "docs/guide.md":
      "Per ADR 0047 (prose never restates the code), comments explain why.\n" +
      "Per ADR 0047, nothing else.\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, ["docs/guide.md:2: `ADR 0047` resolves to 2 targets"]);
});

test("a backticked environment variable, flag or bare word is never a pointer", () => {
  const dir = repo({
    "docs/guide.md":
      "Set `BASE_URL`, pass `--max-warnings=0`, run `pnpm lint`, and keep `origin/master` and\n" +
      "`application/json` and `next/cache` and `@pa/no-sentence-dashes` and `OrderService` and\n" +
      "`https://example.com/a/b.ts` and `/p/busilica-18v` and `prodavnicaalata.rs` and `docs/**/*.md`.\n",
    "docs/other.md": "# Other\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, []);
  assert.equal(result.status, 0);
});

test("a fenced code block is not prose", () => {
  const dir = repo({
    "docs/guide.md": "Run:\n\n```bash\nnode scripts/gone.mjs\ncat `scripts/gone.mjs`\n```\n",
  });
  assert.deepEqual(check(dir).lines, []);
});

test("a pointer in code is only read from comments", () => {
  const dir = repo({
    "src/a.ts": 'const url = "see missingThing and `src/gone.ts`";\n// and `src/also-gone.ts`\n',
  });
  assert.deepEqual(check(dir).lines, ["src/a.ts:2: `src/also-gone.ts` resolves to nothing"]);
});

test("the default exempt directories and a snapshot-headed file are skipped", () => {
  const dir = repo({
    "docs/adr/0001-x.md": "# 0001. X\n\nWe chose `src/gone.ts`.\n",
    "docs/plans/p.md": "The plan names `src/gone.ts`.\n",
    "docs/incidents/i.md": "The incident names `src/gone.ts`.\n",
    "docs/frozen.md":
      "Snapshot as of 2026-09-01. Not maintained; the code is the reference (ADR 0047).\n\n`src/gone.ts`\n",
    "docs/live.md": "`src/gone.ts`\n",
  });
  assert.deepEqual(check(dir).lines, ["docs/live.md:1: `src/gone.ts` resolves to nothing"]);
});

test("the repo's config adds exempt paths", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify({ exempt: ["vendor/", "docs/generated/**/*.md"] }),
    "vendor/skill/SKILL.md": "`src/gone.ts`\n",
    "docs/generated/a/b.md": "`src/gone.ts`\n",
    "docs/live.md": "`src/gone.ts`\n",
  });
  assert.deepEqual(check(dir).lines, ["docs/live.md:1: `src/gone.ts` resolves to nothing"]);
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

test("a pointer into a sibling repo is skipped when the sibling is absent", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify({ siblings: { "pa-cms": ["../pa-cms"] } }),
    "docs/live.md": "See `pa-cms/Backend/Gone.cs`, pa-cms `Backend/AlsoGone.cs` and pa-cms ADR 0009.\n",
  });
  assert.deepEqual(check(dir).lines, []);
});

test("a pointer into a sibling repo is checked when the sibling is present", () => {
  const parent = mkdtempSync(join(tmpdir(), "pointer-check-"));
  repo(
    {
      "Backend/Order.cs": "public class Order { public int Total; }\n",
      "docs/adr/0009-orders-have-totals.md": "# 0009. Orders have totals\n",
    },
    parent,
    "pa-cms",
  );
  const dir = repo(
    {
      ".pointer-check.jsonc": JSON.stringify({ siblings: { "pa-cms": ["../pa-cms"] } }),
      "docs/live.md":
        "Fine: `pa-cms/Backend/Order.cs`, pa-cms `Order.Total`, pa-cms ADR 0009.\n" +
        "Broken: `pa-cms/Backend/Gone.cs`, pa-cms `Backend/AlsoGone.cs`, pa-cms ADR 0010, pa-cms `Order.Discount`.\n",
    },
    parent,
  );
  assert.deepEqual(check(dir).lines, [
    "docs/live.md:2: `pa-cms/Backend/Gone.cs` resolves to nothing",
    "docs/live.md:2: `pa-cms Backend/AlsoGone.cs` resolves to nothing",
    "docs/live.md:2: `pa-cms ADR 0010` resolves to nothing",
    "docs/live.md:2: `pa-cms Order.Discount` resolves to nothing",
  ]);
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

test("a path the repo ignores names a file that is untracked on purpose and is skipped", () => {
  const dir = repo({
    ".gitignore": "*.local.json\n.secrets/\n",
    "config/base.json": "{}\n",
    "docs/live.md": "Keys go in `config/app.local.json` and `.secrets/token`; `config/app.json` is gone.\n",
  });
  assert.deepEqual(check(dir).lines, ["docs/live.md:1: `config/app.json` resolves to nothing"]);
});

test("a dotted name of an outside system, a file name or a footnote is not a symbol", () => {
  const dir = repo({
    "src/a.ts": "export const used = 1;\n",
    "docs/live.md":
      "Wings serves `local.kupac.svi`, the bank sends `Gateway_Guide_v3.pdf` and `vercel.deployment.ready`,\n" +
      "and `Canonicalize(urldecode(url=))` is a crawler setting.[^1]\n\n[^1]: Only for some brands.\n",
  });
  assert.deepEqual(check(dir).lines, []);
});

test("a date after an ADR number is not another ADR number", () => {
  const dir = repo({
    "docs/adr/0002-two.md": "# 0002. Two\n",
    "docs/adr/0047-forty-seven.md": "# 0047. Forty seven\n",
    "docs/live.md": "Decided in ADR 0047, superseding ADR 0002, 2026-10-03; see ADRs 0002 and 0047.\n",
  });
  assert.deepEqual(check(dir).lines, []);
});

test("a path to an ADR by its number resolves as that ADR", () => {
  const dir = repo({
    "docs/adr/0022-eyeballs-run-on-staging.md": "# 0022. Eyeballs run on staging\n",
    "docs/live.md": "See `docs/adr/0022` and `docs/adr/0023`.\n",
  });
  assert.deepEqual(check(dir).lines, ["docs/live.md:1: `docs/adr/0023` resolves to nothing"]);
});

test("the config may carry comments, re-include an exempt path, and name the repo itself", () => {
  const dir = repo({
    ".pointer-check.jsonc":
      "{\n  // dated reports; the one tool README in there is live\n" +
      '  "exempt": ["docs/reports/", "!docs/reports/tool/README.md"],\n' +
      '  "self": ["my-repo"]\n}\n',
    "src/kept.ts": "export const kept = 1;\n",
    "docs/reports/2026-01.md": "`src/gone.ts`\n",
    "docs/reports/tool/README.md": "`src/gone.ts` and `my-repo/src/kept.ts`, my-repo `src/kept.ts`\n",
  });
  assert.deepEqual(check(dir).lines, ["docs/reports/tool/README.md:1: `src/gone.ts` resolves to nothing"]);
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

test("a member renamed on its type fails even where another file or a string still names it", () => {
  const dir = repo({
    "src/Order.cs": "public class Order { public decimal GrandTotal { get; set; } }\n",
    "src/Cart.cs": "public class Cart { public decimal Total; void Pay(Order order) { Log(\"Order.Placed\"); } }\n",
    "src/Clock.cs": "public class Clock { public System.DateTime Now() => System.DateTime.UtcNow; }\n",
    "docs/live.md": "`Order.GrandTotal`, `Order.Total`, `Order.Placed`, and the library's `DateTime.UtcNow`.\n",
  });
  assert.deepEqual(check(dir).lines, [
    "docs/live.md:1: `Order.Total` resolves to nothing",
    "docs/live.md:1: `Order.Placed` resolves to nothing",
  ]);
});

test("an inherited member resolves; one only a migration's strings still name does not", () => {
  const dir = repo({
    "src/Entity.cs": "public abstract class Entity { public long Id { get; set; } }\n",
    "src/Brand.cs": "public class Brand : Entity { public string Name { get; set; } }\n",
    "src/Order.cs": "public class Order : BusinessObject<long> { public string FullName { get; set; } }\n",
    "src/OrderQueries.cs": "public class OrderQueries { long Find(Order order) => order.Version; }\n",
    "src/Migrations/Merge.cs": 'public class Merge { void Up() { DropColumn(name: "FirstName", table: "Order"); } }\n',
    "src/rule.mjs": 'export const banned = ["toLocaleString"];\n',
    "docs/live.md":
      "`Brand.Id`, `Brand.Slug`, `Order.FullName`, `Order.Version`, `Order.FirstName`, `Category.Products.Any()`,\n" +
      "`toLocaleString()` and `oklch(0.5 0 0)`.\n",
  });
  assert.deepEqual(check(dir).lines, [
    "docs/live.md:1: `Brand.Slug` resolves to nothing",
    "docs/live.md:1: `Order.FirstName` resolves to nothing",
    "docs/live.md:1: `Category.Products.Any()` resolves to nothing",
  ]);
});

test("the config may end a value line with a comment and carry a trailing comma", () => {
  const dir = repo({
    ".pointer-check.jsonc":
      '{\n  "exempt": ["vendor/",],  // vendored\n  "self": ["this-repo"]  // own names, "quoted // not a comment"\n}\n',
    "vendor/a.md": "`src/gone.ts`\n",
    "docs/live.md": "`this-repo/docs/live.md`\n",
  });
  const result = check(dir);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.lines, []);
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
