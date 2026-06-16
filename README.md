# ci-workflows

Shared CI for our projects. Currently one thing: the reusable **Claude review gate**
(`.github/workflows/claude-gate.yml`).

## What the gate does

Every PR gets a hardened Claude (Opus) review that posts inline comments + a summary and
sets a blocking **`claude-gate`** status check. Routine PRs merge with **no human review**;
changes to owner-reserved areas escalate to the repo owner. The gate re-reviews on every
push (suppressing nits on re-review) and **fails closed** (red) if anything goes wrong.

**Used by:** `pa-cms`, `pa-storefront`, `stridon-presentational-websites` — each a ~30-line
caller. All the logic lives here, once.

## How the prompt is split (why one workflow fits every repo)

| Part | Where | Per-repo? |
|---|---|---|
| **Framework** — *how* to review (severity tags, nit cap, re-review suppression, verification bar, the `claude-verdict.json` protocol) | here, shared | no |
| **Spec** — *what* to review for (block class, owner-reserved, conventions, skip globs) | the caller's `review_spec` input | **yes** |

Adding a repo = write its `review_spec` + paste the caller boilerplate. You never touch the
shared logic.

---

## Runbook: add the gate to a new repo

### 1. Set the secret (one-time, per repo)
Personal-account repos have no org secrets, so each repo needs its own. From your terminal
(so the token isn't echoed anywhere):
```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <owner>/<repo>
# paste the same token the other repos use
```

### 2. Add the caller — `.github/workflows/claude-review.yml`
```yaml
name: Claude Code Review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]
concurrency:
  group: claude-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    permissions:
      contents: read
      pull-requests: write
      issues: write
      checks: write
      id-token: write
      actions: read
    uses: filiptrivan/ci-workflows/.github/workflows/claude-gate.yml@v1
    with:
      # same_repo_only: true   # PUBLIC repos only: skip fork PRs (they run without secrets)
      review_spec: |
        <one line on what the repo is>

        BLOCK CLASS (hard-block — high bar, objectively checkable):
        - <thing 1 that must never merge>
        - a committed secret/credential, or PII in a response/log.

        OWNER-RESERVED: <areas the owner must sign off on even if correct>.

        CONVENTIONS (advisory): <repo conventions; everything here is non-blocking>.

        SKIP: <generated/build output to ignore>.
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### 3. Write a good `review_spec`
- **BLOCK CLASS** → only **objectively-checkable, expensive-to-catch-later** things (a low-precision
  block class produces false-red gates that get ignored). Keep it to 2–4 items. "Security" in
  general is too fuzzy — name concrete patterns (e.g. *secret leaked via a client bundle*).
- **OWNER-RESERVED** → things the owner must approve *even when correct* (money, irreversible
  data/schema, cross-cutting patterns). These get the `awaiting-owner` label + an `@owner` ping.
- **CONVENTIONS** → advisory only; the gate comments but never blocks on these.
- **SKIP** → generated/vendored code so the reviewer doesn't waste turns or nitpick it.

### 4. Add `.github/CODEOWNERS`
Pin the owner-reserved paths to the owner so those PRs require their approval:
```
/path/to/owner-reserved-area/   @filiptrivan
```

### 5. Add the ruleset (enforcement)
Rulesets are free on public repos; private repos need GitHub Pro.
```bash
gh api -X POST repos/<owner>/<repo>/rulesets --input - <<'JSON'
{
  "name": "default branch — claude-gate + code owners",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [ { "context": "claude-gate" } ] } },
    { "type": "non_fast_forward" },
    { "type": "deletion" }
  ],
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ]
}
JSON
```
`required_approving_review_count: 0` = routine PRs need **zero** humans; `require_code_owner_review`
= owned-path PRs need the owner. The admin bypass lets the owner push/merge directly via
`gh pr merge --admin` (the override is explicit, not automatic).

### 6. Validate (it can't self-test)
The action **refuses to run on a PR that modifies its own workflow** (anti-token-exfiltration —
it requires the caller workflow to match the default branch). So the PR that *adds* the caller
always fails its own `claude-gate`. Therefore:
1. `gh pr merge <pr> --admin --rebase` the caller PR (workflow PRs always need `--admin`).
2. Open a throwaway PR that doesn't touch `.github/` → confirm `claude-gate` goes **green**.
3. Optional: a deliberately-blocking change → confirm **red** with a cited reason.

---

## Inputs

| input | required | default | meaning |
|---|---|---|---|
| `review_spec` | yes | — | the per-repo block class / owner-reserved / conventions / skip |
| `model` | no | `opus` | Claude model (`sonnet` if you hit the weekly cap) |
| `same_repo_only` | no | `false` | PUBLIC repos: skip fork PRs (no secrets on forks) |
| `owner_handle` | no | `filiptrivan` | GitHub handle @mentioned on owner-reserved escalation |
| `arch_audit` | no | `false` | Opt-in: adds a non-blocking architecture / tech-debt lens on the touched code. In-PR debt → 🟡 comment; bigger pre-existing legacy → one tracked `tech-debt`+`audit:claude` issue (first round only, deduped on open+closed fingerprints). Never affects the verdict. Requires the `tech-debt` and `audit:claude` labels to exist in the caller repo. |

Secret: `CLAUDE_CODE_OAUTH_TOKEN` (passed by the caller from its own repo secret).

---

## Releasing changes (maintainers only)

**This repo is the root of trust** — a change here runs with *every* caller's token. It is
**solo-maintained by @filiptrivan**; write access is not granted to anyone else. Callers pin
`@v1`, so to ship a change: edit `claude-gate.yml`, push to `main`, then move the `v1` tag
(`git tag -f v1 && git push -f origin v1`). The anti-footgun ruleset blocks force-push/deletion
on `main`; intentional history changes require disabling it first.

### Gotchas when editing `claude-gate.yml`
- **Verdict transport:** the pinned `claude-code-action` build does **not** surface
  `--json-schema` structured output, so the verdict is written to `claude-verdict.json` (via the
  `Write` tool) and read back in the gate step. Don't "simplify" this to `--json-schema`.
- **jq `//` footgun:** never `jq '.blocking // true'` — jq's `//` treats `false` as empty, so a
  correct `false` flips to `true` and the gate never passes. Compare booleans explicitly.
- **Fail-closed is intentional:** a missing/unparseable verdict, an action error, or a flake all
  produce a red gate, never a silent green.
