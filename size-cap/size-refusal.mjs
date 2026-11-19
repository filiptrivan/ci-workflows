// The text of a Size cap refusal for a file over its cap (size-cap.mjs judges which): its size
// and cap, the split recipe for its kind of file, the repo's guide for that kind, and the footer.
// The recipes name no repo's files, so every repo, a public one too, reads the same words.

export const SPLIT =
  "Split it before you commit, as its own commit, before your change. Split by design, never by\n" +
  "line count: each new file does one job behind a small interface and is named for that job.\n" +
  "A split that only spreads the same code over more files fails review.";

export const FOOTER =
  "If a script or tool writes this file, mark it `linguist-generated` in .gitattributes in this\n" +
  "same commit instead. --no-verify does not help: CI runs the same check on the push.";

export const RECIPES = {
  code:
    "1. List the jobs this file does: groups of functions that call each other and share state,\n" +
    "   and seldom call the rest.\n" +
    "2. Move each job into its own file, behind the smallest interface its callers need. Each\n" +
    "   caller imports a name from the file that holds it. The original path stays only when it\n" +
    "   does work behind a small interface, and no file re-exports (`export … from`).\n" +
    "3. C#: a class over the cap holds more than one responsibility. Extract a class (a policy,\n" +
    "   a calculator, a builder), never a `partial` class that only spreads one class over files.\n" +
    "4. Run the tests. Behavior does not change in this commit.",
  test:
    "Split with the code under test: one test file per module. If the module stays whole, split by\n" +
    "behavior, one file per top-level describe, and move the shared fixtures and builders into\n" +
    "<name>.fixtures.<ext>.",
  template: "Extract a child component for each panel or repeated block, with inputs and outputs.",
  markdown:
    "Keep <name>.md at its path as the index. Move each ## section word for word into <name>/.\n" +
    "The index is a table whose first cell is each moved section's old heading, so every\n" +
    "`<name>.md → \"Section\"` pointer still resolves. Lose nothing; reword nothing.",
  glossary: "Split the group by kind of work into two groups, and update the index lines that name them.",
  skill:
    "Move a branch beyond the core steps into a sibling file in the skill's folder, behind a\n" +
    "pointer that names the branch.",
  resident:
    "Starting with the lines you added, keep only what most sessions that load this file need. Move\n" +
    "each other line to the doc or skill where its reader looks, leaving at most a one-line pointer.",
  data: "Split by concern: a workflow per group of jobs, translations per feature, alert rules per area.",
};

/**
 * Which recipe a file takes, read from its path. Among Markdown, a resident file first, since a
 * directory-scoped `CLAUDE.md` sits in `.claude/skills/` too. A rule file under `.claude/rules/` is
 * resident: Claude Code loads every `.md` file there, in a subfolder too
 * (code.claude.com/docs/en/memory, read 2026-11-14). So the split recipe would only add files that
 * load. Only a skill's Markdown takes the skill's recipe, which moves a branch of prose; its
 * scripts and data take their own kind's (on 2026-11-04 three over-cap files in skill folders were
 * Python scripts).
 */
function kindOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/\.(test|spec)\./.test(name) || name.endsWith("Tests.cs")) return "test";
  if (name.endsWith(".component.html")) return "template";
  if (/\.mdx?$/.test(name)) {
    if (name === "CLAUDE.md" || name === "AGENTS.md" || /(^|\/)\.claude\/rules\//.test(path)) return "resident";
    if (path.startsWith("glossary/")) return "glossary";
    if (/(^|\/)\.claude\/skills\//.test(path)) return "skill";
    return "markdown";
  }
  if (/\.(ya?ml|jsonc?)$/.test(name)) return "data";
  return "code";
}

const grouped = (number) => String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const tokens = (bytes) => `${grouped(Math.ceil(bytes / 4))} tokens`;

/**
 * The refusal of a file over its cap: its size and its `cap`, with the mark that narrowed it when
 * `narrowedBy` names one, then the recipe for its kind and the repo's guide for that kind from
 * `guides`, then the footer. A resident file is cut line by line, so it takes no split.
 */
export function sizeRefusal({ path, bytes, cap, narrowedBy }, guides) {
  const limit = `${tokens(cap)} (${grouped(cap)} bytes)`;
  const capIs = narrowedBy ? `Its cap is ${limit}, narrowed by its ${narrowedBy} mark in .gitattributes.` : `The cap is ${limit}.`;
  const kind = kindOf(path);
  const advice = [kind === "resident" ? RECIPES.resident : `${SPLIT}\n\n${RECIPES[kind]}`];
  if (guides[kind]) advice.push(`This repo's guide: ${guides[kind]}.`);
  return `size cap: ${path} is ${grouped(bytes)} bytes = ${tokens(bytes)} (bytes/4). ${capIs}\n\n${advice.join("\n\n")}\n\n${FOOTER}\n`;
}
