# Customer #1 Finalisation — ledger

Scope: exactly four objectives — (1) fix My Day→My jobs, (2) verify production PITR/backup, (3) safe restore rehearsal, (4) final smoke + release freeze. No other P2/P3 touched.

## Rule Zero (2026-08-29 ~18:45 UTC)
- origin/main = production = `c469e7fd` · healthy · db:ok · parity **380/380**, tip `20261220000000`
- Dark providers unchanged (email live; sms/whatsapp/weather dark) · Sentry live · 6 dependabot PRs only
- AUTH EMAIL GATE: **GREEN** (evidence from the same day: /recover 200 + recovery_sent_at bump + /otp 200; not re-sent)
- Latest main-CI run at `c469e7fd`: e2e tier failed on the **known fleet-mobile fuel-tile fixture race** (identical signature flaked once on PR #850 and passed on the identical-diff rerun; PR CI for the deployed merge was 8/8 green). Not a product regression.
- WAL archiving healthy: archived_count 2796, **failed_count 0**, last archive minutes before check.

## Part 1 — My Jobs defect
**Reproduced against current main: YES.** Worker (hc-field1) with a legitimate `jobs.assigned_to` assignment; the identical PostgREST query WITH `assigned_to` selected returns the job under the worker's own JWT; the rendered My Day panel showed "No jobs assigned to you right now" on repeated fresh loads.
**Root cause (verified in code):** `app/(app)/me/page.tsx` — the jobs read selects `"id, status, scheduled_date, customer:customers(name)"` (no `assigned_to`) while the panel filter is `j.assigned_to === user.id` → every row's `assigned_to` is `undefined` → panel permanently empty. Invisible to typecheck (the filter used a cast).
**Fix (smallest correct):** add `assigned_to` to the select list + explanatory comment. No query-shape, permission, or architecture change.
**Tests added:** `__tests__/me/my-jobs-panel.test.ts` — (a) source contract: any jobs select carrying the customers embed must include `assigned_to`; filter + status-exclusion pinned; (b) pure filter semantics: single/multi/none/other-worker/missing-column regression. 8/8.

**Acceptance (live, fixed build, seeded Harrison & Cole):**
1. one assignment → appears ✓ (pavilion) · 2. multi → both appear in order ✓ (hotel + pavilion) · 3. none → clean empty ✓ (field3, whose only job is cancelled) · 4. cross-worker → absent ✓ (field2 sees only Magee) · 5. cross-org → RLS + org-pin (integration suite green) · 6. cancelled → excluded at DB ✓ · 7. completed → same DB exclusion (source-pinned) · 8. refresh → force-dynamic fresh render ✓ · 9. direct JWT query == UI ✓ · 10. mobile 375px → 2 tappable links, **0px overflow** ✓ (320px page family verified same day; e2e suite pins 375 sweeps).

**Security regression (as staff, fixed build):** `/invoices` → bounced to /me ✓ · `/api/reports/export` → 403 ✓ · Cmd+K "fitzwilliam" → job+snag only ✓ · compensation RLS untouched (no permission code in the diff).

## Part 2 — PITR/backup verification
(populated below)

## Part 3 — restore rehearsal
(populated below)

## Reviews / CI / Release
(populated below)
