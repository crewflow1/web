# R5 — Database Staff-Access Security · Production Approval Pack

> **Status label key:** BUILT = code written + reviewed; ISOLATED-VERIFIED = applied
> to a throwaway Postgres and tested; CI-GREEN = all gates pass on the PR;
> APPLIED = run against production. **Nothing in R5 is APPLIED.**
>
> **These are production ACCESS-POLICY migrations. Per the standing approval
> gate they are built and isolated-tested only. They must NOT be merged or
> applied without explicit founder approval.**

R5 tightens the database so ordinary staff can read only the jobs they are
**explicitly assigned** to, while owners and admins keep full org-wide access —
enforced at Postgres (RLS), not just in the app. It is split into small,
independently reviewable phases so each can be approved, applied, and watched on
its own.

---

## Phase 1 — `job_assignments` model + backfill  ·  PR #975

- **Migration:** `supabase/migrations/20261242000000_job_assignments.sql`
- **What it does:** creates the multi-worker `job_assignments` join table
  (org_id, job_id, user_id, assigned_by, assigned_at; `unique(job_id,user_id)`;
  composite FK `(job_id,org_id)→jobs(id,org_id)` so an assignment can never cross
  tenants), indexes it, enables RLS, **revokes all client grants (service-role
  only / DARK)**, and backfills one row per job from `jobs.assigned_to`.
- **Access change:** NONE. No policy references the table; it is unreadable by
  any client. Applying it is a no-op for every existing user.
- **Lockout risk:** none (nothing enforces on it).
- **Rollback:** `drop table if exists public.job_assignments;` (zero product impact).
- **GDPR (resolved via service-side export, not exclusion):** `job_assignments`
  is classified in `lib/gdpr/org-tables.json` as `service_side_export` and **IS
  included in the DSAR export** via a service-role admin-client lane in
  `server/services/gdpr-export.ts` (the user-JWT loop cannot read a service-role-
  only table). The lane is org-pinned + redacted and gated by a defence-in-depth
  membership probe (the caller's own RLS-subject client must see the
  `organizations` row for `orgId` before the admin lane runs), so a non-member
  can never trigger a service-role read of another org. Erasure already
  hard-deletes `job_assignments` by default and user-erasure cascades it. This
  resolves the "don't permanently exclude a dark table from subject access"
  requirement; it also future-proofs multi-worker assignments (exported with no
  divergence from `jobs.assigned_to`).
- **Status:** BUILT + independently reviewed (APPROVE for the table/backfill;
  the service-side export lane carries its own adversarial review). Re-verify
  CI-GREEN before approving.

---

## Phase 2 — jobs PARENT assignment-aware SELECT  ·  branch `feat/r5-phase2-jobs-rls` (stacked on #975)

- **Migration:** `supabase/migrations/20261243000000_r5_phase2_jobs_assignment_rls.sql`
- **What it does:**
  - adds `my_assigned_job_ids()` — SECURITY DEFINER, **no argument**, self-scoped
    by `auth.uid()` (returns only the **caller's own** assigned job ids; no row
    data, no cross-tenant oracle). Set-returning + STABLE so the policy evaluates
    it once and drives from the Phase-1 `(user_id, org_id)` index — work is
    bounded by the caller's assignment count, not the org's job count;
  - replaces the jobs SELECT policy:
    ```sql
    using (
      org_id in (select public.current_org_ids())
      and ( public.is_org_admin(org_id)
            or assigned_to = auth.uid()
            or public.is_job_assignee(id) )
    )
    ```
- **Access change (intended):** ordinary staff now SELECT only jobs assigned to
  them (via the legacy `assigned_to` column **or** the Phase-1 table); owners and
  admins keep full org access. INSERT/UPDATE/DELETE are **unchanged**.
- **Owner lockout analysis:** NONE. `is_org_admin()` short-circuits the OR for
  role `owner`/`admin`, so an owner is never denied a job in their own org.
- **App-behaviour dependency (deployment ordering):** the app reads jobs through
  the RLS client, so staff-facing job lists narrow to assigned-only. The one
  blocker before APPLY is reconciling the staff-facing job-read surfaces
  (~60+ `createClient().from("jobs")` read sites — empty states, assigned-only
  lists, and by-id deep links returning 404 rather than erroring). **No
  `job_assignments` write-path sync is required for the current single-assignee
  flow** — the policy's `assigned_to = auth.uid()` branch already covers every
  job assigned via the existing UI, so applying Phase 2 does not strand any
  currently-assigned staff member. A write-path that populates `job_assignments`
  is needed only when a **multi-worker assignment UI** is built (assigning
  secondary workers who are not `assigned_to`); that feature, the authenticated
  SELECT policy on `job_assignments`, and the GDPR re-classification land
  together. **Apply order:** reconcile staff job-read surfaces → apply this
  migration. (Also a conscious product call: with only owner/admin/staff roles,
  an office coordinator modelled as `staff` loses org-wide job visibility.)
- **Performance:** OR evaluated per candidate row for non-admins only;
  `assigned_to=auth.uid()` is a free column compare; `is_job_assignee` resolves
  via `job_assignments(unique job_id,user_id)` (live since Phase 1). No new index.
- **Rollback:**
  ```sql
  drop policy if exists "jobs: assignee or admin can select" on public.jobs;
  create policy "jobs: members can select" on public.jobs for select to authenticated
    using (org_id in (select public.current_org_ids()));
  drop function if exists public.is_job_assignee(uuid);
  ```
- **Isolated-Postgres verification (local `supabase db reset`, real JWTs):**
  `__tests__/integration/rls/jobs-assignment-access.test.ts` — 7/7:
  owner sees all 3 org jobs · admin sees all 3 · staff-assigned-via-table sees
  only that job · staff-assigned-via-legacy-column sees only that job ·
  **staff with a seat but no assignment sees nothing** · cross-tenant staff sees
  none of this org's jobs (and still sees their own assigned job) · anon sees
  nothing. secdef-org-rpc guard 15/15; data-api-grant guard 7/7; security tier
  8550/8550; typecheck clean.
- **Status:** BUILT + ISOLATED-VERIFIED. Awaiting independent adversarial review,
  CI-GREEN, and founder approval. **Not merged, not applied.**

---

## Remaining phases (not yet built)

Job-linked child-table inventory (36 tables carrying a `job_id`, enumerated from
the migrations) classified for Phases 3–5:

- **Phase 3 — operational, assignment-visible** (staff see rows only for jobs
  they're assigned to; owner/admin keep org-wide): `job_documents`,
  `job_checklists`, `job_progress_observations`, `job_programme_baselines`,
  `snags`, `site_diary_entries`, `site_reports`, `completion_certificates`,
  `inspection_test_plans`, `permits_to_work`, `risk_assessments`,
  `toolbox_talks`, `worker_acknowledgements`, `worker_signoff_tokens` (H&S
  evidence; token column already export-redacted), `material_requests`
  (goods-received is operational — kept distinct from PO pricing),
  `blueprints`, `blueprint_markup`, `blueprint_pins`, `delay_events`,
  `asset_assignments`, `weather_watches`, `job_warranties`. Attachments/photos
  ride `job_documents` + storage — **storage-object paths need their own
  assignment check** (an assigned-job row does not auto-authorise every byte).
- **Phase 4 — commercial, staff-barred regardless of assignment**: `finances`,
  `job_billing_plans`, `job_billing_stages`, `job_budgets`, `job_valuations`,
  `variation_requests` (valuation variations), `retention_releases`,
  `purchase_orders` (supplier prices), `review_requests`, plus `stock_movements`
  (carries cost/valuation) — confirm each. Indirect-leak sweep across views,
  RPCs, document downloads, signed URLs and AI outputs. Preserve legitimate
  staff **cost entry** and **goods-received confirmation** without exposing the
  ledger.
- **Phase 5 — workforce self-scoping**: `rota_entries`, `time_entries` (own
  clock only) — a staff member cannot read another's rota/timesheets/leave by
  changing an identifier. (`time_entries` is both job-linked and workforce; its
  self-scope is the authoritative rule.)

Each phase ships as its own stacked, apply-held, independently-reviewed migration
with the same evidence shape as Phase 2.

---

## Founder decisions required

1. Approve **#975** (Phase 1) to merge + apply — unblocks applying Phase 2+.
2. Approve the **Phase-2 app reconciliation → apply** ordering above.
3. Confirm the Phase 3/4/5 table classification (the staff-access model in the
   master directive §1.2–§1.5 is taken as the confirmed classification).
