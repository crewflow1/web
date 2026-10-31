-- ============================================================================
-- R5 Phase 3 (slice 1) — operational child-table assignment-aware SELECT.
--   ⚠️ ACCESS POLICY migration — apply-held until explicit founder approval.
-- ============================================================================
-- Extends the R5 staff-isolation model from the jobs parent (Phase 2, 20261243)
-- down to its OPERATIONAL child records: ordinary staff may read a child row
-- only for a job they are ASSIGNED to; owners and admins keep full org-wide
-- access. First slice — the clearly-operational, job-linked records a field
-- worker legitimately needs on their own jobs:
--     snags, site_diary_entries, site_reports,
--     job_progress_observations, job_checklists
-- (Later slices extend to documents/photos, permits, risk_assessments,
--  toolbox_talks, inspections, signatures, completion_certificates,
--  material_requests, blueprints, …; commercial child tables are Phase 4;
--  rota/clock/leave self-scope is Phase 5.)
--
-- BEFORE each table: a single member-select policy — any org member could read
--   every row:  using (org_id in (select current_org_ids())).
-- AFTER: member AND (is_org_admin(org_id) OR job_id in (select my_assigned_job_ids())).
--   • owner/admin → is_org_admin short-circuits → full org access (no lockout).
--   • assigned staff → see rows for their assigned jobs only.
--   • unassigned staff / other roles → nothing.
--   • NULL job_id (the nullable-job site records: snags/diary/reports) →
--     `job_id in (…)` is NULL → NOT true → staff see nothing; a non-job org
--     record stays management-only. Intended.
--
-- my_assigned_job_ids() (SECURITY DEFINER, self-scoped by auth.uid(), set-
-- returning + STABLE) is from Phase 2 (20261243) — the planner evaluates it once
-- and the check is bounded by the caller's assignment count. No new index: the
-- child tables are read by job_id (their own job_id index) intersected with the
-- caller's assignment set.
--
-- EXACTLY ONE SELECT policy is replaced per table (by name); INSERT/UPDATE/
-- DELETE policies are untouched, so staff WRITE paths (operative field entry)
-- are unchanged — only READ visibility narrows. Each policy keeps its original
-- name and role targeting (the three site tables + progress have no explicit
-- role; job_checklists is `to authenticated`).
--
-- OWNER LOCKOUT ANALYSIS: none (is_org_admin short-circuits for owner/admin).
-- PERFORMANCE: the assignee set is evaluated once per statement for non-admins;
--   owner/admin never evaluate it. Child reads already filter by job/org.
-- ROLLBACK (restores the pre-Phase-3 member read):
--   each `create policy … using (org_id in (select public.current_org_ids()))`
--   with the original name/role (see the per-table drop/recreate below, with the
--   assignment branch removed).
-- IDEMPOTENT: policies dropped by name before (re)create.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- my_assigned_job_ids(): UNION BOTH assignment sources.
--
-- The app's LIVE assignment write path is jobs.assigned_to (app/(app)/jobs/
-- actions.ts); nothing in the app writes job_assignments yet (only the Phase-1
-- backfill + the new owner/admin crew panel do). The Phase-2 version of this
-- helper read only job_assignments, so gating operational child reads on it
-- alone would strand a staff member assigned through the ordinary UI from their
-- own jobs' records. Redefine it to return the union of BOTH sources — the
-- Phase-1 multi-worker table AND the legacy single-assignee column — so Phase 2
-- (jobs) and Phase 3 (children) honour every assignment the product can create.
-- Still SECURITY DEFINER + self-scoped by auth.uid() (reads jobs/job_assignments
-- as the definer, bypassing their RLS — no recursion); still set-returning +
-- STABLE so the planner evaluates it once per statement.
-- ---------------------------------------------------------------------------
create or replace function public.my_assigned_job_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select job_id from public.job_assignments where user_id = auth.uid()
  union
  select id from public.jobs where assigned_to = auth.uid();
$$;

-- snags (job_id NULLABLE) -----------------------------------------------------
drop policy if exists snags_select on public.snags;
create policy snags_select on public.snags
  for select using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

-- site_diary_entries (job_id NULLABLE) ---------------------------------------
drop policy if exists site_diary_entries_select on public.site_diary_entries;
create policy site_diary_entries_select on public.site_diary_entries
  for select using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

-- site_reports (job_id NULLABLE) ---------------------------------------------
drop policy if exists site_reports_select on public.site_reports;
create policy site_reports_select on public.site_reports
  for select using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

-- job_progress_observations (job_id NOT NULL) --------------------------------
drop policy if exists job_progress_observations_select on public.job_progress_observations;
create policy job_progress_observations_select on public.job_progress_observations
  for select using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

-- job_checklists (job_id NOT NULL; original role = authenticated) -------------
drop policy if exists "job_checklists: members can select" on public.job_checklists;
create policy "job_checklists: members can select" on public.job_checklists
  for select to authenticated using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );
