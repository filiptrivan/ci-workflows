// The heading pointer: a file pointer, an arrow and a quoted text. This file finds one after a file
// pointer, lists what a Markdown file holds for it to land on, and matches and ranks its text
// against those targets. A Markdown file, an arrow and an unquoted word fail with a refusal.

import { posix } from "node:path";
import { extensionOf, MARKDOWN_EXTENSIONS, markdownLines } from "./scan.mjs";

// What follows a file pointer to make it a heading pointer.
const HEADING_AFTER = /^\s*(→|->)\s*"([^"]+)"/;
// The same with a word in place of the quoted text, emphasis or a quote mark that is not `"` ahead
// of it: `GLOSSARY.md` → Ready frontier, `GLOSSARY.md` → **Pool**, `zone-move.md` → 4A.
const UNQUOTED_HEADING_AFTER = /^\s*(→|->)\s*[*_“”„‘'«]*([\p{L}\p{N}].*)/u;

// The heading pointer that follows a file pointer's backticked span, `after` the text after the
// span; undefined when none does.
export function headingPointerAfter(filePointer, span, after, { repo, file }) {
  const quoted = HEADING_AFTER.exec(after);
  const unquoted = UNQUOTED_HEADING_AFTER.exec(after);
  if (quoted && filePointer.located) return headingPointer(filePointer, quoted[1], quoted[2], { repo, file });
  if (unquoted && filePointer.located && MARKDOWN_EXTENSIONS.has(extensionOf(filePointer.display))) {
    return unquotedHeadingPointer(span, unquoted[1], unquoted[2]);
  }
  return undefined;
}

// What a heading pointer may land on in one Markdown text: each heading, each table row's first
// cell and each bold run that opens a line or a list item, as { key, isHeading }.
// A bold run that wraps counts to its line's end: the frozen TODO ledger's item titles wrap.
export function headingTargetsIn(text) {
  const found = [];
  for (const { text: line } of markdownLines(text)) {
    const title = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)?.[1];
    const other =
      /^\s*\|((?:[^|\\]|\\.)*)\|/.exec(line)?.[1] ??
      /^[\s>]*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?\*\*(.+?)(?:\*\*|$)/.exec(line)?.[1];
    const key = headingKey(title ?? other ?? "");
    if (key) found.push({ key, isHeading: title !== undefined });
  }
  return found;
}

// A file pointer's heading: how many targets in the files it lands on the quoted text names, by
// their whole text or by their lead, the text before a qualifier ("Where a fact goes" names
// `## Where a fact goes (2026-10-03)`), counting only the best-ranked (rankOf). Leads are how the
// tree cites (67 of the umbrella's 194 resolving heading pointers, measured 2026-10-25), and a
// qualifier carries dates that change; the price is that a removed heading whose text leads a
// surviving one goes unseen. A bare file name names the file beside the pointer's own when there
// is one, as a reader takes it, unless that is the pointer's own file (a nested `CLAUDE.md` naming
// `CLAUDE.md` means the root's). Skipped unless the file pointer itself resolves, which fails it
// otherwise.
function headingPointer(filePointer, arrow, text, { repo, file }) {
  return {
    display: `\`${filePointer.display}\` ${arrow} "${text}"`,
    heading: true,
    resolve: () => {
      if (filePointer.resolve() !== 1) return undefined;
      const { owner, path } = filePointer.located();
      const beside = owner === repo && !path.includes("/") ? posix.join(posix.dirname(file), path) : undefined;
      const landed = beside !== file && owner.fileSet.has(beside) ? [beside] : owner.pathTargets(path);
      const files = landed.filter((markdown) => MARKDOWN_EXTENSIONS.has(extensionOf(markdown)));
      if (files.length === 0) return undefined;
      const key = headingKey(text);
      const ranks = files
        .flatMap((markdown) => owner.headingTargets(markdown).map((target) => rankOf(target, key)))
        .filter((rank) => rank !== undefined);
      if (ranks.length === 0) return 0;
      const best = Math.min(...ranks);
      return ranks.filter((rank) => rank === best).length;
    },
  };
}

// A heading named without quotes fails wherever its file is, a sibling's that is not checked out
// too, and lands on nothing: where its text ends ("→ Ready frontier): first") is a guess, and a wrong
// guess would fail a pointer whose heading exists. The text the message quotes is cut at the first
// mark that ends a heading in prose, a hint for its writer, never resolved.
const UNQUOTED_HEADING_END = /[()[\]{},;:!?"“”„«»*_`|<>→—–]|\.(?=\s+[^a-z]|\s*$)|\s-+>?\s/;

function unquotedHeadingPointer(span, arrow, rest) {
  const text = rest.split(UNQUOTED_HEADING_END)[0].replace(/\s+/g, " ").trim();
  return {
    refusal: `${span} ${arrow} ${text} names a heading without quotes: write ${span} ${arrow} "${text}"`,
    resolve: () => 0,
  };
}

// A lead ends at a qualifier's opening punctuation; a section number (`7.1`) leads its title too.
const LEAD_END = /^(?:\s*[([—–→]|[.,:;!?](?:\s|$)|\s+-\s)/;
const SECTION_NUMBER = /^\d+(?:\.\d+)*\.?$/;

// How well a target answers a heading pointer's text, lower is better; undefined when it does not.
// A heading outranks a table key or bold run, then a whole text outranks a lead, so the bold
// summary line naming a section below it, or a longer heading the text only leads, is not a
// second target.
function rankOf(target, key) {
  if (!target.key.startsWith(key)) return undefined;
  const rest = target.key.slice(key.length);
  const lead = LEAD_END.test(rest) || (SECTION_NUMBER.test(key) && /^\s/.test(rest));
  if (rest !== "" && !lead) return undefined;
  return (target.isHeading ? 0 : 2) + (rest === "" ? 0 : 1);
}

// What a heading pointer's text and a target are compared as: case, emphasis, strikethrough, code
// backticks, curly apostrophes and curly double quotes never decide a match. A pointer's text
// cannot hold a straight double quote, so it quotes a title's own as curly ones (the frozen
// TODO ledger's `**"Pozovi kurira" is not idempotent`).
function headingKey(text) {
  return text
    .replace(/[`*~]/g, "")
    .replace(/’/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
