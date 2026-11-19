#!/usr/bin/env node
// Which of a repo's Pre-push checks a moment runs, from the repo's check manifest
// (`.pre-push-checks.json`; its format: umbrella scripts/deploy-watch/pre-push-check-manifest.mjs)
// and the paths the moment changes. The hooks, the close step and the push all ask it, so they
// cannot disagree (spec pacms-workspace#1685, ticket pacms-workspace#1692). It lives here because
// each repo's hooks already reach this clone beside the umbrella; a hook that finds no clone runs
// every check its paths reach, the safe side.
//
//   node check-moments.mjs --moment <moment> [--manifest <path>]
//
// reads the changed paths on stdin, one a line, and prints each check the moment runs, in the
// manifest's order, as one line: its name, fast, docker, track, ciWorkflows and command, split by the
// unit separator (\x1f), which no field holds. The manifest defaults to the one in the current
// directory. Exits 2 when it cannot run.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// A commit of a factory session (PACMS_COMMIT_MOMENT=factory, which a Push subagent's commit sets
// too), a commit of any other session, a ticket's close, and a push.
export const MOMENTS = ["factory-commit", "commit", "close", "push"];

// Whether a check runs at a moment: `fast` and `hook` are the manifest's fields. A factory commit
// runs only the fast checks; any other commit runs the fast ones and those the pre-push hook runs, as
// pre-commit always did; a close runs the slow ones the pre-push hook runs, whose markers the landing
// push reads; a push runs every check.
const RUNS = {
  "factory-commit": ({ fast }) => fast === true,
  commit: ({ fast, hook }) => fast === true || hook === true,
  close: ({ fast, hook }) => fast !== true && hook === true,
  push: () => true,
};

/**
 * The command `check` runs at `moment`: its `command`, the same at every moment, or the one its
 * `commands` names for the moment (`commit` for either commit, `close`, `push`), else null, when it
 * does not run then.
 */
export function commandAt(check, moment) {
  if (!MOMENTS.includes(moment)) throw new Error(`no moment ${moment}; the moments are ${MOMENTS.join(", ")}`);
  if (check.command) return check.command;
  return check.commands?.[moment.endsWith("commit") ? "commit" : moment] ?? null;
}

const reached = ({ reaches }, paths) => !reaches || paths.some((path) => reaches.some((pattern) => new RegExp(pattern).test(path)));

/**
 * The checks of `manifest` (`{ checks }`, parsed) that `moment` runs where `paths` changed, in the
 * manifest's order, each as written with `command` set to its command at the moment. A check with no
 * `reaches` is reached by any paths.
 */
export function checksAt(manifest, moment, paths) {
  return manifest.checks
    .filter((check) => RUNS[moment] && RUNS[moment](check) && reached(check, paths))
    .map((check) => ({ ...check, command: commandAt(check, moment) }))
    .filter(({ command }) => command !== null);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const moment = valueOf("--moment");
  if (!MOMENTS.includes(moment)) {
    console.error(`check moments: --moment takes one of ${MOMENTS.join(", ")}`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(valueOf("--manifest") ?? ".pre-push-checks.json", "utf8"));
  const paths = readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const { name, fast, docker, track, ciWorkflows, command } of checksAt(manifest, moment, paths)) {
    process.stdout.write(`${[name, fast === true, docker === true, track ?? "", ciWorkflows === true, command].join("\x1f")}\n`);
  }
}
