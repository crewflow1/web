-- ============================================================================
-- R5 Phase 3 (remainder, slice 3) — delay_events + job_warranties SELECT.
-- ============================================================================
-- Both are job-linked operational records (EOT delay events; warranty records)
-- with a direct job_id. Staff see them only for assigned jobs; owners/admins
-- keep full org access. Standard Phase 3 pattern.
--
-- WRITE PATHS: delay_events is written by the weather/EOT detector via the
-- SERVICE-ROLE client (bypasses RLS — unaffected). Any member-authored EOT/
-- warranty record is for a job the member can see (assigned, under Phase 2), so
-- its RETURNING read stays visible. INSERT/UPDATE/DELETE unchanged.
-- ROLLBACK: recreate each with the plain org-only predicate.
-- ============================================================================

drop policy if exists delay_events_select on public.delay_events;
create policy delay_events_select on public.delay_events
  for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

drop policy if exists "job_warranties: members select" on public.job_warranties;
create policy "job_warranties: members select" on public.job_warranties
  for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );
