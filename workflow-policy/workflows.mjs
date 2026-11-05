// How the workflow-policy rules read a repo's workflows: from the text rather than parsed YAML, since
// this repo installs nothing and Node ships no YAML parser.

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

/** A line's YAML before its comment, so the words a comment uses never count as a job's. */
function withoutComment(line) {
  return /^\s*#/.test(line) ? "" : line.replace(/\s#.*$/, "");
}

export const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Each job under `jobs:` as `{ id, lines }`, every line its 1-based `number` and its `code`, the
 * YAML before its comment.
 */
export function jobsOf(text) {
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
