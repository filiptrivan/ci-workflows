// A sibling read at a tree that --sibling-tree names, in place of its checkout. A caller that
// merges a change in two repos gives each sibling its merged tree: the tree that the same change
// brings. Then a change in two repos passes, though the sibling's checkout and origin lack it.
// Given no tree, the check reads a sibling in its checkout, as before.
//
// The check writes the tree into a scratch directory from the clone's own objects. So a draft in
// the clone's working tree never counts. The scratch index holds the tree, so "tracked" means what
// the tree holds, an ignored file that the tree tracks included.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A sibling tree that cannot be read: the run cannot start, so the command exits 2, never 1. */
export class SiblingTreeError extends Error {}

const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The `--sibling-tree` value `value`, `<name>=<commit>`, as `[name, commit]`; a value of another form throws. */
export function siblingTreeOf(value) {
  const at = value?.indexOf("=") ?? -1;
  if (at <= 0 || at === value.length - 1) throw new SiblingTreeError(`--sibling-tree takes <name>=<commit>, not ${value ?? "nothing"}`);
  return [value.slice(0, at), value.slice(at + 1)];
}

/**
 * Writes the tree `tree` of the clone at `clone`, sibling `name`, into a new scratch directory, and
 * returns its path. A tree that the clone does not hold, or that git cannot write, throws, and
 * leaves no directory.
 */
export function writeTree(clone, name, tree) {
  const found = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${tree}^{tree}`], { cwd: clone, encoding: "utf8" });
  if (found.status !== 0) throw new SiblingTreeError(`--sibling-tree ${name}=${tree}: ${name} holds no tree ${tree} (its clone ${clone})`);
  const dir = mkdtempSync(join(tmpdir(), `pointer-check-${name}-`));
  try {
    run(dir, "init", "-q");
    writeFileSync(join(dir, ".git", "objects", "info", "alternates"), `${run(clone, "rev-parse", "--path-format=absolute", "--git-path", "objects")}\n`);
    run(dir, "read-tree", found.stdout.trim());
    run(dir, "checkout-index", "--all");
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new SiblingTreeError(`--sibling-tree ${name}=${tree}: git could not write the tree: ${error.stderr?.toString().trim() || error.message}`);
  }
}

/** Removes each scratch directory of `dirs`, which writeTree made. */
export function removeScratchDirs(dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
