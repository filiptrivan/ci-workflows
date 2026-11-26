#!/usr/bin/env node
// Fails when prose names a file, a symbol, an ADR or a heading that does not exist, or names it
// ambiguously.
//
//   node pointer-check.mjs [--root <dir>] [--siblings-beside <checkout>] [--staged] [--report-only] [path ...]
//
// Prose is every Markdown file, every comment in a code file and each guide in a root
// `.size-cap.json` (scan.mjs `sizeCapGuides`), minus the exempt set (exempt.mjs). A pointer
// is one of six explicit forms; anything else, a bare backticked word above all, is never one,
// because a missed pointer costs less than a false failure that teaches people to ignore the check:
//
//   a file path       `apps/rs/next.config.ts`, `scripts/evals/`, a relative Markdown link;
//                     resolves when exactly one tracked file or directory ends with it
//   a symbol          `Type.Member` or `name()` in backticks, or `see someName` in a comment;
//                     resolves when a file that declares the type uses the member in its code
//                     (strings and comments blanked); a library's type, used but never declared
//                     here (`DateTime.UtcNow`), only needs its names used together in one file.
//                     A lone name resolves on a declaration, a use in code, or a string that is
//                     exactly the name (`["toLocaleString"]`), never a sentence that mentions it
//                     (a test title that outlived a rename)
//   an ADR number     ADR 0047, ADR-0047; resolves when exactly one docs/adr/ file has it, or
//                     when the words beside it pick one of the files that share it
//   a heading         a backticked file path, an arrow (→ or ->) and a quoted text, as in
//                     `CLAUDE.md` → "Repo info"; resolves when the Markdown file it lands on holds
//                     exactly one heading, table row's first cell or bold run opening a line with
//                     that text (how they are matched and ranked: headings.mjs
//                     `headingPointer`). A Markdown file path, an arrow and a word without quotes
//                     fails whatever it names: where an unquoted text ends is a guess, so its
//                     heading would go unchecked (headings.mjs `unquotedHeadingPointer`)
//   any of the above prefixed with a sibling repo's name (`pa-cms/Backend/X.cs`, pa-cms `X.Y`,
//                     pa-cms ADR 0009); checked in that sibling when it is checked out beside
//                     this one, skipped when it is not, so a lone clone's CI never fails on it;
//                     --siblings-beside reads them beside <checkout> instead, for a copy of it
//                     (a throwaway worktree at a pinned commit, whose own `..` holds no sibling)
//   a file and a name  prepare.mjs `runPrePushChecks`, `name` in @pa/shared/x.ts; resolves when
//                     the file declares, exports or uses the name (file-and-name.mjs). It is
//                     report-only until the repo's settings turn it on
//
// The whole tree is scanned on every run, never a diff: a rename in one file strands a pointer
// in another file the diff does not touch. --staged, a pre-commit hook's call, checks only the
// files the index adds or changes, in a merge only its own changes
// (own-changes/own-changes.mjs), read from the hook's index before the run drops the git
// variables a hook hands it: every git call after runs as by hand, each sibling's in its own repo.
//
// The history lint, in a repo whose settings name its teammates, also fails a resident file (every
// `CLAUDE.md` and `AGENTS.md`, and `.claude/rules/*.md`) that holds, outside code, an issue number
// (`#123`, `repo#123`) or a who-and-when note (a teammate's name up to three words before a date,
// `(Filip, 2026-10-27`).
// A resident file loads into every session under it, so it holds a rule and its reason; who said it,
// when and the issue go in the commit message or an ADR. A dated fact and an ADR number pass.
//
// Per-repo settings live in `.pointer-check.jsonc` at the root (JSON with comments):
//   {
//     "exempt": ["path/prefix/", "glob/**/*.md", "!re/included.md"],  // last match wins
//     "siblings": { "name": ["../name", "name"] },  // present when a path holds a `.git`
//     "self": ["name"],                              // this repo's own names, as a prefix
//     "historyLint": { "teammates": ["Name"] },     // absent: no history lint
//     "failFileAndNamePointers": true                // absent: a file and a name is report-only
//   }
//
// This file is the command: its options, the files --staged selects, and the report. Its parts:
//   check.mjs          the run over a checkout
//   scan.mjs           which parts of a file are prose
//   repo.mjs           the checkout's indexes
//   pointers.mjs       the pointers in a line, with headings.mjs and file-and-name.mjs
//   history-lint.mjs   the history notes
//   exempt.mjs         the files the check skips
// No file imports this one, because importing it runs the command.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { check } from "./check.mjs";

import { ownChanges } from "../own-changes/own-changes.mjs";

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// What git hands a hook: inherited, they point every git call, a sibling's too, at the hook's repo.
const HOOK_GIT_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"];

function main(argv) {
  let root;
  let siblingsBeside;
  let staged = false;
  let reportOnly = false;
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report-only") reportOnly = true;
    else if (argv[i] === "--staged") staged = true;
    else if (argv[i] === "--root") root = argv[++i];
    else if (argv[i] === "--siblings-beside") siblingsBeside = resolve(argv[++i]);
    else if (argv[i].startsWith("--")) {
      process.stderr.write(`pointer-check: unknown option ${argv[i]}\n`);
      return 2;
    } else only.push(argv[i].replace(/^\.\//, ""));
  }
  if (staged) {
    // A or M: with renames off, a renamed or copied file's new path is an A.
    const changes = ownChanges((args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
    const listed = [...changes].filter(([, letter]) => letter === "A" || letter === "M").map(([path]) => path);
    if (listed.length === 0) {
      process.stdout.write("pointer-check: no failing pointers (nothing staged)\n");
      return 0;
    }
    only.push(...listed);
  }
  for (const name of HOOK_GIT_VARIABLES) delete process.env[name];
  root = resolve(root ?? execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  const { failures, pointerCount, fileCount, historyLint } = check(root, { only, siblingsBeside });
  for (const failure of failures) {
    process.stdout.write(`${failure.file}:${failure.line}: ${failure.message}${failure.reportOnly ? " (report only)" : ""}\n`);
  }
  const failingFiles = new Set(failures.map((failure) => failure.file)).size;
  const fails = failures.some((failure) => !failure.reportOnly);
  const notes = failures.filter((failure) => failure.history).length;
  const counted = [
    failures.length > notes && plural(failures.length - notes, "failing pointer"),
    notes > 0 && plural(notes, "history note"),
  ].filter(Boolean);
  const summary =
    failures.length === 0
      ? `no failing pointers (${plural(pointerCount, "pointer")} checked in ${plural(fileCount, "file")})${historyLint ? ", no history notes" : ""}`
      : `${counted.join(" and ")} in ${plural(failingFiles, "file")}${reportOnly || !fails ? " (report only)" : ""}`;
  process.stdout.write(`pointer-check: ${summary}\n`);
  return fails && !reportOnly ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
