// Pins a pointer behind a sibling repo's name at the pointer check's CLI: checked in the sibling
// when it is checked out or at the tree --sibling-tree names, skipped when it is not, and its
// prefix read on a wrapped line.
// What an agent observes is a pointer that resolves or does not, and an exit code that fails CI
// or passes. How a file is parsed is not pinned.
//
//   node --test pointer-check/siblings.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { check, git, repo, writeTree } from "./pointer-check.fixtures.mjs";

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

test("a copy of a checkout checks its sibling pointers in the siblings beside the checkout it names", () => {
  const parent = mkdtempSync(join(tmpdir(), "pointer-check-"));
  repo({ "GLOSSARY.md": "# Glossary\n" }, parent, "umbrella");
  const files = {
    ".pointer-check.jsonc": JSON.stringify({ siblings: { umbrella: ["../umbrella"] } }),
    "docs/live.md": "Fine: umbrella `GLOSSARY.md`. Broken: umbrella `GONE.md`.\n",
  };
  const checkout = repo(files, parent);
  const copy = repo(files);
  assert.deepEqual(check(copy).lines, [], "beside nothing, the sibling pointers are skipped");
  assert.deepEqual(check(copy, "--siblings-beside", checkout).lines, ["docs/live.md:1: `umbrella GONE.md` resolves to nothing"]);
});

test("a sibling prefix at the end of the previous line still prefixes the pointer that opens the next", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify({ siblings: { "pa-cms": ["../pa-cms"] } }),
    "docs/live.md": "The capture's reason sits on pa-cms\n`Order.CaptureAsync`, decided in pa-cms\nADR 0009.\n",
  });
  assert.deepEqual(check(dir).lines, []);
});

test("a wrapped prefix still counts inside a block comment whose lines start with an asterisk", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify({ siblings: { "pa-cms": ["../pa-cms"] } }),
    "src/a.ts": "/**\n * The rank is ported from pa-cms\n * `Backend/Ranking.cs`, which we cannot import.\n */\nexport const a = 1;\n",
  });
  assert.deepEqual(check(dir).lines, []);
});

test("a sibling prefix capitalized at a sentence start still names the sibling", () => {
  const parent = mkdtempSync(join(tmpdir(), "pointer-check-"));
  repo({ "GLOSSARY.md": "# Glossary\n" }, parent, "umbrella");
  const dir = repo(
    {
      ".pointer-check.jsonc": JSON.stringify({ siblings: { umbrella: ["../umbrella"] } }),
      "docs/live.md": "The terms are fixed. Umbrella `GLOSSARY.md` holds them.\nUmbrella `GONE.md` does not.\n",
    },
    parent,
  );
  assert.deepEqual(check(dir).lines, ["docs/live.md:2: `umbrella GONE.md` resolves to nothing"]);
});

test("a wrapped prefix opened by a parenthesis still names the repo of the ADR on the next line", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify({ siblings: { umbrella: ["../umbrella"] } }),
    "docs/live.md": "Every pointer resolves (umbrella\nADR 0047, prose never restates the code).\n",
  });
  assert.deepEqual(check(dir).lines, []);
});

// A change in two repos: pa-storefront's prose names a pa-cms field the same change adds. The pa-cms
// clone beside it stands at origin's tip, which lacks the field; the change's commit is on a branch.
function changeInTwoRepos() {
  const parent = mkdtempSync(join(tmpdir(), "pointer-check-"));
  const paCms = repo({ "Backend/Product.cs": "public class Product { public int Price; }\n" }, parent, "pa-cms");
  git(paCms, "commit", "-qm", "origin's tip");
  git(paCms, "switch", "-qc", "the-change");
  writeTree(paCms, { "Backend/Product.cs": "public class Product { public int Price; public int Weight; }\n" });
  git(paCms, "commit", "-qam", "the change adds Weight");
  const merged = git(paCms, "rev-parse", "HEAD");
  git(paCms, "switch", "-q", "main");
  const storefront = repo(
    {
      ".pointer-check.jsonc": JSON.stringify({ siblings: { "pa-cms": ["../pa-cms"] } }),
      "docs/live.md": "The card shows pa-cms `Product.Weight` beside pa-cms `Product.Price`.\n",
    },
    parent,
    "pa-storefront",
  );
  return { paCms, merged, storefront };
}

test("a sibling tree the same change brings is read in place of the sibling's checkout, so a field it adds resolves", () => {
  const { merged, storefront } = changeInTwoRepos();

  const read = check(storefront, "--sibling-tree", `pa-cms=${merged}`);

  assert.equal(read.status, 0, read.stdout + read.stderr);
  assert.deepEqual(read.lines, []);
});

test("with no sibling tree given, the sibling is read in its checkout at origin's tip, which lacks the field", () => {
  const { storefront } = changeInTwoRepos();

  const read = check(storefront);

  assert.equal(read.status, 1, read.stdout + read.stderr);
  assert.deepEqual(read.lines, ["docs/live.md:1: `pa-cms Product.Weight` resolves to nothing"]);
});

test("a sibling tree is read from the clone's objects, never its working tree, so a draft there does not count", () => {
  const { paCms, merged, storefront } = changeInTwoRepos();
  writeTree(paCms, { "Backend/Draft.cs": "public class Draft { public int Weight; }\n" });
  writeTree(storefront, { "docs/draft.md": "A draft: pa-cms `Draft.Weight`.\n" });

  const read = check(storefront, "--sibling-tree", `pa-cms=${merged}`);

  assert.deepEqual(read.lines, ["docs/draft.md:1: `pa-cms Draft.Weight` resolves to nothing"]);
});

test("a sibling tree that cannot be read stops the check with exit 2, never a pass or a failing pointer", () => {
  const { storefront } = changeInTwoRepos();
  const lone = repo({
    ".pointer-check.jsonc": JSON.stringify({ siblings: { "pa-cms": ["../pa-cms"] } }),
    "docs/live.md": "pa-cms `Product.Weight`.\n",
  });

  for (const [dir, value, says] of [
    [storefront, "spiderly=HEAD", "spiderly is no sibling"],
    [storefront, `pa-cms=${"0".repeat(40)}`, `pa-cms holds no tree ${"0".repeat(40)}`],
    [storefront, "pa-cms", "takes <name>=<commit>"],
    [lone, "pa-cms=HEAD", "no clone of pa-cms"],
  ]) {
    const run = check(dir, "--sibling-tree", value);
    assert.equal(run.status, 2, `${value}: ${run.stdout}${run.stderr}`);
    assert.ok(run.stderr.includes(says), `${value}: ${run.stderr}`);
  }
});
