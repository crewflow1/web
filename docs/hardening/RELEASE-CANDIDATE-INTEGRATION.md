# Release-Candidate Integration, Deployment & Rollback Pack

**Scope:** the open PR queue for `crewflow1/web` as observed on **2026-10-30**.
**Base of record:** `main` @ `ea2a502c` (migration tip `20261241000000_admin_capability_model.sql`).
**Author constraint:** analysis only — no merges, no migration applies. Every claim below is
backed by `gh pr view` / `gh pr checks` / `git ls-tree` evidence captured on 2026-10-30.

> **CI honesty caveat.** "Full gate green" below means the eight-job CI matrix
> (`lint, tests, typecheck, security, integration, e2e, gitleaks, Vercel`) was observed passing
> via `gh pr checks`. Stacked PRs whose **base is not `main`** (#977, #981, #993) only ran
> `gitleaks` + `Vercel` — the full matrix did **not** execute, so their green status is **unproven**
> and must be re-earned once they are retargeted to `main`.

---

## 1. PR classification table

| PR | Branch → base | What it changes | Migration (prefix) | CI observed (2026-10-30) | Classification |
|----|---------------|-----------------|--------------------|--------------------------|----------------|
| **#975** | `feat/r5-job-assignments-phase1` → `main` | R5 Phase 1: `job_assignments` join table, DARK (RLS on, no client policy, grants revoked), idempotent backfill from `jobs.assigned_to`. +328/-40, 8 files | `20261242000000_job_assignments.sql` | **Full gate green** | **Ready-for-merge-approval** + **Depends-on-production-migration** (apply-held, access-policy-adjacent) |
| **#977** | `feat/r5-phase2-jobs-rls` → `feat/r5-job-assignments-phase1` | R5 Phase 2: `is_job_assignee()` SECDEF + `jobs` SELECT rewrite (staff see only assigned jobs; owner/admin unchanged). +428/-0 | `20261243000000_r5_phase2_jobs_assignment_rls.sql` | **Only `gitleaks`+`Vercel` ran** (base ≠ main) | **Depends-on-another-PR (#975)** + **Depends-on-production-migration** + **CI-incomplete** |
| **#980** | `feat/jobs-multi-worker-assignment` → `feat/r5-job-assignments-phase1` | Multi-worker assignment UI + `assignWorker/removeWorker` actions (gated on `jobs:manage`). +766/-0, 4 files. **Draft.** No migration in its own diff (inherits `20261242` from base) | — (inherits 242) | **Failing-CI** (`security (trust boundaries)` **fail**) + **Still-under-review** (draft) + **Depends-on-another-PR (#975)** |
| **#981** | `feat/r5-phase3-operational-rls` → `feat/r5-phase2-jobs-rls` | R5 Phase 3 slice 1: assignment-aware SELECT on `snags`, `site_diary_entries`, `site_reports`, `job_progress_observations`, `job_checklists` + caller reconciliation (offline-writes self-scoped lookup). +479/-17 | `20261244000000_...operational_child_rls.sql`, `20261245000000_...slice2.sql` | **Only `gitleaks`+`Vercel` ran** (base ≠ main) | **Depends-on-another-PR (#977→#975)** + **Depends-on-production-migration** + **CI-incomplete** |
| **#982** | `test/stripe-sales-led-lifecycle-coverage` → `main` | Mocked Stripe sales-led lifecycle unit tests (webhook signature + money-event transitions). +637/-0, tests only | — | **`e2e` fail**; rest green | **Failing-CI** |
| **#983** | `test/comms-resend-sentry-coverage` → `main` | Resend/Sentry transport unit coverage (36 tests). +658/-0, tests only | — | **Full gate green** | **Ready-for-merge-approval** — but **superseded by #989** (recommend close in favour of #989) |
| **#984** | `test/ai-launch-hardening` → `main` | AI quote-draft + insights permission/cost/injection coverage (20 tests, mocks + dark governor). +878/-0, tests only | — | **Full gate green** | **Ready-for-merge-approval** |
| **#985** | `ops/backup-dr-verification` → `main` | Backup/DR status doc + `classifyBackupHealth` pure-fn refactor of `ops-snapshot.ts` + 15 freshness tests. +463/-63 | — | **Full gate green** | **Ready-for-merge-approval** — but **superseded by #989** |
| **#986** | `harden/portal-quote-token-status-gate` → `main` | **Real security fix:** gate public quote accept/decline to `{approved,sent,viewed}` server-side (stale-token → `accepted` bypass closed). +106/-0 | — | **Full gate green** | **Ready-for-merge-approval** (prioritise — closes an authz bypass) |
| **#987** | `harden/hq-access-gate-tests` → `main` | HQ access-gate behavioural + completeness proofs (`requireHqApi/Page`). +356/-0, tests only | — | **Full gate green** | **Ready-for-merge-approval** |
| **#988** | `test/stripe-sandbox-lifecycle-harness` → `main` | Opt-in real-sandbox Stripe test (skips without key, refuses live keys) + mocked tiers. +1700/-0, tests+docs | — | **`gitleaks` fail**; rest green | **Failing-CI** + **Blocked-by-credentials** (real-sandbox path needs a Stripe **test** key to execute; skips by default) |
| **#989** | `ops/comms-recovery-launch-readiness` → `main` | Consolidates #983 + #985 + 2 new guards (scrub fail-closed, auth-email isolation) + launch-readiness doc. +1348/-63 | — | **Full gate green** | **Ready-for-merge-approval** (preferred merge unit over #983/#985) |
| **#990** | `harden/hq-business-flows-tests` → `main` | HQ business-flow coverage (demo→promote, onboarding atomicity, billing admin). +583/-0, tests only. Follow-up to #987 | — | **Full gate green** | **Ready-for-merge-approval** (independent of #987 — both base `main`) |
| **#991** | `test/stripe-record-only-lifecycle-coverage` → `main` | Executes 4 record-only webhook branches (payment_intent, customer upsert, action-required) — no charge/activation side effect. +347/-0, tests only. Follow-up to #988 | — | **Full gate green** | **Ready-for-merge-approval** (independent of #988 — mocked, no key) |
| **#992** | `test/first-customer-sim-e2e` → `main` | Multi-actor first-customer Playwright sim (11 serial tests; R5/HQ steps gated). +461/-0, one spec | — | **`e2e` fail + `gitleaks` fail**; rest green | **Failing-CI** |
| **#993** | `harden/portal-token-surface-deep` → `harden/portal-quote-token-status-gate` | **Real security fix:** close two **void-invoice** leaks (per-invoice PDF route + bulk-zip collector) carrying bank details. +120/-1 | — | **Only `gitleaks`+`Vercel` ran** (base ≠ main) | **Depends-on-another-PR (#986)** + **CI-incomplete** (prioritise — void-invoice leak) |

**Status buckets at a glance**

- **Ready-for-merge-approval (full gate green, base `main`):** #984, #986, #987, #989, #990, #991 (and #983/#985, which #989 supersedes).
- **Failing-CI (must fix before merge):** #980 (security), #982 (e2e), #988 (gitleaks), #992 (e2e + gitleaks).
- **Depends-on-another-PR / CI-incomplete (stacked, base ≠ main):** #977, #981, #993 (and #980).
- **Depends-on-production-migration (apply-held, founder approval):** #975, #977, #981.
- **Still-under-review:** #980 (draft).
- **Blocked-by-credentials (to *exercise*, not to merge):** #988 (Stripe test key, opt-in).

---

## 2. Migration dependency map

### 2.1 What actually exists on origin (verified `git ls-tree`, 2026-10-30)

| Prefix | File | PR | Branch | Base chain |
|--------|------|----|--------|-----------|
| `20261242000000` | `job_assignments.sql` | #975 | `feat/r5-job-assignments-phase1` | main |
| `20261243000000` | `r5_phase2_jobs_assignment_rls.sql` | #977 | `feat/r5-phase2-jobs-rls` | #975 |
| `20261244000000` | `r5_phase3_operational_child_rls.sql` | #981 | `feat/r5-phase3-operational-rls` | #977 |
| `20261245000000` | `r5_phase3_operational_child_rls_slice2.sql` | #981 | `feat/r5-phase3-operational-rls` | #977 |

`main` tip = `20261241000000`. All four R5 prefixes are **strictly greater** than the tip and
**mutually distinct** → forward-only + prefix-unique both satisfied.

### 2.2 Correct apply order (one at a time, each after its PR merges, founder-approved)

```
20261241 (main, already live)
   └─ 20261242  (#975)  job_assignments — DARK, service-role-only
        └─ 20261243  (#977)  jobs SELECT assignment-aware (needs 242's table + is_job_assignee)
             ├─ 20261244  (#981)  operational child RLS slice 1
             └─ 20261245  (#981)  operational child RLS slice 2  (apply 244 then 245)
```

**Ordering is load-bearing**, not cosmetic: `20261243`'s `is_job_assignee()` reads the
`job_assignments` table created in `20261242`; `20261244/245` reuse the Phase-2 helper from
`20261243`. Applying out of order fails or silently mis-gates.

### 2.3 ⚠️ Prefix-collision / chain-reconciliation audit — LOUD FINDINGS

- **NO duplicate or conflicting migration prefix was found** across the open R5 PR branches.
  242 / 243 / 244 / 245 are each unique and each owned by exactly one PR.
- **The chain is 242→245, NOT 242→251.** The integration brief assumed migrations
  `20261246`–`20261251` and a branch `feat/jobs-assignment-reconciliation` carrying `20261246`.
  **Neither exists on origin** (verified: `git fetch origin feat/jobs-assignment-reconciliation`
  → `couldn't find remote ref`; `git for-each-ref refs/remotes/origin` shows no
  `*reconciliation`/`*phase4` R5 branch; no branch carries a `2026124[6-9]`/`2026125x` migration).
  **Treat the "242→251 split across a reconciliation branch" as stale** — it was either never
  pushed, already squashed/merged-by-content, or local-only. Only 242–245 are deployable today.
- **#980 does not add a migration** of its own; it inherits `20261242` from its base
  (`feat/r5-job-assignments-phase1`). Its diff is UI/actions only. So #980 does **not** widen the
  migration set — but it must not be merged ahead of #975 (its migration source).

---

## 3. Deployment sequence (recommended)

All merges are **human-approved** (CLAUDE.md non-negotiable). Batch to milestones; do not push
speculative previews. Migrations apply to the single prod Supabase **only on explicit founder
approval**, one at a time via `supabase db query -f <file>` + `supabase migration repair`
(run from `~/Code/web`), catalogue-verified after each.

### Wave 1 — security fixes (no migration, fastest to land)
1. **#986** (quote-accept stale-token bypass) — full gate green, base `main`. Merge first.
2. **#993** (void-invoice PDF + zip leaks) — stacks on #986. After #986 merges, GitHub retargets
   #993's base to `main`; **re-run the full CI matrix and confirm green** (only gitleaks+Vercel
   ran so far), then merge.

### Wave 2 — additive test / hardening coverage (no migration, base `main`)
3. **#989** (comms + recovery consolidation) — merge this and **close #983 + #985** as superseded
   (or merge #983/#985 first and #989 reduces to its 3 new files; #989-as-unit is simpler).
4. **#987**, **#990** (HQ gate + business flows), **#984** (AI launch), **#991** (Stripe
   record-only) — all full-gate-green, independent, merge in any order.

### Wave 3 — fix-then-merge (currently failing CI)
5. **#982** — resolve the `e2e` failure, re-run, then merge (test-only).
6. **#988** — resolve the `gitleaks` failure (almost certainly a test-key string literal; add a
   reviewed gitleaks fingerprint rather than weakening the scan), re-run, then merge. Real-sandbox
   test stays SKIP in CI.
7. **#992** — resolve `e2e` + `gitleaks`, re-run, then merge (test-only).

### Wave 4 — R5 staff-isolation stack (code merge + apply-held migrations)
Merge **in strict order**, retargeting each to `main` as its parent lands and **re-running the
full CI matrix** (stacked CI was partial):
8. **#975** → merge to `main`. Code is DARK; nothing reads `job_assignments` yet.
9. **#977** → retarget to `main`, full CI green, merge.
10. **#981** → retarget to `main`, full CI green, merge.
11. **#980** → un-draft, **fix the `security (trust boundaries)` failure**, retarget to `main`,
    merge (UI for the table from #975).

**Then, and only on founder approval**, apply migrations to prod in order
`20261242 → 20261243 → 20261244 → 20261245`. Phases 2/3 are **access-tightening** (staff lose
org-wide job visibility, keep assigned-job visibility; owner/admin unaffected) — verify the
assignment backfill (`20261242`) populated before applying `20261243`, or assigned staff briefly
see nothing until the write-path/backfill lands.

---

## 4. Rollback pack

**Forward-only rule:** migrations are additive and never edited in place. A "rollback" of an
*applied* migration is a **new compensating migration**, not a history edit or a manual
"un-apply". Code rollback is a `git revert` of the merge. The DB and code rollbacks are
independent and both may be needed.

| Migration | Applied effect | Rollback (compensating migration) | Risk direction |
|-----------|----------------|-----------------------------------|----------------|
| `20261242` (#975) | Creates DARK `job_assignments` (service-role-only); backfills from `jobs.assigned_to` | `DROP TABLE public.job_assignments;` — safe: nothing reads it on the Data API, so dropping changes **no** access; backfill is derived (no source-of-truth loss). **But** do not drop while `20261243+` are applied (they depend on it). | Benign while 243+ absent |
| `20261243` (#977) | `is_job_assignee()` SECDEF + narrows `jobs` SELECT to admin-or-assignee | Restore the prior `jobs` SELECT policy (`org_id in current_org_ids()` org-member) and `DROP FUNCTION public.is_job_assignee(uuid);` | **Re-widens** staff to org-wide job visibility (pre-R5). No lockout risk; reverts a security improvement. |
| `20261244` (#981) | Narrows SELECT on `snags, site_diary_entries, site_reports, job_progress_observations, job_checklists` to admin-or-assigned-job | Restore each table's prior org-member SELECT policy | Re-widens staff on those child tables; no lockout. |
| `20261245` (#981) | Slice-2 operational child-table SELECT narrowing | Restore prior SELECT policies on the slice-2 tables | Same as 244. |

**Code-side rollback notes**
- #981 also reconciles app callers (offline-writes idempotency lookup → narrow self-scoped
  `(org_id, client_write_key, created_by=self)`). Reverting the **PR merge** reverts that code;
  it is independent of the DB policy rollback but should be reverted **together** with 244/245 to
  stay consistent.
- #975/#977 code reverts cleanly (`git revert`); the DARK table/UI carry no runtime dependency
  from the rest of the app until Phase 2 wiring exists.
- #986 / #993 are pure fail-closed guards — rollback = `git revert`; no DB state. Reverting
  re-opens the stale-token / void-invoice leaks, so revert only if the fix itself is defective.

**Order of a full R5 DB rollback (if ever needed):** reverse of apply —
drop/restore `20261245` → `20261244` → `20261243` (function + policy) → `20261242` (table).

---

## 5. External-credential & CEO/founder approval gates

| Gate | Blocks | Needed for merge? | Needed for activation/apply? |
|------|--------|-------------------|------------------------------|
| **Founder approval to apply R5 migrations** (`20261242`–`20261245`) | prod access-policy change | No (code merge allowed) | **Yes** — apply-held; access-tightening; apply in order |
| **Stripe TEST key** (`STRIPE_SANDBOX_E2E=1` + `sk_test_`/`rk_test_`) | #988 real-sandbox test *execution* | No (skips cleanly in CI) | Only to run the opt-in E2E; gate **refuses** `sk_live_`/`rk_live_` |
| **Self-serve billing** | Stripe lifecycle features | No | Stays **OFF** (CEO) — tests assert record-only, no charge path |
| **AI providers / cost governor** | #984-tested AI features live | No (tests use mocks + dark governor) | Separate CEO activation; providers dark by default |
| **Resend / Sentry / Supabase Auth SMTP / off-platform backup** | live verification of #989/#983/#985 | No (unit-only) | Live keys + CEO action (tracked as C-items in `docs/ops/LAUNCH-READINESS-COMMS-RECOVERY.md` / `BACKUP-RECOVERY-STATUS.md`) |
| **PITR** | RPO/RTO posture | No | CEO cost decision (deferred ~$100/mo) |

**Standing invariants (CLAUDE.md):** never merge/apply to prod autonomously; never weaken RLS,
grants, or a test to get green CI; migrations additive/forward-only, prefix-unique,
catalogue-verified; single prod Supabase, no staging.

---

## 6. Evidence index

- PR metadata/bodies: `gh pr view <n> --repo crewflow1/web --json ...` (2026-10-30).
- CI status: `gh pr checks <n> --repo crewflow1/web` (2026-10-30).
- Migration presence: `git ls-tree --name-only origin/<branch> supabase/migrations/` (2026-10-30).
- Absence of `feat/jobs-assignment-reconciliation` / `2026124[6-9]`+ migrations:
  `git fetch origin feat/jobs-assignment-reconciliation` → `couldn't find remote ref`;
  `git for-each-ref refs/remotes/origin/` (2026-10-30).
