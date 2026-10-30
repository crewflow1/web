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
- **Status:** BUILT + independently reviewed (APPROVE). CI: fixed the one red
  gate — the DSAR guard requires every org-scoped table to be classified in
  `lib/gdpr/org-tables.json`. `job_assignments` is classified and, while it is
  DARK (service-role-only, no authenticated read surface), **excluded from the
  export** with a documented reason: the DSAR export reads as the requesting
  user, so a service-role-only table cannot and must not be read there, and the
  single-assignee link it currently holds is already exported via
  `jobs.assigned_to`. A later R5 phase that grants an authenticated SELECT policy
  on `job_assignments` flips it to **included**. Re-verify CI-GREEN before approving.

---

## Phase 2 — jobs PARENT assignment-aware SELECT  ·  branch `feat/r5-phase2-jobs-rls` (stacked on #975)

- **Migration:** `supabase/migrations/20261243000000_r5_phase2_jobs_assignment_rls.sql`
- **What it does:**
  - adds `is_job_assignee(target_job uuid)` — SECURITY DEFINER, self-scoped by
    `auth.uid()` (returns only whether the **caller** is assigned; no row data,
    no existence oracle, allowlisted in the secdef-org-rpc guard);
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
  the RLS client, so staff-facing job lists will narrow to assigned-only. Before
  this is APPLIED in production, the app write-path must write `job_assignments`
  on every assignment (so multi-worker assignment is reflected) and staff job
  surfaces must handle the assigned-only/empty-state view. The `assigned_to`
  branch means the single-assignee path keeps working in the interim with no
  lockout. **Apply order:** merge+deploy the app reconciliation → then apply this
  migration.
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

- **Phase 3** — operational child tables (documents, photos, snags, site diary,
  site reports, time entries, checklists, permits, RA, toolbox talks, signatures,
  material requests, inspections, completion docs, blueprints): assignment-aware
  SELECT, splitting operationally-necessary from confidential data.
- **Phase 4** — commercial-data denial + indirect-leak sweep (quotes, invoices,
  budgets, billing plans/stages, valuations, retention, purchase prices,
  expenses, profitability, financial reports, payroll, tax/cash) across tables,
  views, RPCs, document downloads, signed URLs, and AI outputs.
- **Phase 5** — workforce self-scoping (rota, clocking, leave): a staff member
  cannot read another's rota/timesheets/leave by changing an identifier.

Each ships as its own stacked, apply-held, independently-reviewed migration with
the same evidence shape as above.

---

## Founder decisions required

1. Approve **#975** (Phase 1) to merge + apply — unblocks applying Phase 2+.
2. Approve the **Phase-2 app reconciliation → apply** ordering above.
3. Confirm the Phase 3/4/5 table classification (the staff-access model in the
   master directive §1.2–§1.5 is taken as the confirmed classification).
