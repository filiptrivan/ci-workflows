// The rule every `ubuntu-slim` job keeps, read from the workflow text rather than parsed YAML: this
// repo installs nothing and Node ships no YAML parser. Why the rule: `slim-jobs.test.mjs`'s header.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const isWorkflow = (name) => /\.ya?ml$/.test(name);

/**
 * `root`'s workflows as they take effect, `{ name, text }` each: `.github/workflows/` with every
 * `.afk/workflows/<file>.patch` applied, an edit that waits there as `git diff` output against the
 * committed workflow until it is applied and `.afk/` removed. Applied in a scratch copy, so the
 * tree is left as it was.
 */
export function effectiveWorkflows(root) {
  // Absolute, since the patches are applied from inside the copy.
  root = resolve(root);
  const scratch = mkdtempSync(join(tmpdir(), "effective-workflows-"));
  try {
    // Its own repository, so the patches' paths resolve against the copy's top level.
    execFileSync("git", ["init", "-q"], { cwd: scratch });
    cpSync(join(root, ".github/workflows"), join(scratch, ".github/workflows"), { recursive: true });
    const pending = join(root, ".afk/workflows");
    const patches = existsSync(pending) ? readdirSync(pending).filter((name) => name.endsWith(".patch")) : [];
    for (const patch of patches.sort()) execFileSync("git", ["apply", join(pending, patch)], { cwd: scratch, stdio: "pipe" });
    const workflows = join(scratch, ".github/workflows");
    return readdirSync(workflows)
      .filter(isWorkflow)
      .sort()
      .map((name) => ({ name, text: readFileSync(join(workflows, name), "utf8") }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A line's YAML before its comment; a comment may say why a job has no Docker. */
function withoutComment(line) {
  return /^\s*#/.test(line) ? "" : line.replace(/\s#.*$/, "");
}

const indentOf = (line) => line.length - line.trimStart().length;

/** Each job under `jobs:` as `{ id, lines }`, every line its 1-based `number` and its `code`. */
function jobsOf(text) {
  const lines = text.split(/\r?\n/).map((line, index) => ({ number: index + 1, code: withoutComment(line) }));
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line.code));
  if (start < 0) return [];
  const jobs = [];
  let indent = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.code.trim()) {
      jobs.at(-1)?.lines.push(line);
      continue;
    }
    const depth = indentOf(line.code);
    if (depth === 0) break;
    indent ??= depth;
    if (depth === indent) jobs.push({ id: line.code.trim().replace(/:.*$/, ""), lines: [] });
    else jobs.at(-1)?.lines.push(line);
  }
  return jobs;
}

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
