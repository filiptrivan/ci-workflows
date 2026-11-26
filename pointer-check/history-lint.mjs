// The history lint: the resident files it judges and the notes it refuses in them. What a resident
// file holds, and why: the header of pointer-check.mjs.

import { maskSpans } from "./scan.mjs";

// The resident files.
export const RESIDENT = /(?:^|\/)(?:CLAUDE|AGENTS)\.md$|(?:^|\/)\.claude\/rules\/.+\.md$/;
// `#123`, `repo#123` or `owner/repo#123`, never inside a word, an HTML entity (`&#38;`) or a URL.
const ISSUE_NUMBER = /(?<![\w&#/.-])(?:[A-Za-z][\w.-]*(?:\/[A-Za-z0-9][\w.-]*)?)?#\d+(?![\w-])/g;
// A Markdown link's target, blanked so a heading anchor (`GLOSSARY.md#1-term`) is no issue number.
const LINK_TARGET = /\]\([^)]*\)/g;
const HISTORY_REASON = "a resident file holds a rule and its reason, its history goes in the commit message or an ADR";

// The history notes in one line of a resident file, `next` the line after it: a who-and-when note
// is a teammate's name, at most three words, then a date ("(Filip, 2026-10-27", "Mira 2026-10-30",
// "Filip's ask, 2026-10-25"), and wraps onto the next line as often as not. With no teammates
// named, only issue numbers are notes.
export function historyNotes(teammates = []) {
  const names = teammates.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const kinds = [{ pattern: ISSUE_NUMBER, kind: "an issue number" }];
  if (names) {
    const letter = "[\\p{L}\\p{N}_]";
    const pattern = new RegExp(
      `(?<!${letter})(?:${names})(?:['’]s)?(?!${letter})(?:[\\s,(]+\\p{L}+){0,3}?[\\s,(]+\\d{4}-\\d{2}-\\d{2}(?!\\d)`,
      "gu",
    );
    kinds.push({ pattern, kind: "a who-and-when note" });
  }
  return (text, next) => {
    const masked = maskSpans(`${text}\n${next}`).replace(LINK_TARGET, (target) => " ".repeat(target.length));
    // A note that opens on the next line is the next line's own.
    return kinds.flatMap(({ pattern, kind }) =>
      [...masked.matchAll(pattern)]
        .filter((match) => match.index < text.length)
        .map((match) => ({
          column: match.index,
          history: true,
          message: `\`${match[0].replace(/\s+/g, " ")}\` is ${kind}: ${HISTORY_REASON}`,
        })),
    );
  };
}
