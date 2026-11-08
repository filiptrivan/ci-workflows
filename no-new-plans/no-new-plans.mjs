#!/usr/bin/env node
// No new plans: a design session ends in ADRs and its spec, so nothing new starts under docs/plans/
// (umbrella ADR 0154). The plans a repo already holds stay, and may still be edited or split.
//
//   node no-new-plans.mjs --staged         a pre-commit hook's call: the files the commit adds, and
//                                          the staged list against HEAD's
//   node no-new-plans.mjs [--base <ref>]   CI's call: every file HEAD tracks under docs/plans/, and
//                                          its list against <ref>'s, a pull request's base or a
//                                          push's previous tip
//
// Exits 1 printing every refusal, 0 otherwise, 2 when it cannot run (git fails, or --base names no
// commit).
//
// The list, `.plans-list` at the repo's root, holds one name per line: a plan's path under
// docs/plans/ up to its first `/`, without `.md`, so one line covers a plan, the folder a split moved
// its sections into, and every file in it. A line added fails, so the list only shrinks; a repo with
// no list holds no allowed plan, except the commit that installs it, whose base has none to compare.

import { spawnSync } from "node:child_process";

const LIST = ".plans-list";
const PLANS = "docs/plans/";

const NEW_PLAN =
  "a new file under docs/plans/. A design session writes no plan: a decision goes in an ADR with its\n" +
  "rejected options and the numbers behind it, what to build in the spec issue, a reason in a comment\n" +
  "on its code, and a dated measurement worth reading again in docs/audits/ (umbrella ADR 0154)";
const ADDED_LINE = `a line added to ${LIST}: the list only shrinks; write an ADR instead (umbrella ADR 0154)`;

function git(...args) {
  const { status, stdout, stderr } = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  return { ok: status === 0, stdout, stderr };
}

function mustGit(...args) {
  const { ok, stdout, stderr } = git(...args);
  if (!ok) {
    console.error(`no new plans: git ${args.join(" ")} failed: ${stderr.trim()}`);
    process.exit(2);
  }
  return stdout;
}

const lines = (text) => text.split("\n").filter(Boolean);

/** The list at `rev` (`git show`'s `<rev>:<path>`, an empty rev being the index), null if it holds none. */
function listAt(rev) {
  const { ok, stdout } = git("show", `${rev}:${LIST}`);
  return ok ? new Set(lines(stdout).map((line) => line.trim())) : null;
}

const nameOf = (path) => path.slice(PLANS.length).split("/")[0].replace(/\.md$/, "");

function judge(paths, list, baseList) {
  const refusals = paths.filter((path) => !list?.has(nameOf(path))).map((path) => `${path}: ${NEW_PLAN}`);
  if (baseList) for (const line of list ?? []) if (!baseList.has(line)) refusals.push(`${LIST}: ${line}: ${ADDED_LINE}`);
  return refusals;
}

function refusalsOf(args) {
  if (args[0] === "--staged") {
    const added = lines(mustGit("diff", "--cached", "--name-only", "--no-renames", "--diff-filter=A", "--", PLANS));
    return judge(added, listAt(""), listAt("HEAD"));
  }
  let baseList = null;
  if (args[0] === "--base") {
    mustGit("rev-parse", "--verify", "--quiet", `${args[1]}^{commit}`);
    baseList = listAt(args[1]);
  }
  return judge(lines(mustGit("ls-files", "--", PLANS)), listAt("HEAD"), baseList);
}

const refusals = refusalsOf(process.argv.slice(2));
for (const refusal of refusals) console.log(refusal);
process.exit(refusals.length ? 1 : 0);
