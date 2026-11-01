-- ============================================================================
-- R5 Phase 3 (remainder, slice 1 of the operational-child completion) —
-- job_programme_baselines assignment-aware SELECT.
-- ============================================================================
-- The core R5 chain (Phases 1–5, migs 20261242–20261259) is LIVE in production,
-- but a handful of job-linked OPERATIONAL child tables were deferred and still
-- carry an org-wide SELECT (a staff member can read them for ANY job in the org,
-- not just their assigned jobs). This slice closes the cleanest of them.
--
-- job_programme_baselines is the lowest-risk: INSERT is admin-only and there is
-- NO member write-back path in the app (no `insert().select()` on the tenant
-- client), so narrowing SELECT cannot break a read-after-write. Pure read
-- isolation. Pattern matches every other Phase 3 child:
--     org_id in (select current_org_ids())
--     and (is_org_admin(org_id) or job_id in (select my_assigned_job_ids()))
-- INSERT/UPDATE/DELETE unchanged.
--
-- LOCKOUT ANALYSIS: owners/admins keep full visibility (is_org_admin branch);
-- staff see baselines only for jobs they are assigned to. No write path changes.
-- ROLLBACK: recreate with `using (org_id in (select current_org_ids()))`.
-- ============================================================================

drop policy if exists "job_programme_baselines: members can select" on public.job_programme_baselines;
create policy "job_programme_baselines: members can select" on public.job_programme_baselines
  for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );
