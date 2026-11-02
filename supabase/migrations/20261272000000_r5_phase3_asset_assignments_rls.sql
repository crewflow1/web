-- ============================================================================
-- R5 Phase 3 (remainder, slice 4) — asset_assignments assignment-aware SELECT.
-- ============================================================================
-- asset_assignments records which asset (tool/vehicle) is assigned to a job
-- (job_id) and/or a person/site. Staff see an assignment only for a job they are
-- assigned to; owners/admins keep full org access.
--
-- JOB-LESS RECORDS ARE ADMIN-ONLY (founder rule): an assignment with job_id NULL
-- (asset held by a person/van, not tied to a job) is not scoped to any assigned
-- job, so staff must not see it. The standard predicate already delivers this —
-- `job_id in (select my_assigned_job_ids())` is NULL (not true) when job_id is
-- NULL, so a non-admin is excluded and only is_org_admin admits it. No separate
-- staff permission for job-less records exists today; if one is introduced later
-- it would be added as an explicit OR branch here.
--
-- WRITE PATHS: asset assignment mutations run through the asset services/RPCs for
-- a job the actor can see; a member cannot create a job-less assignment via the
-- tenant client and read it back under this policy — consistent with making
-- job-less assignments an admin concern. INSERT/UPDATE/DELETE unchanged.
-- ROLLBACK: recreate with the plain org-only predicate.
-- ============================================================================

drop policy if exists asset_assignments_select on public.asset_assignments;
create policy asset_assignments_select on public.asset_assignments
  for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );
