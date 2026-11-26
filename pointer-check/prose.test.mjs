// Pins what the pointer check reads as prose, at its CLI: which files and lines, and what the
// repo's settings exempt.
// What an agent observes is a pointer that resolves or does not, and an exit code that fails CI
// or passes. How a file is parsed is not pinned.
//
//   node --test pointer-check/prose.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { check, repo } from "./pointer-check.fixtures.mjs";

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

test("comments in a JSON-with-comments file are prose", () => {
  const dir = repo({
    ".pointer-check.jsonc": '{\n  // Settings for `src/gone.ts`.\n  "exempt": []\n}\n',
    "tsconfig.json": '{\n  // The paths alias mirrors `src/paths.ts`.\n  "compilerOptions": { "baseUrl": "https://example.com//x" }\n}\n',
    "src/paths.ts": "export {};\n",
  });
  assert.deepEqual(check(dir).lines, [".pointer-check.jsonc:2: `src/gone.ts` resolves to nothing"]);
});

test("a Size cap guide in .size-cap.json is prose, since a refusal prints it; another JSON file's strings are not", () => {
  const dir = repo({
    ".size-cap.json": '{\n  "guides": {\n    "resident": "`docs/rules.md` → \\"Lines\\"",\n    "skill": "`docs/rules.md` → \\"Gone\\""\n  }\n}\n',
    "package.json": '{ "description": "`docs/gone.md`" }\n',
    "docs/rules.md": "# Rules\n\n## Lines\n",
  });
  assert.deepEqual(check(dir).lines, ['.size-cap.json:4: `docs/rules.md` → "Gone" resolves to nothing']);
});
