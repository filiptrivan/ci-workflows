// Pins the ADR number pointer at the pointer check's CLI: one ADR, a number two ADRs share, and
// a path to an ADR.
// What an agent observes is a pointer that resolves or does not, and an exit code that fails CI
// or passes. How a file is parsed is not pinned.
//
//   node --test pointer-check/adrs.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { check, repo } from "./pointer-check.fixtures.mjs";

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
