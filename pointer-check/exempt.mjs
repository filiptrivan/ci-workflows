// Which files the check skips: the paths every repo exempts, then the repo's own `exempt` setting, a
// path prefix or a glob each, where a `!` entry includes again and the last match wins.

// Dated snapshots stay true as of their date, so a pointer in one is history, not a claim.
const DEFAULT_EXEMPT = ["docs/adr/", "docs/plans/", "docs/incidents/", "**/node_modules/**"];

function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      source += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

// Whether a root-relative path is exempt, given the entries of the repo's own setting.
export function exemptMatcher(configured) {
  const entries = [...DEFAULT_EXEMPT, ...configured];
  const tests = entries.map((raw) => {
    const include = raw.startsWith("!");
    const entry = include ? raw.slice(1) : raw;
    if (/[*?]/.test(entry)) {
      const pattern = globToRegExp(entry.endsWith("/") ? `${entry}**` : entry);
      return { include, test: (path) => pattern.test(path) };
    }
    const prefix = entry.endsWith("/") ? entry : `${entry}/`;
    return { include, test: (path) => path === entry || path.startsWith(prefix) };
  });
  return (path) => {
    let exempt = false;
    for (const { include, test } of tests) if (test(path)) exempt = !include;
    return exempt;
  };
}
