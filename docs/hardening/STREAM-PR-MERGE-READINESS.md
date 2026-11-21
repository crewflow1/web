# Stream PR — Merge-Readiness Matrix

Date: 2026-10-30 · Base: `main` @ `ea2a502c` · Reviewer: automated merge-readiness pass
(typecheck + unit tier + static/mocked security tier run locally; integration tier and
Playwright deliberately NOT run — single local Postgres owned by a coordinator).

## Verdict table

| PR | Domain | Local tests (pass/total) | GitHub CI | Mergeable | Verdict | Note |
|----|--------|--------------------------|-----------|-----------|---------|------|
| [#986](https://github.com/crewflow1/web/pull/986) | Portal (quote-token status gate) | 17/17 unit | all 8 checks green (observed) | MERGEABLE / CLEAN | **READY** | Fail-closed gate on public accept/decline for non-actionable quote statuses; additive. |
| [#993](https://github.com/crewflow1/web/pull/993) | Portal (void-invoice leaks) | 8/8 security · typecheck clean (local) | PARTIAL: gitleaks+Vercel green only — full suite did not run (PR targets the #986 branch, not main) | MERGEABLE / CLEAN | **READY** | Stacked on #986. Void-invoice gate on PDF route + bulk zip (defence-in-depth). Full CI will run once rebased onto main. |
| [#987](https://github.com/crewflow1/web/pull/987) | HQ (access-gate proofs) | 16/16 security | all 8 checks green (observed) | MERGEABLE / CLEAN | **READY** | Behavioural + completeness pins. Its two files are a strict subset of #990. |
| [#990](https://github.com/crewflow1/web/pull/990) | HQ (demo-promote consistency) | 20/20 (16 security + 4 unit) | all 8 checks green (observed) | MERGEABLE / CLEAN | **READY** | Supersets #987 (same two gate files) + demo-promote provisioning proofs. |
| [#988](https://github.com/crewflow1/web/pull/988) | Stripe (sandbox lifecycle harness) | 60/60 mocked (unit tier) | **gitleaks FAIL**; e2e/integration/lint/security/tests/typecheck green | MERGEABLE / **UNSTABLE** | **NEEDS-WORK** | gitleaks flags placeholder fixtures `sk_live_realmoney` / `rk_live_restricted` in `__tests__/stripe/sandbox-gate.test.ts` and `sk_test_LEAKCHECK`/`whsec_LEAKCHECK` in `__tests__/health/route-shape.test.ts`. Not real secrets, but the `sk_live_`/`rk_live_` pattern must be allowlisted or renamed before merge. Integration-tier `sandbox-lifecycle.test.ts` not run (per constraint). |
| [#991](https://github.com/crewflow1/web/pull/991) | Stripe (record-only lifecycle) | 10/10 unit | all 8 checks green (observed) | MERGEABLE / CLEAN | **READY** | Follow-up to #988; no live-key fixtures, gitleaks clean. |
| [#984](https://github.com/crewflow1/web/pull/984) | AI (quote-writer + insights) | 27/27 security | all 8 checks green (observed) | MERGEABLE / CLEAN | **READY** | Permission / cost-governor / injection / isolation coverage. |
| [#983](https://github.com/crewflow1/web/pull/983) | Comms (Resend + Sentry) | 36/36 unit | all 8 checks green (observed) | MERGEABLE / CLEAN | **READY** | Email send-wrapper + transactional templates. Subset of #989. |
| [#989](https://github.com/crewflow1/web/pull/989) | Comms + Ops (consolidated) | 56/56 (email + monitoring + ops + auth-iso) | all 8 checks green (observed) | MERGEABLE / CLEAN | **READY** | Consolidates #983 + #985 and adds scrub-fail-closed + auth-email-isolation. |
| [#985](https://github.com/crewflow1/web/pull/985) | Backups / DR | 15/15 unit | all 8 checks green (observed) | MERGEABLE / CLEAN | **READY** | Extracts pure `classifyBackupHealth` from `ops-snapshot.ts` (+124/-63 refactor, behaviour-preserving) and unit-pins it. Subset of #989. |

**Totals:** 9 of 10 READY · 1 NEEDS-WORK (#988) · 0 BLOCKED-ON-CRED. No PR's claimed tests FAIL on its head.

## Gate checks (all three confirmed for every PR)

- **(a) Additive / no test weakening / `lib/supabase/types.ts` untouched.** Confirmed. Every PR is ADDED test files plus, in three cases, additive production gates:
  - #986: `app/(app)/quotes/actions.ts` (+35/-0) — adds `CUSTOMER_ACTIONABLE_QUOTE_STATUSES` fail-closed check.
  - #993: `app/customer-portal/[token]/invoices/[id]/pdf/route.ts` (+11/-0) and `lib/customers/portal-bulk-download.ts` (+14/-1) — add `status === "void"` 404 / `.neq("status","void")` filters plus defence-in-depth row filter.
  - #985/#989: `server/services/ops-snapshot.ts` (+124/-63) — behaviour-preserving refactor extracting a pure classifier; no control relaxed.
  None of the ten diffs modifies `lib/supabase/types.ts`, and no existing test is edited or deleted (all deltas are new files except the three production files above).
- **(b) No merge conflict with main.** All ten report `mergeable: MERGEABLE`. Nine are `mergeStateStatus: CLEAN`; #988 is `UNSTABLE` solely because of the failing gitleaks check (not a conflict).
- **(c) Claimed tests pass on the PR head.** Verified locally on each fetched PR head (counts in the table). All green.

## The one flag — #988 (loud)

#988 is the only non-green PR. Its mocked coverage is fully passing (60/60), but the
**gitleaks secret-scan CI check FAILS** because test fixtures use the literal patterns
`sk_live_realmoney` and `rk_live_restricted` (in `__tests__/stripe/sandbox-gate.test.ts`)
and `sk_test_LEAKCHECK` / `whsec_LEAKCHECK` (in `__tests__/health/route-shape.test.ts`).
These are obviously-fake placeholders, not live credentials, but gitleaks matches the
Stripe live-key shape. **Resolution before merge:** add a `.gitleaksignore` / allowlist
entry for these fixture lines, or rename the fixtures so they don't match the live-key
regex. Until then #988 cannot land green. Its companion #991 is unaffected (no such
fixtures) and is READY.

## Overlap / merge-order note (informational — no merge performed)

Several PRs overlap by design: #987 ⊂ #990, #983+#985 ⊂ #989, and #993 is stacked on
#986. Merging the superset PRs (#990, #989) and the portal pair (#986 then #993) would
cover the subsets; landing both a subset and its superset would duplicate identical test
files. Sequencing is the human mer­ger's call — this report does not merge anything.
