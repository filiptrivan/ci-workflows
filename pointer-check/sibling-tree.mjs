// A sibling read at a tree that --sibling-tree names, in place of its checkout: the tree that the
// same change brings when the change touches that sibling too. A change in two repos then passes,
// though the sibling's checkout and origin both lack the change. A caller that merges a change in
// two repos runs the check so, each sibling at its merged tree. Given no tree, a sibling is read in
// its checkout, as before.
//
// The tree is checked out into a scratch directory, from the clone's own objects, so a draft in the
// clone's working tree never counts. Its index holds the tree, so "tracked" means what the tree
// holds, an ignored file that the tree tracks included.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The `--sibling-tree` value `value`, `<name>=<commit>`, as `[name, commit]`; a value of another form throws. */
export function siblingTreeOf(value) {
  const at = value?.indexOf("=") ?? -1;
  if (at <= 0 || at === value.length - 1) throw new Error(`--sibling-tree takes <name>=<commit>, not ${value ?? "nothing"}`);
  return [value.slice(0, at), value.slice(at + 1)];
}

/**
 * The tree `tree` of the clone at `clone`, sibling `name`, checked out into a new scratch directory:
 * its path. A tree the clone does not hold throws.
 */
export function checkOutTree(clone, name, tree) {
  const found = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${tree}^{tree}`], { cwd: clone, encoding: "utf8" });
  if (found.status !== 0) throw new Error(`--sibling-tree ${name}=${tree}: ${name} holds no tree ${tree} (its clone ${clone})`);
  const dir = mkdtempSync(join(tmpdir(), `pointer-check-${name}-`));
  run(dir, "init", "-q");
  writeFileSync(join(dir, ".git", "objects", "info", "alternates"), `${run(clone, "rev-parse", "--path-format=absolute", "--git-path", "objects")}\n`);
  run(dir, "read-tree", found.stdout.trim());
  run(dir, "checkout-index", "--all");
  return dir;
}

/** Removes each scratch directory of `dirs`, checkOutTree's. */
export function removeTrees(dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
