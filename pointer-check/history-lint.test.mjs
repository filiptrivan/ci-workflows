// Pins the history lint at the pointer check's CLI: the issue numbers and who-and-when notes it
// refuses in a resident file, and the summary that counts them.
// What an agent observes is a pointer that resolves or does not, and an exit code that fails CI
// or passes. How a file is parsed is not pinned.
//
//   node --test pointer-check/history-lint.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { check, repo } from "./pointer-check.fixtures.mjs";

const TEAM = { historyLint: { teammates: ["Filip", "Mira"] } };
const HISTORY = "a resident file holds a rule and its reason, its history goes in the commit message or an ADR";

test("an issue number in a resident file fails outside code; elsewhere, or in code, it passes", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify(TEAM),
    "CLAUDE.md": "# Rules\n\n- Claim a ticket first (pacms-workspace#371, the poster).\n- Write `#56 (title)`, never #56.\n",
    "docs/guide.md": "Built in pacms-workspace#371 and #56.\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, [
    `CLAUDE.md:3: \`pacms-workspace#371\` is an issue number: ${HISTORY}`,
    `CLAUDE.md:4: \`#56\` is an issue number: ${HISTORY}`,
  ]);
  assert.equal(result.status, 1);
});

test("a teammate's name before a date fails in any resident file; a dated fact and an ADR number pass", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify(TEAM),
    "docs/adr/0047-prose.md": "# 0047. Prose\n",
    "AGENTS.md": "Plain English (Filip, 2026-11-01): the plainest word.\n",
    "apps/rs/CLAUDE.md": "The host is gone (2026-09-09), measured 2026-11-06 (ADR 0047).\n",
    ".claude/rules/api.md": "Ask first (umbrella ADR 0047, Mira 2026-10-30, after a refusal).\n",
    "docs/guide.md": "Filip, 2026-11-01, said so.\n",
  });
  assert.deepEqual(check(dir).lines, [
    `.claude/rules/api.md:1: \`Mira 2026-10-30\` is a who-and-when note: ${HISTORY}`,
    `AGENTS.md:1: \`Filip, 2026-11-01\` is a who-and-when note: ${HISTORY}`,
  ]);
});

test("the summary counts history notes apart from failing pointers", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify(TEAM),
    "CLAUDE.md": "See `src/gone.ts` (#12, Filip, 2026-09-23).\n",
  });
  assert.match(check(dir).stdout, /pointer-check: 1 failing pointer and 2 history notes in 1 file\n/);
  const clean = repo({ ".pointer-check.jsonc": JSON.stringify(TEAM), "CLAUDE.md": "Measured 2026-11-06.\n" });
  assert.match(check(clean).stdout, /pointer-check: no failing pointers \(0 pointers checked in 1 file\), no history notes\n/);
});

test("a note wrapped across two lines fails at its first; a full issue address fails whole; a link anchor and a fence pass", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify({ historyLint: { teammates: ["Filip", "Đura"] } }),
    "GLOSSARY.md": "# Glossary\n",
    "CLAUDE.md":
      "Plain English (Filip,\n2026-11-01): the plainest word, as Đura\n2026-10-30 said.\n" +
      "Built in filiptrivan/pacms-workspace#831; see [a term](GLOSSARY.md#1-term).\n" +
      "```\ngh issue view #12\n```\n",
  });
  assert.deepEqual(check(dir).lines, [
    `CLAUDE.md:1: \`Filip, 2026-11-01\` is a who-and-when note: ${HISTORY}`,
    `CLAUDE.md:2: \`Đura 2026-10-30\` is a who-and-when note: ${HISTORY}`,
    `CLAUDE.md:4: \`filiptrivan/pacms-workspace#831\` is an issue number: ${HISTORY}`,
  ]);
});

test("a teammate's name up to three words before a date is a note; one farther off is not", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify(TEAM),
    "CLAUDE.md":
      "Who starts it (Filip, grilled 2026-10-17).\nAsked once (Filip's ask, 2026-10-25).\n" +
      "Filip's own runs go to staging, which restore.sh reset on 2026-11-02.\n",
  });
  assert.deepEqual(check(dir).lines, [
    `CLAUDE.md:1: \`Filip, grilled 2026-10-17\` is a who-and-when note: ${HISTORY}`,
    `CLAUDE.md:2: \`Filip's ask, 2026-10-25\` is a who-and-when note: ${HISTORY}`,
  ]);
});

test("a history lint with no teammates refuses issue numbers, and a dated fact passes", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify({ historyLint: {} }),
    "CLAUDE.md": "Measured 2026-11-06, read 2026-11-06; built in #12.\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, [`CLAUDE.md:1: \`#12\` is an issue number: ${HISTORY}`]);
  assert.match(result.stdout, /pointer-check: 1 history note in 1 file\n/);
});

test("a repo whose config names no teammates runs no history lint", () => {
  const dir = repo({ "CLAUDE.md": "Claim a ticket first (Filip, 2026-09-23, pacms-workspace#371).\n" });
  assert.deepEqual(check(dir).lines, []);
});
