#!/usr/bin/env node
// The rule that no job runs on `ubuntu-latest`, every package a job fetches from npm at run time
// names a version, and every setup-node step reads its Node from a `.nvmrc`, read as `workflows.mjs`
// reads a workflow. Why the rule: `pins.test.mjs`'s header.
// Another repo's step runs it over its own workflows, their pending `.afk/workflows/` patches
// applied, and fails on any problem:
//
//   node pins.mjs [--root <dir>]     <dir> defaults to the current directory

import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { effectiveWorkflows, indentOf, jobsOf } from "./workflows.mjs";

/**
 * The job's lines as shell reads them: a line ending in `\` joined with the next, each command its
 * first line's `number`. Any line counts, a heredoc's too, since a heredoc can write a command that
 * runs later (a Playwright config's `webServer`).
 */
function commandLines(job) {
  const commands = [];
  let open = null;
  for (const { number, code } of job.lines) {
    const command = open ? { number: open.number, code: `${open.code} ${code.trim()}` } : { number, code };
    open = /\\\s*$/.test(command.code) ? { number: command.number, code: command.code.replace(/\\\s*$/, "") } : null;
    if (!open) commands.push(command);
  }
  if (open) commands.push(open);
  return commands;
}

/**
 * The words of each command `program` starts on `code`, quotes stripped, up to the operator or the
 * closing quote that ends it.
 */
function commandsOf(program, code) {
  const starts = new RegExp(`(?:^|[\\s'"(;&|])${program}(?=\\s)`, "g");
  return [...code.matchAll(starts)].map((start) => {
    const words = [];
    for (const word of code.slice(start.index + start[0].length).trim().split(/\s+/)) {
      if (/^(&&|\|\|?|;|&|\))$/.test(word)) break;
      words.push(word.replace(/^["'`]+|["'`,;)]+$/g, ""));
      if (/[;)]$|^[^"']*["'][,;)]*$/.test(word)) break;
    }
    return words;
  });
}

// npm's `install` and its aliases (`npm help install`).
const INSTALL = new Set(["install", "add", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall"]);

// npm options that take a value, so the word after one is neither `install` nor a package. Another
// such option written with a space reads its value as a package: write it `--option=value`.
const VALUE_OPTIONS = new Set(["--prefix", "--registry", "--location", "--tag", "--cache", "--userconfig"]);

/** The packages each `npm install -g` on `code` installs. */
function globalInstalls(code) {
  return commandsOf("npm", code).flatMap((words) => {
    const global = words.some((word, at) => word === "-g" || word === "--global" || word === "--location=global" || (word === "--location" && words[at + 1] === "global"));
    const [subcommand, ...packages] = words.filter((word, at) => !word.startsWith("-") && !VALUE_OPTIONS.has(words[at - 1]));
    return global && INSTALL.has(subcommand) ? packages : [];
  });
}

/**
 * The packages each `npx --yes` on `code` fetches: its `--package` ones, else the command it runs.
 * A bare `npx` is left out, though in CI it fetches too ("When standard input is not a TTY or a CI
 * environment is detected, `--yes` is assumed", npm-exec, npm 10): from the text alone, a project
 * dependency's own binary (`npx ng`, `npx playwright`) cannot be told from a download.
 */
function npxFetches(code) {
  return commandsOf("npx", code).flatMap((words) => {
    let yes = false;
    const packages = [];
    let at = 0;
    for (; at < words.length && words[at].startsWith("-"); at += 1) {
      const word = words[at];
      if (word === "-y" || word === "--yes") yes = true;
      else if (word === "-p" || word === "--package") packages.push(words[++at]);
      else if (word.startsWith("--package=")) packages.push(word.slice("--package=".length));
      else if (word === "--") {
        at += 1;
        break;
      }
    }
    if (!yes) return [];
    return packages.length ? packages : words.slice(at, at + 1);
  });
}

/** A registry package, `name` or `@scope/name`, and what is written after its `@`. */
const PACKAGE = /^((?:@[\w.~-]+\/)?[\w.~-]+)(?:@(.+))?$/;

/**
 * Whether `spec` names a registry package and no version for it. `latest` is npm's tag for whatever
 * is newest that day, so it names none; a path, a URL or a shell variable names no registry package.
 */
function unversioned(spec) {
  const match = PACKAGE.exec(spec ?? "");
  return Boolean(match) && (match[2] === undefined || match[2] === "latest");
}

/**
 * The job's lines outside its `steps:`, where it names its runner (`runs-on:`, a matrix); a step's
 * name, script or heredoc may mention a runner it does not run on.
 */
function outsideSteps(job) {
  const body = job.lines.filter((line) => line.code.trim());
  const keyIndent = body.length ? indentOf(body[0].code) : 0;
  let inSteps = false;
  return body.filter((line) => {
    if (indentOf(line.code) === keyIndent) inSteps = /^\s*steps:/.test(line.code);
    return !inSteps;
  });
}

/**
 * The job's steps, each the lines from its `-` to the next step's, a step written at its `steps:`
 * key's own indent included.
 */
function stepsOf(job) {
  const body = job.lines.filter((line) => line.code.trim());
  const keyIndent = body.length ? indentOf(body[0].code) : 0;
  const steps = [];
  let inSteps = false;
  let dash = null;
  for (const line of body) {
    const depth = indentOf(line.code);
    const item = /^\s*-(\s|$)/.test(line.code);
    if (depth === keyIndent && !item) inSteps = /^\s*steps:/.test(line.code);
    else if (inSteps) {
      if (item && depth === (dash ??= depth)) steps.push([]);
      steps.at(-1)?.push(line);
    }
  }
  return steps;
}

const SETUP_NODE = /^\s*(-\s+)?uses:\s*["']?actions\/setup-node@/;

/**
 * How a setup-node step sets up a Node other than the one a `.nvmrc` names, naming the line, or null
 * when it reads a `.nvmrc`: a `node-version`, which setup-node takes over a `node-version-file` (its
 * docs/advanced-usage.md), else a `node-version-file` naming another file, or none.
 */
function nodeProblem(step) {
  const key = (name) => step.find((line) => new RegExp(`^\\s*${name}:`).test(line.code));
  const version = key("node-version");
  if (version) return `writes its Node version in setup-node (line ${version.number})`;
  const file = key("node-version-file");
  const path = file?.code.replace(/^[^:]*:\s*/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
  if (/(^|\/)\.nvmrc$/.test(path ?? "")) return null;
  return `runs setup-node with no .nvmrc to read (line ${(file ?? step.find((line) => SETUP_NODE.test(line.code))).number})`;
}

/** How a problem with `spec`, read on line `number`, is mended. */
const nameOne = (spec, number) => `with no version (line ${number}); name one, ${spec.replace(/@latest$/, "")}@<version>`;

/**
 * What breaks the pin rule in `workflows` (`{ name, text }` each), one line per problem naming the
 * workflow, the job and the line: a job that names `ubuntu-latest` outside a comment and its steps,
 * its matrix included, each package a job fetches from npm at run time with no version, and each
 * setup-node step that reads its Node from no `.nvmrc`.
 */
export function pinProblems(workflows) {
  const problems = [];
  for (const { name, text } of workflows) {
    for (const job of jobsOf(text)) {
      const where = `${name}: job \`${job.id}\``;
      const latest = outsideSteps(job).find((line) => /\bubuntu-latest\b/.test(line.code));
      if (latest) problems.push(`${where} runs on ubuntu-latest (line ${latest.number}); name a version, ubuntu-24.04`);
      for (const { number, code } of commandLines(job)) {
        for (const spec of globalInstalls(code).filter(unversioned)) problems.push(`${where} installs ${spec} globally ${nameOne(spec, number)}`);
        for (const spec of npxFetches(code).filter(unversioned)) problems.push(`${where} runs ${spec} through npx -y ${nameOne(spec, number)}`);
      }
      for (const step of stepsOf(job).filter((step) => step.some((line) => SETUP_NODE.test(line.code)))) {
        const problem = nodeProblem(step);
        if (problem) problems.push(`${where} ${problem}; read the Node from .nvmrc, node-version-file: .nvmrc`);
      }
    }
  }
  return problems;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function main(argv) {
  let root = ".";
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] === "--root" && argv[at + 1] !== undefined) root = argv[++at];
    else {
      console.error(`pins: unknown argument ${argv[at]}; usage: node pins.mjs [--root <dir>]`);
      return 2;
    }
  }
  const dir = join(resolve(root), ".github/workflows");
  let workflows;
  try {
    // A pending patch that does not apply throws, naming itself.
    workflows = existsSync(dir) ? effectiveWorkflows(root) : [];
  } catch (error) {
    console.log(`pins: the workflows under ${dir} could not be read: ${error.message}`);
    return 1;
  }
  if (workflows.length === 0) {
    console.log(`pins: no workflow read under ${dir}, so nothing was checked`);
    return 1;
  }
  const problems = pinProblems(workflows);
  for (const problem of problems) console.log(problem);
  console.log(
    problems.length
      ? `pins: ${plural(problems.length, "problem")}`
      : `pins: no job runs on ubuntu-latest, fetches an npm package with no version or sets up Node from anything but .nvmrc (${plural(workflows.length, "workflow")})`,
  );
  return problems.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
