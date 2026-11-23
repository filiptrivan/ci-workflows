// One run of the check over a checkout: each prose line of each file it selects, every pointer in
// the line resolved, and the history notes of a resident file. It returns the failures, minus those
// that name a file the repo ignores on purpose.

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { exemptMatcher } from "./exempt.mjs";
import { historyNotes, RESIDENT } from "./history-lint.mjs";
import { pointersIn } from "./pointers.mjs";
import { Repo } from "./repo.mjs";
import { prose } from "./scan.mjs";

export function check(root, { only = [], siblingsBeside } = {}) {
  const repo = new Repo(root, siblingsBeside);
  const exempt = exemptMatcher(repo.config.exempt);
  const selected = (file) =>
    only.length === 0 || only.some((path) => file === path || file.startsWith(path.endsWith("/") ? path : `${path}/`));
  const failures = [];
  const notesIn = repo.config.historyLint ? historyNotes(repo.config.historyLint.teammates) : undefined;
  let pointerCount = 0;
  let fileCount = 0;
  for (const file of repo.scanned) {
    if (exempt(file) || !selected(file)) continue;
    const lines = prose(repo, file);
    if (lines.length === 0) continue;
    fileCount++;
    const resident = notesIn && RESIDENT.test(file);
    let previous = "";
    for (const [index, { line, text, kind }] of lines.entries()) {
      const next = lines[index + 1]?.line === line + 1 ? lines[index + 1].text : "";
      if (resident) for (const note of notesIn(text, next)) failures.push({ file, line, ...note });
      const found = pointersIn(text, { repo, file, kind, previous, next });
      previous = text;
      for (const pointer of found) {
        const targets = pointer.resolve();
        if (targets === undefined) continue;
        pointerCount++;
        if (targets === 1) continue;
        failures.push({
          file,
          line,
          column: pointer.column,
          ignorable: targets === 0 ? pointer.located?.() : undefined,
          reportOnly: pointer.reportOnly,
          message:
            pointer.refusal ??
            `${pointer.heading ? pointer.display : `\`${pointer.display}\``} ${targets === 0 ? "resolves to nothing" : `resolves to ${targets} targets`}`,
        });
      }
    }
  }
  dropIgnored(failures);
  failures.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column));
  return { failures, pointerCount, fileCount, historyLint: Boolean(repo.config.historyLint) };
}

// A path the repo's ignore rules match names a file that is untracked on purpose (a local secrets
// file, build output), so it is not a pointer that went stale. The rules are tracked, which keeps
// this the same in CI as on a laptop where the file happens to exist.
//
// git refuses a path that runs through a symlink ("beyond a symbolic link", pnpm's node_modules)
// and fails the whole batch with it, so each path is asked about only up to its first symlinked
// directory, that link included: an ignored directory before that point, or the link itself,
// covers everything under it.
function dropIgnored(failures) {
  const asked = new Map();
  for (const failure of failures) {
    const target = failure.ignorable;
    if (!target?.owner || !target.path || target.path.startsWith("..")) continue;
    if (!asked.has(target.owner)) asked.set(target.owner, new Set());
    for (const candidate of ignoreCandidates(target.owner.root, target.path)) asked.get(target.owner).add(candidate);
  }
  const ignored = new Set();
  for (const [owner, candidates] of asked) {
    const run = spawnSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
      cwd: owner.root,
      input: `${[...candidates].join("\0")}\0`,
      encoding: "utf8",
    });
    for (const path of run.stdout.split("\0").filter(Boolean)) ignored.add(`${owner.root}\0${path}`);
  }
  for (let i = failures.length - 1; i >= 0; i--) {
    const target = failures[i].ignorable;
    if (!target?.owner || !target.path) continue;
    const candidates = ignoreCandidates(target.owner.root, target.path);
    if (candidates.some((candidate) => ignored.has(`${target.owner.root}\0${candidate}`))) failures.splice(i, 1);
  }
}

// The path itself and each directory above it, stopping at the first symlinked directory, which is
// asked about as itself, without the slash git refuses: an Agent box worktree's `node_modules` is a
// symlink to the main checkout's, which the box ignores in `.git/info/exclude` as
// `/Frontend/node_modules`, since the tracked `**/node_modules/` matches only a directory.
function ignoreCandidates(root, path) {
  const segments = path.replace(/\/+$/, "").split("/");
  const candidates = [];
  for (let i = 1; i < segments.length; i++) {
    const dir = segments.slice(0, i).join("/");
    try {
      if (lstatSync(join(root, dir)).isSymbolicLink()) return [...candidates, dir];
    } catch {
      break;
    }
    candidates.push(`${dir}/`);
  }
  candidates.push(path);
  return candidates;
}
