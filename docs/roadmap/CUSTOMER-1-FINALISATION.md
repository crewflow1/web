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

## Reviewer amendment (same defect, directly coupled)
Reviewer A found the fixed panel could go silently empty AGAIN under **limit-crowding**: the or-branch also fetched every unassigned live job, sharing the query's 20-row LIMIT — ≥20 unassigned actives with earlier dates pushed the worker's own job out of the window. Remedy applied (one line): fetch `.eq("assigned_to", user.id)` only (unassigned rows were client-discarded anyway). Also added the loud-read guard on `jobsRes.error` (a failed read must not masquerade as the empty state). Tests extended to pin both (10/10). Live re-verified post-rebuild: both assignments render.

## Part 2 — PITR/backup verification (read-only, 2026-08-29)
- `supabase backups list` (management API, CLI's own auth): region **West EU (Ireland)** · **WALG: true** · **PITR: FALSE** · earliest/latest restorable timestamp: none.
- WAL archiving healthy (pg_stat_archiver: 2796 archived, **0 failed**, last archive minutes before check) — Supabase's physical/daily backup substrate is running.
- **CEO ACTION REQUIRED (not performed — billing feature): enable the PITR add-on** in Supabase dashboard → Project → Database → Backups / Add-ons. Until then, restore granularity = the daily physical backup (dashboard-restorable), i.e. **RPO up to ~24 h**; with PITR it becomes ~2 min.
- Also noted: the operator does not hold `SUPABASE_DB_PASSWORD`, so pooler-level `pg_dump` (off-platform logical dumps) is currently impossible from this seat; the direct-db host no longer resolves on Supabase's new infra (expected).

## Part 3 — restore rehearsal (safe, non-destructive; production untouched)
**Method:** Plan B. A production data-level clone was NOT possible without the DB password/PITR (above), and a destructive prod restore is forbidden — so the drill proved the recovery layers that are provable today:
1. **Schema + controls restore, timed:** full local `supabase db reset` (drop → re-init → replay ALL 380 migrations) — **RESET_START 18:06:44Z → RESET_END 18:07:10Z = 26 seconds**.
2. **Validation of the restored database:** migrations **380 / tip 20261220000000** (== production) · **307 RLS-enabled tables · 605 policies · 461 triggers** incl. **87 append-only/immutability guards** and all **3 invoice-void/job-cancel guards** · **758 FK constraints · 1477 indexes**. Representative org/customer/job/quote/invoice/payment/timesheet/RAMS rows re-loaded and verified rendering through the real app (Harrison & Cole re-seed, ~1 s, 40 steps OK; auth/user linkage intact — worker login + My Day render post-restore).
3. **What this does and does not prove:** schema, security controls, and application-level recovery are PROVEN with a measured RTO; **production DATA restore remains dashboard-evidence only** (daily physical backups exist; restore is a Supabase-dashboard operation that cannot be rehearsed non-destructively without PITR-to-a-fork or the DB password for logical dumps).
- **Evidence-supported numbers:** schema-layer RTO **~30 s**; app redeploy RTO **~5 min** (Vercel deploy history); data RPO **≤24 h today** (daily backup), **~2 min once PITR is enabled**; data-restore RTO: **not yet measured** (dashboard operation — rehearse once PITR/fork or DB password is available). No SLA promises invented.

## Reviews
- **Reviewer A (My Day/field UX): SAFE TO DEPLOY** — condition (limit-crowding) applied pre-merge, see amendment.
- **Reviewer B (security): SAFE TO DEPLOY** — no cross-worker/org/financial/comp exposure; Money boundary byte-identical to baseline; RLS tenant client confirmed.
- **Reviewer C (disaster recovery): RECOVERY PARTIALLY PROVEN (schema/controls/app) — data-restore pending owner actions.** Independently re-verified PITR:false + WAL health + drill-DB tip. Accepted the drill as honest (rebuild-from-source, correctly not oversold; no invented SLA). Downgraded one number: **RPO ≤24 h is dashboard-unconfirmed** (plan tier + visible daily backups must be eyeballed — the Aug-25 pause pattern is characteristic of a tier without daily backups). Minimum owner actions to reach RECOVERY PROVEN: (1) dashboard check of tier+backup list, (2) enable PITR, (3) obtain SUPABASE_DB_PASSWORD + one off-platform dump, (4) one rehearsed data restore on a scratch/fork with measured RTO. Runbook amended accordingly (RPO wording + maintenance-cutover link).

## CI / Release
(recorded below)
