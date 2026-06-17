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

### 1. Set the secret + labels (one-time, per repo)
Personal-account repos have no org secrets, so each repo needs its own. From your terminal
(so the token isn't echoed anywhere):
```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <owner>/<repo>
# paste the same token the other repos use
```
`arch_audit` is **on by default**, and its lens files `tech-debt`+`audit:claude` issues — create
those labels (or its `gh issue` calls fail), or set `arch_audit: false` in the caller to disable:
```bash
gh label create tech-debt     -R <owner>/<repo> --color fbca04 --description "Architectural debt or best-practice gap"
gh label create "audit:claude" -R <owner>/<repo> --color 5319e7 --description "Filed by the Claude review gate (arch_audit lens)"
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
| `arch_audit` | no | `true` | **On by default.** Non-blocking architecture / tech-debt lens on the touched code. In-PR debt → 🟡 comment; bigger pre-existing legacy → one tracked `tech-debt`+`audit:claude` issue (first round only, deduped on open+closed fingerprints). Never affects the verdict. **Requires the `tech-debt` and `audit:claude` labels in the caller repo** (runbook step 1). Set `false` to disable per caller. |
| `cross_repo` | no | `""` | Opt-in cross-repo contract check (prose): this repo's contract surface + which sibling to grep for consumer impact when the diff touches it. Empty = off. Findings → PR **summary only**. See [Cross-repo contract check](#cross-repo-contract-check-optional). |
| `cross_repo_private_sibling` | no | `""` | `owner/repo` of a PRIVATE sibling, checked out read-only via the `CROSS_REPO_DEPLOY_KEY` secret into `.cross-repo/<owner>/<repo>`. |
| `cross_repo_public_sibling` | no | `""` | `owner/repo` of a PUBLIC sibling, checked out (no key) into `.cross-repo/<owner>/<repo>`. |

Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (required); `CROSS_REPO_DEPLOY_KEY` (optional — read-only SSH
deploy key for the private sibling, only when `cross_repo_private_sibling` is set). Both passed by
the caller from its own repo secrets.

---

## Cross-repo contract check (optional)

`cross_repo` lets the review read a **sibling** repo to catch contract breakage (e.g. a backend DTO
change that breaks the storefront consumer). The sibling is checked out read-only under
`.cross-repo/<owner>/<repo>`; the reviewer greps it **only when the diff touches the contract surface**
(prose in `cross_repo`), and posts findings in the PR **summary** (inline can't target another repo).

**Private sibling — set up a read-only deploy key (no GitHub App needed):**
```bash
# read-only keypair; PUBLIC key -> deploy key on the SIBLING, PRIVATE key -> secret in THIS repo:
ssh-keygen -t ed25519 -N "" -f /tmp/k -C "claude-gate cross-repo read"
gh repo deploy-key add /tmp/k.pub -R <owner>/<sibling> --title "claude-gate cross-repo read"   # read-only (no --allow-write)
gh secret set CROSS_REPO_DEPLOY_KEY -R <owner>/<this-repo> < /tmp/k
rm -f /tmp/k /tmp/k.pub
```
Then in the caller set `cross_repo` (prose), `cross_repo_private_sibling: <owner>/<sibling>`, and pass
`CROSS_REPO_DEPLOY_KEY` in `secrets:`. A **public** sibling needs no key — just set
`cross_repo_public_sibling`. Each key is scoped to exactly one repo, read-only; works cleanly when a
caller has a single private sibling (one deploy key in the job → no SSH-agent key ambiguity).

## Releasing changes (maintainers only)

**This repo is the root of trust** — a change here runs with *every* caller's token. It is
**solo-maintained by @filiptrivan**; write access is not granted to anyone else. Callers pin
`@v1`, so to ship a change: edit `claude-gate.yml`, push to `main`, then move the `v1` tag
(`git tag -f v1 && git push -f origin v1`). The anti-footgun ruleset blocks force-push/deletion
on `main`; intentional history changes require disabling it first.

**⚠️ `v1` is a *moving* tag — resync before you move it.** A plain `git pull`/`git fetch` **never**
updates an existing local tag, so after each release your local `v1` silently goes stale (still points
at the previous commit) while the remote `v1` has advanced. Force-pushing from a stale checkout
(`git tag -f v1 && git push -f origin v1`) would shove the remote `v1` **backwards** and break every
caller pinned to `@v1`. Before releasing — or whenever local `v1` looks wrong — resync first: `git pull`
then `git fetch --tags --force` (a plain pull won't update the tag).

### Gotchas when editing `claude-gate.yml`
- **Verdict transport:** the pinned `claude-code-action` build does **not** surface
  `--json-schema` structured output, so the verdict is written to `claude-verdict.json` (via the
  `Write` tool) and read back in the gate step. Don't "simplify" this to `--json-schema`.
- **jq `//` footgun:** never `jq '.blocking // true'` — jq's `//` treats `false` as empty, so a
  correct `false` flips to `true` and the gate never passes. Compare booleans explicitly.
- **Fail-closed is intentional:** a missing/unparseable verdict, an action error, or a flake all
  produce a red gate, never a silent green.
- **`arch_audit` policy is hardcoded** (labels `tech-debt`/`audit:claude`, 1-issue/PR cap, fingerprint
  format) in the shared prompt — and it's now **on by default for every caller**. Extract those values
  to inputs (or a per-repo `audit_spec` symmetric with `review_spec`) the first time any caller needs
  different values. It's also gated in two places (the `gh issue` tools/turn bump in `claude_args` and
  the prompt section) — edit them as a pair.
