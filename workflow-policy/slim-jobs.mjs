// The rule every `ubuntu-slim` job keeps, read as `workflows.mjs` reads a workflow (a comment saying
// why a job has no Docker never counts). Why the rule: `slim-jobs.test.mjs`'s header.

import { indentOf, jobsOf } from "./workflows.mjs";

/** The job's own keys, each `{ key, value }`, a value continued on the deeper lines below it. */
function keysOf(job) {
  const body = job.lines.filter((line) => line.code.trim());
  const indent = body.length ? indentOf(body[0].code) : 0;
  const keys = [];
  for (const line of body) {
    const key = indentOf(line.code) === indent && /^\s*([\w-]+):(.*)$/.exec(line.code);
    if (key) keys.push({ key: key[1], value: key[2].trim() });
    else if (keys.length) keys.at(-1).value = `${keys.at(-1).value} ${line.code.trim()}`.trim();
  }
  return keys;
}

const SLIM_TIMEOUT_MINUTES = 15;
const CAP = `slim terminates a job at ${SLIM_TIMEOUT_MINUTES} minutes, so it sets ${SLIM_TIMEOUT_MINUTES} or less`;

/**
 * What breaks the slim rule in `workflows` (`{ name, text }` each), one line per problem. A job
 * that names `ubuntu-slim` anywhere outside a comment is held to it, so one that reaches slim
 * through its matrix is too.
 */
export function slimJobProblems(workflows) {
  const problems = [];
  for (const { name, text } of workflows) {
    for (const job of jobsOf(text)) {
      if (!job.lines.some((line) => line.code.includes("ubuntu-slim"))) continue;
      const docker = job.lines.find((line) => /docker/i.test(line.code));
      if (docker) problems.push(`${name}: job \`${job.id}\` runs on ubuntu-slim but names docker (line ${docker.number}), which slim does not have`);
      const timeout = keysOf(job).find(({ key }) => key === "timeout-minutes");
      const minutes = timeout?.value.replace(/^(["'])(.*)\1$/, "$2");
      if (!timeout) problems.push(`${name}: job \`${job.id}\` runs on ubuntu-slim with no timeout-minutes; ${CAP}`);
      else if (!/^\d+$/.test(minutes) || Number(minutes) > SLIM_TIMEOUT_MINUTES) {
        problems.push(`${name}: job \`${job.id}\` runs on ubuntu-slim with timeout-minutes ${timeout.value}; ${CAP}`);
      }
    }
  }
  return problems;
}
