// Pins the symbol pointer at the pointer check's CLI: which spans are one, and which names in
// code it resolves against.
// What an agent observes is a pointer that resolves or does not, and an exit code that fails CI
// or passes. How a file is parsed is not pinned.
//
//   node --test pointer-check/symbols.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { check, repo } from "./pointer-check.fixtures.mjs";

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

test("a dotted name of an outside system, a file name or a footnote is not a symbol", () => {
  const dir = repo({
    "src/a.ts": "export const used = 1;\n",
    "docs/live.md":
      "Wings serves `local.kupac.svi`, the bank sends `Gateway_Guide_v3.pdf` and `vercel.deployment.ready`,\n" +
      "and `Canonicalize(urldecode(url=))` is a crawler setting.[^1]\n\n[^1]: Only for some brands.\n",
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

test("a lone name only a sentence in a string still mentions fails; a string that is the name counts", () => {
  const dir = repo({
    "src/helper.ts": "export function newHelper() { return 1; }\n",
    "src/helper.test.ts": 'test("oldHelper returns one", () => newHelper());\n',
    "src/rule.mjs": 'export const banned = ["toLocaleString"];\n',
    "src/a.ts": "// see oldHelper for the count\nexport const a = 1;\n",
    "docs/live.md": "`oldHelper()` is renamed; `toLocaleString()` stays banned.\n",
  });
  assert.deepEqual(check(dir).lines, [
    "docs/live.md:1: `oldHelper()` resolves to nothing",
    "src/a.ts:1: `oldHelper` resolves to nothing",
  ]);
});

test("a member of a partial type may live in a part no file holds, as a generated one does", () => {
  const dir = repo({
    "src/ProductDTO.cs": "public partial class ProductDTO { public bool IsListed => true; }\n",
    "src/Use.cs": "public class Use { string N(ProductDTO dto) => dto.Name; }\n",
    "docs/live.md": "`ProductDTO.Name` comes from the generator; `ProductDTO.Gone` from nowhere.\n",
  });
  assert.deepEqual(check(dir).lines, ["docs/live.md:1: `ProductDTO.Gone` resolves to nothing"]);
});

test("a call named after see in a comment is a pointer without backticks", () => {
  const dir = repo({
    "src/order.ts":
      "// see placeOrderNow() for the rule, and see placeOrderLater().\nexport function placeOrderNow() {}\n",
  });
  assert.deepEqual(check(dir).lines, ["src/order.ts:1: `placeOrderLater()` resolves to nothing"]);
});

test("a name a workflow's own code uses is in use", () => {
  const dir = repo({
    ".github/workflows/gate.yml":
      "jobs:\n  report:\n    # `always()` keeps this step running after a failure; `never()` is not a function.\n    if: always()\n",
  });
  assert.deepEqual(check(dir).lines, [".github/workflows/gate.yml:3: `never()` resolves to nothing"]);
});

// The history lint: a repo whose config names its teammates refuses history in its resident files.
