// Pins the heading pointer at the pointer check's CLI: what it lands on, how its text matches,
// and the refusal of an unquoted heading.
// What an agent observes is a pointer that resolves or does not, and an exit code that fails CI
// or passes. How a file is parsed is not pinned.
//
//   node --test pointer-check/headings.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { check, repo } from "./pointer-check.fixtures.mjs";

test("a heading pointer to a missing heading fails the run with its file and line", () => {
  const dir = repo({
    "CLAUDE.md": "# Rules\n\n## Repo info\n\nBranches.\n",
    "docs/live.md": "# Live\n\nSee `CLAUDE.md` → \"Repo info\" and `CLAUDE.md` → \"Deferring work\".\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, ['docs/live.md:3: `CLAUDE.md` → "Deferring work" resolves to nothing']);
  assert.match(result.stdout, /pointer-check: 1 failing pointer in 1 file\n/);
  assert.equal(result.status, 1);
});

test("a heading pointer to a heading two targets share fails as ambiguous", () => {
  const dir = repo({
    "docs/guide.md": "# Guide\n\n## Steps\n\nOne.\n\n## Steps\n\nTwo.\n",
    "docs/live.md": "Follow `docs/guide.md` → \"Steps\".\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, ['docs/live.md:1: `docs/guide.md` → "Steps" resolves to 2 targets']);
  assert.equal(result.status, 1);
});

test("a heading pointer whose file pointer fails is left to the file pointer's failure", () => {
  const dir = repo({
    "apps/rs/docs/guide.md": "## Steps\n",
    "apps/ba/docs/guide.md": "## Steps\n",
    "docs/live.md": 'Follow `docs/guide.md` → "Steps" or `docs/gone.md` → "Steps".\n',
  });
  assert.deepEqual(check(dir).lines, [
    "docs/live.md:1: `docs/guide.md` resolves to 2 targets",
    "docs/live.md:1: `docs/gone.md` resolves to nothing",
  ]);
});

test("a heading pointer lands on a table row's first cell or a bold run opening a line or list item", () => {
  const dir = repo({
    "GLOSSARY.md":
      "# Terms\n\n| Term | Meaning |\n|---|---|\n| Transfer panel | Prenosi |\n| **Restock line** | A line |\n\n" +
      "**Packable order** (admin copy: *Spremno*):\nAn order.\n\n- **Covered order**: short once.\n\n" +
      "Not a lead: the **Brand** in a sentence.\n",
    "docs/live.md":
      'Terms: `GLOSSARY.md` → "Transfer panel", `GLOSSARY.md` → "Restock line", `GLOSSARY.md` → "Packable order",\n' +
      '`GLOSSARY.md` → "Covered order" and `GLOSSARY.md` → "Brand".\n',
  });
  assert.deepEqual(check(dir).lines, ['docs/live.md:2: `GLOSSARY.md` → "Brand" resolves to nothing']);
});

test("a heading pointer takes the ASCII arrow too, in a comment as in Markdown", () => {
  const dir = repo({
    "CLAUDE.md": "# Rules\n\n## Repo info\n",
    "src/a.ts": '// Branches: `CLAUDE.md` -> "Repo info"; tags: `CLAUDE.md` -> "Release tags".\nexport const a = 1;\n',
  });
  assert.deepEqual(check(dir).lines, ['src/a.ts:1: `CLAUDE.md` -> "Release tags" resolves to nothing']);
});

test("a heading named without quotes fails, after either arrow, its message giving the quoted form", () => {
  const dir = repo({
    "CLAUDE.md": "# Rules\n\n## Repo info\n",
    "GLOSSARY.md": "# Terms\n\n**Ready frontier**: the tickets.\n\n**Pool**: the accounts.\n",
    "docs/live.md":
      'Fine: `CLAUDE.md` → "Repo info". Branches: `CLAUDE.md` → Repo info, tags: `CLAUDE.md` -> Repo info.\n' +
      "Ready ones (`GLOSSARY.md` → Ready frontier): first. The accounts: `GLOSSARY.md` → **Pool**.\n" +
      "Ships from `GLOSSARY.md` → V.V. warehouse. Then `CLAUDE.md` → Repo info - the rest, `CLAUDE.md` → 4A, step 1.\n",
    "src/a.ts": "// Branches: `CLAUDE.md` ->\n// Repo info, wrapped.\nexport const a = 1;\n",
  });
  const result = check(dir);
  assert.deepEqual(result.lines, [
    'docs/live.md:1: `CLAUDE.md` → Repo info names a heading without quotes: write `CLAUDE.md` → "Repo info"',
    'docs/live.md:1: `CLAUDE.md` -> Repo info names a heading without quotes: write `CLAUDE.md` -> "Repo info"',
    'docs/live.md:2: `GLOSSARY.md` → Ready frontier names a heading without quotes: write `GLOSSARY.md` → "Ready frontier"',
    'docs/live.md:2: `GLOSSARY.md` → Pool names a heading without quotes: write `GLOSSARY.md` → "Pool"',
    'docs/live.md:3: `GLOSSARY.md` → V.V. warehouse names a heading without quotes: write `GLOSSARY.md` → "V.V. warehouse"',
    'docs/live.md:3: `CLAUDE.md` → Repo info names a heading without quotes: write `CLAUDE.md` → "Repo info"',
    'docs/live.md:3: `CLAUDE.md` → 4A names a heading without quotes: write `CLAUDE.md` → "4A"',
    'src/a.ts:1: `CLAUDE.md` -> Repo info names a heading without quotes: write `CLAUDE.md` -> "Repo info"',
  ]);
  assert.equal(result.status, 1);
});

test("an unquoted heading fails even where its file is a sibling's that is not checked out", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify({ siblings: { "pa-cms": ["../pa-cms"] } }),
    "docs/live.md": "Entities: pa-cms `CLAUDE.md` → Entity changes; `pa-cms/CLAUDE.md` → \"Gone\" is skipped.\n",
  });
  assert.deepEqual(check(dir).lines, [
    'docs/live.md:1: `CLAUDE.md` → Entity changes names a heading without quotes: write `CLAUDE.md` → "Entity changes"',
  ]);
});

test("an arrow after a Markdown file is a heading pointer only when a word follows it", () => {
  const dir = repo({
    "docs/old.md": "# Old\n",
    "docs/new.md": "# New\n",
    "src/build.ts": "export const build = 1;\n",
    "docs/live.md": "Moved: `docs/old.md` → `docs/new.md`. The bundle: `src/build.ts` → writes `dist/`.\n",
  });
  assert.deepEqual(check(dir).lines, []);
});

test("a heading pointer into a sibling repo is checked there, and skipped when the sibling is absent", () => {
  const parent = mkdtempSync(join(tmpdir(), "pointer-check-"));
  repo({ "CLAUDE.md": "# pa-cms\n\n## Entity changes\n", "Backend/CLAUDE.md": "## Public feeds\n" }, parent, "pa-cms");
  const live =
    'Fine: `pa-cms/CLAUDE.md` → "Entity changes", pa-cms `Backend/CLAUDE.md` → "Public feeds".\n' +
    'Broken: `pa-cms/CLAUDE.md` → "Public feeds", pa-cms `CLAUDE.md` → "Gone".\n';
  const config = JSON.stringify({ siblings: { "pa-cms": ["../pa-cms"] } });
  const dir = repo({ ".pointer-check.jsonc": config, "docs/live.md": live }, parent);
  assert.deepEqual(check(dir).lines, [
    'docs/live.md:2: `pa-cms/CLAUDE.md` → "Public feeds" resolves to nothing',
    'docs/live.md:2: `pa-cms CLAUDE.md` → "Gone" resolves to nothing',
  ]);
  const alone = repo({ ".pointer-check.jsonc": config, "docs/live.md": live });
  assert.deepEqual(check(alone).lines, []);
});

test("a heading pointer inside a dated snapshot is skipped, the repo's own exempt paths included", () => {
  const dir = repo({
    ".pointer-check.jsonc": JSON.stringify({ exempt: ["docs/TODO.md"] }),
    "CLAUDE.md": "# Rules\n",
    "docs/adr/0001-x.md": '# 0001. X\n\nPer `CLAUDE.md` → "Gone".\n',
    "docs/plans/p.md": 'Per `CLAUDE.md` → "Gone".\n',
    "docs/incidents/i.md": 'Per `CLAUDE.md` → "Gone".\n',
    "docs/TODO.md": 'Per `CLAUDE.md` → "Gone".\n',
    "docs/frozen.md": 'Snapshot as of 2026-09-01.\n\nPer `CLAUDE.md` → "Gone".\n',
    "docs/live.md": 'Per `CLAUDE.md` → "Gone".\n',
  });
  assert.deepEqual(check(dir).lines, ['docs/live.md:1: `CLAUDE.md` → "Gone" resolves to nothing']);
});

test("a heading pointer may quote a target's lead, the text before its qualifier", () => {
  const dir = repo({
    "docs/domain.md":
      "## Where a fact goes (prose never restates the code, 2026-10-03)\n\n## Test lanes — every test declares one\n\n" +
      "## Two delivery modes for transaction results\n\n### 7.1 Fields common to all verticals\n\n" +
      "- **Observability Plus itself: KEEP until the re-measure closes, then decide with\n  Filip.** It ran.\n" +
      "- **~~Purge the junk accounts~~ — DONE 2026-08-22.** Gone.\n",
    "docs/live.md":
      'See `docs/domain.md` → "Where a fact goes", `docs/domain.md` → "Test lanes", `docs/domain.md` → "7.1",\n' +
      '`docs/domain.md` → "Observability Plus itself", `docs/domain.md` → "Purge the junk accounts" and\n' +
      '`docs/domain.md` → "Two delivery modes".\n',
  });
  assert.deepEqual(check(dir).lines, ['docs/live.md:3: `docs/domain.md` → "Two delivery modes" resolves to nothing']);
});

test("a heading pointer quotes a title's own double quotes as curly ones", () => {
  const dir = repo({
    "docs/TODO.md":
      '- **"Pozovi kurira" is not idempotent — BUILT 2026-09-08.** Fixed.\n' +
      '- **Admin-triggered "Pošalji uputstvo za uplatu" email (bank-transfer orders).** Deferred.\n',
    "docs/live.md":
      'See `docs/TODO.md` → "“Pozovi kurira” is not idempotent",\n' +
      '`docs/TODO.md` → "Admin-triggered “Pošalji uputstvo za uplatu” email" and\n' +
      '`docs/TODO.md` → "“Pozovi kurira” is idempotent".\n',
  });
  assert.deepEqual(check(dir).lines, ['docs/live.md:3: `docs/TODO.md` → "“Pozovi kurira” is idempotent" resolves to nothing']);
});

test("a heading outranks a bold run of its text, and a whole text outranks a lead", () => {
  const dir = repo({
    "docs/skill.md":
      "# Skill\n\n- **The batch review** (its section below): both agents.\n\n## The batch review\n\n" +
      "## Tests\n\n## Tests (Integration)\n",
    "docs/live.md": 'See `docs/skill.md` → "The batch review" and `docs/skill.md` → "Tests".\n',
  });
  assert.deepEqual(check(dir).lines, []);
});

test("a bare file name in a heading pointer names the file beside the pointer when there is one", () => {
  const dir = repo({
    "crons/titles/ROUTINE.md": "# Titles\n\n## What a run does\n",
    "crons/audit/ROUTINE.md": "# Audit\n\n## What a run does\n",
    "crons/titles/take.ts": '// The run is `ROUTINE.md` → "What a run does".\nexport const take = 1;\n',
    "docs/live.md": 'Either `ROUTINE.md` → "What a run does".\n',
    // A file naming its own base name means another one: here the root's.
    "CLAUDE.md": "# Root\n\n## Repo info\n",
    "Frontend/CLAUDE.md": '# Frontend\n\nBranches: `CLAUDE.md` → "Repo info".\n',
  });
  assert.deepEqual(check(dir).lines, ['docs/live.md:1: `ROUTINE.md` → "What a run does" resolves to 2 targets']);
});

test("a heading pointer wrapped onto the next line is read whole and reported at its first line", () => {
  const dir = repo({
    "CLAUDE.md": "# Rules\n\n## Repo info\n\n## Deferring work (Filip, 2026-09-12)\n",
    "docs/live.md": 'Branches: root `CLAUDE.md` → "Repo\ninfo"; later: `CLAUDE.md` → "Deferring\nlater".\n',
    "src/a.ts": '/**\n * Cards go on the board (`CLAUDE.md` →\n * "Deferring work"), never `CLAUDE.md` ->\n * "Deferring nothing".\n */\nexport const a = 1;\n',
  });
  assert.deepEqual(check(dir).lines, [
    'docs/live.md:2: `CLAUDE.md` → "Deferring later" resolves to nothing',
    'src/a.ts:3: `CLAUDE.md` -> "Deferring nothing" resolves to nothing',
  ]);
});

test("a heading pointer's text wrapped in Markdown keeps a slash or hash opening the next line", () => {
  const dir = repo({
    "docs/watch.md": "# Watch\n\n**Opus, not `/schedule`'s Sonnet default.** Why.\n\n## Ticket #239 follow-ups\n",
    "docs/live.md":
      'A judgment routine (`docs/watch.md` → "Opus, not\n/schedule\'s Sonnet default"), then\n' +
      '`docs/watch.md` → "Ticket\n#239 follow-ups".\n',
  });
  assert.deepEqual(check(dir).lines, []);
});
