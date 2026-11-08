// Pins the Size cap at its CLI, run as a pre-commit hook (`--staged`) and CI (whole-tree mode) run
// it: each test builds a real git repo in a temp folder and asserts only the exit code and the
// printed text. Its builders and the refusals' expected words: size-cap.fixtures.mjs.
//
//   node --test size-cap/size-cap.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ADDED, CODE_RECIPE, commit, FOOTER, git, LISTED, RECIPES, repo, run, sizeLines, SPLIT, stage, text } from "./size-cap.fixtures.mjs";

/* ------------------------------------------------------------------------- what is refused */

test("a new file over the cap is refused with its size, the code recipe and the footer, word for word", () => {
  const dir = repo({}, { "src/orders.ts": text(25_000) });

  const refused = run(dir, "--staged");

  assert.equal(refused.status, 1);
  assert.ok(
    refused.out.includes(
      "size cap: src/orders.ts is 25,000 bytes = 6,250 tokens (bytes/4). The cap is 5,000 tokens (20,000 bytes).\n\n" +
        `${SPLIT}\n\n${CODE_RECIPE}\n\n${FOOTER}\n`,
    ),
    refused.out,
  );

  commit(dir);
  const whole = run(dir);
  assert.equal(whole.status, 1);
  assert.ok(whole.out.includes("size cap: src/orders.ts is 25,000 bytes = 6,250 tokens (bytes/4)."), whole.out);
});

test("an executable file over the cap is refused like any other", () => {
  const dir = repo({}, { "scripts/provision.sh": text(25_000) });
  git(dir, "update-index", "--chmod=+x", "scripts/provision.sh");

  assert.deepEqual(sizeLines(run(dir, "--staged").out), ["size cap: scripts/provision.sh is over"]);
  commit(dir);
  assert.deepEqual(sizeLines(run(dir).out), ["size cap: scripts/provision.sh is over"]);
});

test("a file the commit takes across the cap is refused, one at exactly 20,000 bytes passes", () => {
  const dir = repo({ "src/orders.ts": text(19_000), "src/stock.ts": text(19_000) }, { "src/orders.ts": text(20_001), "src/stock.ts": text(20_000) });

  const refused = run(dir, "--staged");

  assert.equal(refused.status, 1);
  assert.ok(refused.out.includes("size cap: src/orders.ts is 20,001 bytes = 5,001 tokens (bytes/4)."), refused.out);
  assert.ok(!refused.out.includes("src/stock.ts"), refused.out);
  commit(dir);
  assert.equal(run(dir).status, 1);
  stage(dir, { "src/orders.ts": text(20_000) });
  commit(dir);
  assert.equal(run(dir).status, 0);
});

test("--staged measures the staged blob, never the working-tree file another session is editing", () => {
  const dir = repo({}, { "src/orders.ts": text(1_000), "src/stock.ts": text(25_000) });
  writeFileSync(join(dir, "src/orders.ts"), text(25_000));
  writeFileSync(join(dir, "src/stock.ts"), text(1_000));

  const refused = run(dir, "--staged");

  assert.equal(refused.status, 1);
  assert.ok(refused.out.includes("size cap: src/stock.ts is 25,000 bytes"), refused.out);
  assert.ok(!refused.out.includes("src/orders.ts"), refused.out);
});

/* ----------------------------------------------------------------- each kind's own recipe */

const KINDS = {
  "src/orders.test.ts": "test",
  "app/order.component.spec.ts": "test",
  "Backend/OrderLifecycleTests.cs": "test",
  "app/order.component.html": "template",
  "docs/plans/market-pricing-plan.md": "markdown",
  "docs/guide.mdx": "markdown",
  "glossary/orders.md": "glossary",
  ".claude/skills/wings/SKILL.md": "skill",
  ".claude/skills/wings/references/api.md": "skill",
  "CLAUDE.md": "resident",
  "pa/AGENTS.md": "resident",
  ".claude/skills/CLAUDE.md": "resident",
  ".github/workflows/build.yml": "data",
  "messages/sr.json": "data",
  "Backend/OrderLifecycle.cs": "code",
  ".claude/skills/restock/scripts/build_order.py": "code",
};

test("each kind of file prints only its own recipe, read from its path, a resident file's without the split, and always the footer", () => {
  const dir = repo({}, Object.fromEntries(Object.keys(KINDS).map((path) => [path, text(25_000)])));

  const staged = run(dir, "--staged");
  commit(dir);

  for (const refused of [staged, run(dir)]) {
    assert.equal(refused.status, 1);
    const blocks = refused.out.split(/^(?=size cap: )/m).filter((block) => / is 25,000 bytes/.test(block));
    assert.equal(blocks.length, Object.keys(KINDS).length);
    for (const block of blocks) {
      const path = block.slice("size cap: ".length, block.indexOf(" is "));
      const header = `size cap: ${path} is 25,000 bytes = 6,250 tokens (bytes/4). The cap is 5,000 tokens (20,000 bytes).`;
      const advice = KINDS[path] === "resident" ? RECIPES.resident : `${SPLIT}\n\n${RECIPES[KINDS[path]]}`;
      assert.equal(block, `${header}\n\n${advice}\n\n${FOOTER}\n\n`, path);
    }
  }
});

/* ------------------------------------------------------------------------ a narrowed cap */

test("a size-cap mark narrows its own file's cap: one byte over is refused naming the mark, the cap itself passes", () => {
  const dir = repo({ ".gitattributes": "/CLAUDE.md size-cap=10000\n" }, { "CLAUDE.md": text(10_001), "docs/CLAUDE.md": text(15_000) });

  const refused = run(dir, "--staged");

  assert.equal(refused.status, 1);
  const header = "size cap: CLAUDE.md is 10,001 bytes = 2,501 tokens (bytes/4). Its cap is 2,500 tokens (10,000 bytes), narrowed by its size-cap mark in .gitattributes.";
  assert.equal(refused.out, `${header}\n\n${RECIPES.resident}\n\n${FOOTER}\n\nsize cap: 1 refusal\n`);
  commit(dir);
  assert.deepEqual(sizeLines(run(dir).out), ["size cap: CLAUDE.md is over"]);
  stage(dir, { "CLAUDE.md": text(10_000) });
  assert.equal(run(dir, "--staged").status, 0);
  commit(dir);
  assert.equal(run(dir).status, 0);
});

test("a size-cap mark that narrows nothing is refused, however small its file; an unset one passes", () => {
  const dir = repo({}, { ".gitattributes": "a.md size-cap=10,000\nb.md size-cap=20000\nc.md size-cap\nd.md -size-cap\n", "a.md": "a\n", "b.md": "b\n", "c.md": "c\n", "d.md": "d\n" });
  const marks = ["a.md size-cap=10,000", "b.md size-cap=20000", "c.md size-cap"].map((mark) => mark.split(" "));
  const bad = marks.map(([path, mark]) => `size cap: ${path}: its mark ${mark} narrows nothing: a size-cap mark takes a whole number of bytes under 20,000, as size-cap=10000`);

  const staged = run(dir, "--staged");
  commit(dir);
  for (const refused of [staged, run(dir)]) {
    assert.equal(refused.status, 1);
    assert.deepEqual(sizeLines(refused.out), bad);
  }
});

/* -------------------------------------------------------------------------- what is exempt */

test("a file .gitattributes marks linguist-generated or linguist-vendored is exempt, its mark staged in the same commit", () => {
  const files = {
    ".gitattributes": "pnpm-lock.yaml linguist-generated\napi.ts linguist-generated=true\nmanual/** linguist-vendored\nhand.ts -linguist-generated\nempty.ts linguist-generated=\n",
    "pnpm-lock.yaml": text(90_000),
    "api.ts": text(90_000),
    "manual/bank.md": text(90_000),
    "hand.ts": text(25_000),
    "empty.ts": text(25_000),
  };
  const dir = repo({}, files);

  const refused = run(dir, "--staged");

  assert.equal(refused.status, 1);
  assert.deepEqual(sizeLines(refused.out), ["size cap: empty.ts is over", "size cap: hand.ts is over"]);
  commit(dir);
  assert.deepEqual(sizeLines(run(dir).out), ["size cap: empty.ts is over", "size cap: hand.ts is over"]);
});

test("a mark in a person's global attributes file exempts nothing", () => {
  const dir = repo({}, { "api.ts": text(25_000) });
  writeFileSync(join(dir, "global-attributes"), "api.ts linguist-generated\n");
  git(dir, "config", "core.attributesFile", join(dir, "global-attributes"));

  assert.equal(run(dir, "--staged").status, 1);
  commit(dir);
  assert.equal(run(dir).status, 1);
});

test("a file git treats as binary is skipped: a NUL in its first 8,000 bytes, or a binary or -diff mark", () => {
  const nulAt = (offset) => Buffer.concat([Buffer.from(text(offset)), Buffer.from([0]), Buffer.from(text(30_000))]);
  const dir = repo(
    {},
    {
      ".gitattributes": "*.pdf binary\n*.xlsx -diff\n",
      "slike/1.png": nulAt(10),
      "slike/2.png": nulAt(7_999),
      "manual.pdf": text(30_000),
      "prices.xlsx": text(30_000),
      "late-nul.txt": nulAt(8_000),
    },
  );

  const refused = run(dir, "--staged");

  assert.equal(refused.status, 1);
  assert.equal(refused.out.match(/^size cap: \S+ is/gm).join("\n"), "size cap: late-nul.txt is");
  commit(dir);
  assert.equal(run(dir).out.match(/^size cap: \S+ is/gm).join("\n"), "size cap: late-nul.txt is");
});

/* --------------------------------------------------------------------- the Over-cap list */

test("a listed file over the cap passes, as the commit grows it or marks it generated, the list's lines CRLF or not", () => {
  const head = { ".over-cap-list": "src/orders.ts\r\nsrc/api.ts\n", "src/orders.ts": text(40_000), "src/api.ts": text(40_000) };
  const dir = repo(head, { "src/orders.ts": text(41_000), ".gitattributes": "src/api.ts linguist-generated\n" });

  assert.equal(run(dir, "--staged").status, 0);
  const base = commit(dir);
  assert.equal(run(dir, "--base", base).status, 0);
});

test("a listed file now under the cap, deleted or renamed is refused until the same commit removes its line", () => {
  const head = { ".over-cap-list": "src/a.ts\nsrc/b.ts\nsrc/c.ts\n", "src/a.ts": text(40_000), "src/b.ts": text(40_000), "src/c.ts": text(40_000) };
  const dir = repo(head, { "src/a.ts": text(3_000), "src/b.ts": null, "src/c.ts": null, "src/c/orders.ts": text(40_000) });

  const refused = run(dir, "--staged");

  assert.equal(refused.status, 1);
  assert.deepEqual(sizeLines(refused.out), [LISTED("src/a.ts"), LISTED("src/b.ts"), LISTED("src/c.ts"), "size cap: src/c/orders.ts is over"]);
  const base = commit(dir);
  assert.deepEqual(sizeLines(run(dir, "--base", base).out), [LISTED("src/a.ts"), LISTED("src/b.ts"), LISTED("src/c.ts"), "size cap: src/c/orders.ts is over"]);

  stage(dir, { ".over-cap-list": "" , "src/c/orders.ts": null });
  assert.equal(run(dir, "--staged").status, 0);
  assert.equal(run(dir, "--base", commit(dir)).status, 0);
});

test("a line the commit adds to the list is refused, a rename's new path included, and the list's first commit adds none", () => {
  const dir = repo({ ".over-cap-list": "src/a.ts\n", "src/a.ts": text(40_000) }, { ".over-cap-list": "src/a/orders.ts\nsrc/new.ts\n", "src/a.ts": null, "src/a/orders.ts": text(40_000), "src/new.ts": text(40_000) });

  const refused = run(dir, "--staged");

  assert.equal(refused.status, 1);
  assert.deepEqual(sizeLines(refused.out), [ADDED("src/a/orders.ts"), ADDED("src/new.ts")]);
  const base = commit(dir);
  assert.deepEqual(sizeLines(run(dir, "--base", base).out), [ADDED("src/a/orders.ts"), ADDED("src/new.ts")]);
  assert.equal(run(dir).status, 0, "with no base, no line counts as added");

  const installing = repo({ "src/a.ts": text(40_000) }, { ".over-cap-list": "src/a.ts\n" });
  assert.equal(run(installing, "--staged").status, 0);
  assert.equal(run(installing, "--base", commit(installing)).status, 0);
});

test("a list written again after a commit deleted it is compared with the last list, so it still only shrinks", () => {
  const dir = repo({ ".over-cap-list": "src/a.ts\n", "src/a.ts": text(40_000) }, { ".over-cap-list": null });
  commit(dir);
  stage(dir, { ".over-cap-list": "src/a.ts\nsrc/b.ts\n", "src/b.ts": text(40_000) });

  assert.deepEqual(sizeLines(run(dir, "--staged").out), [ADDED("src/b.ts")]);
  assert.deepEqual(sizeLines(run(dir, "--base", commit(dir)).out), [ADDED("src/b.ts")]);
});

test("a line the commit removes while its file stays over the cap is refused, though the commit leaves the file alone", () => {
  const dir = repo({ ".over-cap-list": "src/a.ts\n", "src/a.ts": text(40_000) }, { ".over-cap-list": "" });

  const refused = run(dir, "--staged");

  assert.equal(refused.status, 1);
  assert.deepEqual(sizeLines(refused.out), ["size cap: src/a.ts is over"]);
});

test("whole-tree mode judges every line of the list against the tree, whatever the commit touched", () => {
  const dir = repo({ ".over-cap-list": "src/gone.ts\nsrc/small.ts\n", "src/small.ts": text(1_000) }, { "README.md": "a repo, edited\n" });

  assert.equal(run(dir, "--staged").status, 0);
  const base = commit(dir);
  assert.deepEqual(sizeLines(run(dir, "--base", base).out), [LISTED("src/gone.ts"), LISTED("src/small.ts")]);
});

test("--write-list writes every judged file over the cap in the staged tree, sorted, and the commit adding it passes", () => {
  const dir = repo(
    { "src/b.ts": text(30_000), "src/a.ts": text(25_000), "src/small.ts": text(100), "pnpm-lock.yaml": text(90_000) },
    { ".gitattributes": "pnpm-lock.yaml linguist-generated\n", "docs/z.md": text(21_000) },
  );
  writeFileSync(join(dir, "src/small.ts"), text(30_000));

  const wrote = run(dir, "--write-list");

  assert.deepEqual(wrote, { status: 0, out: "size cap: wrote .over-cap-list, 3 files over the cap\n" });
  assert.equal(readFileSync(join(dir, ".over-cap-list"), "utf8"), "docs/z.md\nsrc/a.ts\nsrc/b.ts\n");
  git(dir, "add", ".over-cap-list");
  assert.equal(run(dir, "--staged").status, 0);
  assert.equal(run(dir, "--base", commit(dir)).status, 0);
});

test("a call it cannot run stops with exit 2, never a pass", () => {
  const dir = repo({ ".over-cap-list": "" });
  const stop = (out) => ({ status: 2, out: `size cap: ${out}\n` });

  assert.deepEqual(run(dir, "--stagd"), stop("unknown option --stagd"));
  assert.deepEqual(run(dir, "--base"), stop("--base needs a ref"));
  assert.deepEqual(run(dir, "--staged", "--write-list"), stop("--staged, --base and --write-list each run alone"));
  assert.deepEqual(run(dir, "--base", "0123456789abcdef0123456789abcdef01234567"), stop("--base 0123456789abcdef0123456789abcdef01234567 names no commit in this repo"));
});

test("a repo's first commit is judged like any other", () => {
  const dir = mkdtempSync(join(tmpdir(), "size-cap-"));
  git(dir, "init", "-q", "-b", "main");
  stage(dir, { "src/orders.ts": text(25_000), ".over-cap-list": "src/orders.ts\n" });

  assert.equal(run(dir, "--staged").status, 0);
  stage(dir, { ".over-cap-list": null });
  assert.deepEqual(sizeLines(run(dir, "--staged").out), ["size cap: src/orders.ts is over"]);
});

test("--staged judges only the files the commit adds or modifies, and whole-tree mode every tracked file", () => {
  const dir = repo({ "src/big.ts": text(30_000) }, { "src/small.ts": "export const small = 1;\n" });

  assert.equal(run(dir, "--staged").status, 0);
  commit(dir);
  const whole = run(dir);
  assert.equal(whole.status, 1);
  assert.ok(whole.out.includes("size cap: src/big.ts is 30,000 bytes"), whole.out);
});
