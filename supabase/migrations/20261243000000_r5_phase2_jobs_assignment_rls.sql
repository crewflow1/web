-- ============================================================================
-- R5 Phase 2 — jobs PARENT assignment-aware SELECT (⚠️ ACCESS POLICY, apply-held).
-- ============================================================================
-- Tightens the `jobs` SELECT policy so ORDINARY STAFF see only the jobs they are
-- assigned to, while OWNERS and ADMINS keep full org-wide access. This is the
-- first enforcing step of R5 (Phase 1, 20261242, landed only the data model +
-- backfill and changed no access).
--
-- BEFORE (since 20260515150000): any org member could SELECT every job in the
--   org —  using (org_id in (select current_org_ids())).
-- AFTER: a member may SELECT a job only when they are an owner/admin of the org,
--   OR the job is assigned to them — either via the legacy single-assignee column
--   (jobs.assigned_to) OR the Phase-1 multi-worker table (job_assignments).
--
-- WHY HONOUR BOTH assigned_to AND job_assignments: Phase 1 backfilled
-- job_assignments from jobs.assigned_to, so today they agree. Keeping the
-- `assigned_to = auth.uid()` branch means this migration cannot strand a staff
-- member who is assigned through the legacy column before the app write-path
-- starts writing job_assignments on every assignment. Both are EXPLICIT
-- assignments; a rota/clock entry is NOT and grants nothing here — satisfying
-- "a rota shift must not grant job access unless an explicit assignment exists".
--
-- SCOPE: this phase rewrites ONLY the jobs SELECT policy (the parent). INSERT
-- (any member — app-gated by jobs:create), UPDATE and DELETE (admins/owners)
-- are UNCHANGED. The operational child tables (documents, photos, snags, diary,
-- time entries, permits, …) are tightened in Phase 3; commercial-data denial is
-- Phase 4; workforce self-scoping is Phase 5. job_assignments itself stays
-- service-role-only (DARK) — my_assigned_job_ids() is SECURITY DEFINER and reads it
-- regardless, so no client grant on job_assignments is needed yet.
--
-- OWNER LOCKOUT ANALYSIS: NONE. is_org_admin(org_id) returns true for role
-- 'owner' and short-circuits the OR, so an owner is never denied a job in their
-- own org and the per-row assignee lookup is never evaluated for them. Admins
-- likewise. Only NON-admin members are narrowed, which is the intended change.
--
-- STAFF BEHAVIOUR CHANGE (intended, not a regression): staff who could formerly
-- list every org job now see only assigned jobs. The app reads jobs through the
-- RLS client (createClient), so staff-facing job lists narrow accordingly; the
-- app-level reconciliation of those surfaces (empty states, assigned-only lists)
-- is tracked as Phase-2 app integration and must land BEFORE this is applied in
-- production — see the approval pack. This migration is the DB enforcement floor.
--
-- PERFORMANCE: the OR is evaluated for non-admins only (is_org_admin short-
-- circuits for owner/admin).
--   • is_org_admin(org_id): one memberships lookup; short-circuits for owner/admin.
--   • assigned_to = auth.uid(): a column comparison on the row — free.
--   • id in (select my_assigned_job_ids()): the set-returning helper is STABLE,
--     so the planner evaluates it ONCE per statement and drives the check from
--     job_assignments(user_id, org_id) — the index Phase 1 created for exactly
--     this — bounding work by the CALLER's assignment count, not the org's job
--     count. (A per-row is_job_assignee(id) would instead do one index probe per
--     candidate job; the set form is strictly cheaper for a staff job list.)
--
-- ROLLBACK (safe; restores the pre-Phase-2 broad read):
--   drop policy if exists "jobs: assignee or admin can select" on public.jobs;
--   create policy "jobs: members can select" on public.jobs for select to authenticated
--     using (org_id in (select public.current_org_ids()));
--   drop function if exists public.my_assigned_job_ids();
--
-- IDEMPOTENT: function uses OR REPLACE; policies are dropped before (re)create.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- helper: the job ids the current user is EXPLICITLY assigned to (Phase-1 table).
-- SECURITY DEFINER so the policy can read job_assignments (service-role-only,
-- RLS-enabled, client grants revoked) without granting the authenticated role
-- access to it and without recursive RLS — exactly the pattern current_org_ids()
-- and is_org_admin() already use for memberships. Self-scoped by auth.uid(): it
-- returns ONLY the caller's own assignments, so it is neither a cross-tenant read
-- primitive nor an existence oracle. Takes NO argument, so it is outside the
-- secdef-org-rpc-guard's uuid-argument class. Set-returning + STABLE so the jobs
-- policy evaluates it once and drives from the (user_id, org_id) index.
-- ---------------------------------------------------------------------------
create or replace function public.my_assigned_job_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select job_id from public.job_assignments where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- jobs SELECT — owner/admin full org access; staff assigned-jobs only.
-- ---------------------------------------------------------------------------
drop policy if exists "jobs: members can select" on public.jobs;
drop policy if exists "jobs: assignee or admin can select" on public.jobs;
create policy "jobs: assignee or admin can select" on public.jobs for select to authenticated
using (
  org_id in (select public.current_org_ids())
  and (
    public.is_org_admin(org_id)
    or assigned_to = auth.uid()
    or id in (select public.my_assigned_job_ids())
  )
);
