# A.7 — CI / Supply-Chain Hygiene

Wave A.7. Adds cheap, deterministic, GitHub-Actions-only supply-chain controls.
**Constraint honoured:** the repo is public (GitHub Actions minutes are free at
current usage), while **Vercel production builds are the metered cost**. Nothing
here triggers a Vercel build — every control is a GitHub-hosted job or a pure
filesystem test. Nothing is added to `ci.yml`'s six-gate pipeline or its
triggers.

## What was added

| Control | File | Cost / Vercel impact |
|---|---|---|
| Secret scanning (gitleaks) | `.github/workflows/security-scan.yml` + `.gitleaks.toml` | Free GitHub Actions job; filesystem scan; **no Vercel build**. SHA-pinned action. |
| Dependency updates (Dependabot) | `.github/dependabot.yml` | Weekly, grouped minor/patch, low PR caps → low noise; update PRs run only the free gates, **no Vercel build**. |
| Duplicate-migration-prefix guard | `__tests__/db/migration-prefix-unique.test.ts` | Pure filesystem test in the existing unit tier (no new job, no DB). |

### Secret scanning — gitleaks
Runs on `pull_request` and `push` to `main`. Free for public repos (no
`GITLEAKS_LICENSE`). Delivered as a **separate** workflow, not a seventh job in
`ci.yml`, because `__tests__/ci/workflow-gates.test.ts` pins `ci.yml`'s `on:`
block to exactly two `main` occurrences — a standalone workflow leaves the
six-gate contract untouched. The action is **SHA-pinned** (`gitleaks-action`
v2.3.9 = `ff98106…`); a moving tag can't swap the code under us, and Dependabot's
github-actions ecosystem keeps the pin current. `.gitleaks.toml` extends the
default ruleset and adds a **narrow** allowlist for Stripe live-key *prefix
checks* and test fixtures (`sk_live_abc123`, `startsWith("sk_live_")`) — no real
secret is whitelisted, and no real secret is tracked (`.env*` is gitignored).

### Dependency updates — Dependabot
Weekly cadence (not daily), minor/patch **grouped** into one PR per ecosystem,
and low open-PR caps (npm 5, actions 3) → minimal noise and CI spend. Major npm
bumps stay ungrouped for individual review. Covers `npm` and `github-actions`.

### Duplicate-migration-prefix guard
Two migrations sharing a 14-digit prefix give Supabase an undefined apply order
and can cause skip/double-apply on `db push` (a class of bug this programme has
hit during release-train merges). The test reads `supabase/migrations/*.sql`,
extracts the 14-digit prefix, and asserts uniqueness — failing loudly with the
offending prefix and files. Baseline: **373 files, 373 unique prefixes, 0
duplicates.**

### Dependency vulnerability policy — `npm audit` stays advisory
`npm audit` remains **non-blocking** in the `security` gate of `ci.yml`
(`continue-on-error`). Rationale: it reads the *live* upstream advisory DB, so it
can turn red with zero code change the instant a CVE is published — a re-run
going green isn't a real pass, which violates the determinism policy and would
force unplanned major bumps mid-freeze. Security is instead carried
**proactively** by Dependabot (patches land continuously) + gitleaks (secrets
caught at commit), with `npm audit` surfacing the advisory report for deliberate
triage. This is a deliberate policy, not an oversight.

## Deliberately NOT added

- **CodeQL** — skipped for cost/noise. It's a heavyweight scanner with long runs
  and frequent low-signal findings on a large app surface; the marginal security
  value over gitleaks + Dependabot + the existing hermetic trust-boundary
  security tier does not justify the added CI time and triage load here. Revisit
  if a dedicated security-triage owner exists.
- **Rollback-automation job** — premature. There is a single production Supabase
  (no staging) with PITR, and deploys already follow branch → preview →
  human-approved merge. An automated rollback job would need a tested, rehearsed
  restore path and clear ownership; building it now would be speculative
  machinery ahead of a real, exercised recovery procedure. Documented here so
  the omission is a decision, not a gap.
- **Hard-blocking `npm audit`** — deliberately kept advisory (see policy above);
  making it a merge blocker trades determinism for flakiness.
