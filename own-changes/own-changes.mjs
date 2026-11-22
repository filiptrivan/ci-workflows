// What the commit being made changes on its own: the paths and list lines that a check's `--staged`
// mode judges. The rule for a merge commit is here, so each check that imports it keeps the same
// rule (pacms-workspace#1752, a merge commit's checks judge only what neither parent holds).
//
// Outside a merge, these are all the paths that the index changes against HEAD. A merge is in
// progress when MERGE_HEAD exists. Then a file that one parent brought unchanged belongs to that
// parent, whose own commits were judged. So a path is the merge's own only when its staged entry
// differs from the entry of each parent. A list line is added only when no parent's list holds it.
// Without this rule, a Catch-up merge's checks judged each file that origin changed. They refused
// the commit for lines that its session never wrote. When both sides change a file, the file is
// the merge's own. A check that judges whole files then judges origin's lines in it too.
//
// Each function takes the caller's `git(args)`, which runs git in the repo and returns its stdout.
// So each check keeps its own way to fail when git fails.

import { existsSync, readFileSync } from "node:fs";

/** The parents of the commit being made: HEAD, then each commit that MERGE_HEAD names. */
function stagedParents(git) {
  const mergeHead = git(["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
  return ["HEAD", ...(existsSync(mergeHead) ? readFileSync(mergeHead, "utf8").split("\n").filter(Boolean) : [])];
}

/**
 * Each path under `pathspec` that the index changes against `parent`, and its letter. A null
 * `parent` is HEAD, named by no argument, so the first commit of a repo (an unborn HEAD) works too.
 */
function changesAgainst(git, parent, pathspec) {
  const fields = git(["diff", "--cached", "--name-status", "-z", "--no-renames", ...(parent ? [parent] : []), "--", ...pathspec]).split("\0");
  const changes = new Map();
  for (let at = 0; at + 1 < fields.length; at += 2) changes.set(fields[at + 1], fields[at]);
  return changes;
}

/**
 * The paths under `pathspec` that the commit being made changes on its own. Each maps to its letter
 * as `git diff --name-status` prints it (A, M, T, D). In a merge, a path's letter is its letter
 * against the first parent that has the path, else A. So when one parent added a file and the
 * resolution edits it, the letter is M.
 */
export function ownChanges(git, pathspec = []) {
  const [, ...merged] = stagedParents(git);
  const head = changesAgainst(git, null, pathspec);
  if (merged.length === 0) return head;
  const others = merged.map((parent) => changesAgainst(git, parent, pathspec));
  const own = new Map();
  for (const [path, letter] of head) {
    const letters = [letter, ...others.map((changes) => changes.get(path))];
    if (letters.every(Boolean)) own.set(path, letters.find((each) => each !== "A") ?? "A");
  }
  return own;
}

/**
 * Every line that the lists of the commit's parents hold, or null when no parent has a list.
 * `listAt(parent)` reads the list of one parent as a Set, or gives null when it has none. A line of
 * the commit's list counts as added only when this Set does not hold it.
 */
export function parentLines(git, listAt) {
  const lists = stagedParents(git)
    .map((parent) => listAt(parent))
    .filter(Boolean);
  return lists.length === 0 ? null : new Set(lists.flatMap((list) => [...list]));
}
