// Which of a repo's Pre-push checks a moment runs. It reads the repo's check manifest
// (`.pre-push-checks.json`; its format: umbrella scripts/deploy-watch/pre-push-check-manifest.mjs)
// and the paths the moment changes. The hooks, the close step and the push all ask it, so they
// cannot disagree (spec pacms-workspace#1685, ticket pacms-workspace#1692). It lives here, since
// each repo's hooks already reach this clone beside the umbrella. A hook that finds no clone runs
// every check its paths reach: the safe side.

// The moments: a factory session's commit (PACMS_COMMIT_MOMENT=factory, which a Push subagent's
// commit sets too), any other session's commit, a ticket's close, and a push.
export const MOMENTS = ["factory-commit", "commit", "close", "push"];

// Whether a check runs at a moment, by the manifest's `fast` and `hook`. A factory commit runs only
// the fast checks. Any other commit runs the fast checks and the `hook` checks, as pre-commit always
// did. A close runs the slow `hook` checks, since the landing push reads their markers. A push runs
// every check.
const RUNS = {
  "factory-commit": ({ fast }) => fast === true,
  commit: ({ fast, hook }) => fast === true || hook === true,
  close: ({ fast, hook }) => fast !== true && hook === true,
  push: () => true,
};

function mustBeMoment(moment) {
  if (!MOMENTS.includes(moment)) throw new Error(`no moment ${moment}; the moments are ${MOMENTS.join(", ")}`);
}

/**
 * The command `check` runs at `moment`: its `command`, the same at every moment, or the one its
 * `commands` names for the moment (`commit` for either commit, `close`, `push`). It is null when the
 * check does not run then. Throws on an unknown moment.
 */
export function commandAt(check, moment) {
  mustBeMoment(moment);
  if (check.command) return check.command;
  return check.commands?.[moment.endsWith("commit") ? "commit" : moment] ?? null;
}

const reached = ({ reaches }, paths) => !reaches || paths.some((path) => reaches.some((pattern) => new RegExp(pattern).test(path)));

/**
 * The checks of `manifest` (`{ checks }`, parsed) that `moment` runs where `paths` changed, in the
 * manifest's order. Each is as written, with `command` set to its command at the moment. A check
 * with no `reaches` is reached by any paths. Throws on an unknown moment.
 */
export function checksAt(manifest, moment, paths) {
  mustBeMoment(moment);
  return manifest.checks
    .filter((check) => RUNS[moment](check) && reached(check, paths))
    .map((check) => ({ ...check, command: commandAt(check, moment) }))
    .filter(({ command }) => command !== null);
}
