// What the commit being made changes on its own. The `--staged` mode of the Size cap, the no new
// plans check and the pointer check judges only these paths and list lines, so their rule for a
// merge commit is in one place (pacms-workspace#1752).
//
// Outside a merge, these are all the paths the index changes against HEAD. In a merge (MERGE_HEAD
// exists), a file that one parent brought unchanged was judged in that parent's own commits. So a
// path is the merge's own only when its staged entry differs from the entry of each parent, and a
// list line is added only when no parent's list holds it. Without this rule, each file that origin
// changed counted as a Catch-up merge's own, and the commit was refused for lines its session never
// wrote. A file that both sides changed is the merge's own, so a check that judges whole files also
// judges origin's lines in it.
//
// Each function takes the caller's `git(args)`, which runs git in the repo and returns its stdout.
// So each check keeps its own way to fail when git fails.

import { existsSync, readFileSync } from "node:fs";

/** The commits the commit being made will have as parents: HEAD, then each one MERGE_HEAD names. */
export function stagedParents(git) {
  const mergeHead = git(["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
  return ["HEAD", ...(existsSync(mergeHead) ? readFileSync(mergeHead, "utf8").split("\n").filter(Boolean) : [])];
}

/** Each path under `pathspec` that the index changes against `parent` (null: HEAD), and its letter. */
function changesAgainst(git, parent, pathspec) {
  const fields = git(["diff", "--cached", "--name-status", "-z", "--no-renames", ...(parent ? [parent] : []), "--", ...pathspec]).split("\0");
  const changes = new Map();
  for (let at = 0; at + 1 < fields.length; at += 2) changes.set(fields[at + 1], fields[at]);
  return changes;
}

/**
 * The paths under `pathspec` that the commit being made changes on its own. Each maps to its letter
 * as `git diff --name-status` prints it (A, M, T, D). In a merge, a path's letter is its letter
 * against the first parent that holds it, else A. So when one parent added a file and the
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
 * Every line that the lists of `parents` hold, or null when no parent holds a list. `listAt(parent)`
 * reads one parent's list as a Set, or null when it holds none. A line of the commit's list counts as
 * added only when this lacks it.
 */
export function parentLines(parents, listAt) {
  const lists = parents.map((parent) => listAt(parent)).filter(Boolean);
  return lists.length === 0 ? null : new Set(lists.flatMap((list) => [...list]));
}
