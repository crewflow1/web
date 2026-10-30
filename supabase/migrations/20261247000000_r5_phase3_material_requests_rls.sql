-- ============================================================================
-- R5 Phase 3 (slice 3) — material_requests + material_request_lines SELECT.
-- ============================================================================
-- Completes the Phase 3 operational-child narrowing that slice 2 deferred
-- (20261245000000 NOTE): staff see a material request only for a job they are
-- ASSIGNED to; owners/admins keep full org visibility. Mirrors every other
-- Phase 3 child policy:
--     org_id in (select current_org_ids())
--     and (is_org_admin(org_id) or <assigned-job predicate>)
-- INSERT / UPDATE / DELETE are UNCHANGED (still org-scoped for members, admin-
-- only draft delete) — this slice narrows READ visibility only.
--
-- PARENT (material_requests) keys off its own job_id via my_assigned_job_ids()
-- (the slice-1 union helper: job_assignments ∪ jobs.assigned_to). A JOB-LESS
-- request (job_id null) is therefore admin-only for staff — consistent with how
-- slice 1/2 treat a job-less snag/diary/report (a general request not tied to a
-- site a staff member is on is not theirs to read); the owner/admin always sees
-- it. This is the same product posture the other slices set, not a new one.
--
-- CHILD (material_request_lines) has NO job_id — it is the first Phase 3
-- GRANDCHILD. A line is visible exactly when its parent request is. Rather than
-- rely on nested-RLS semantics inside a policy subquery, visibility is computed
-- by a dedicated self-scoped SECURITY DEFINER helper (no args, keyed on
-- auth.uid()), symmetric with my_assigned_job_ids() — so the line predicate is
-- self-contained and does not depend on material_requests' own RLS staying a
-- particular shape.
--
-- OFFLINE IDEMPOTENCY. material_requests has an offline-authored write path
-- (20261083000000) whose KEY-FIRST replay protocol reads the caller's OWN
-- earlier header/lines back to decide duplicate-vs-insert. Under the old
-- org-wide SELECT the caller could always see their own row; once SELECT is
-- narrowed, a JOB-LESS request (or one whose job a staff member was later
-- unassigned from) would become invisible to that read and the replay would
-- loop or double-insert. The companion change in
-- server/services/material-request-writes.ts switches those three OWN-ROW reads
-- to a narrow self-scoped service-role lookup pinned to
-- (org_id, client_write_key, created_by = auth user) — exactly the mechanism
-- slice 1 applied to site_diary_entries. No created_by SELECT exception is
-- added to RLS: a staff member still cannot browse their own non-assigned
-- requests; only the offline replay engine can confirm its own prior write.
--
-- LOCKOUT ANALYSIS: owners/admins unaffected (is_org_admin branch). Staff lose
-- read of non-assigned/job-less requests — the intended R5 tightening. No write
-- policy changes, so nothing an existing writer could do becomes impossible.
-- ROLLBACK:
--   drop function if exists public.my_assigned_material_request_ids();
--   -- and re-create the two SELECT policies with the plain org-only predicate
--   -- (20261066000000).
-- ============================================================================

-- Self-scoped: the material_request ids whose job the caller is assigned to.
-- SECURITY DEFINER so it computes the set free of material_requests' own RLS;
-- takes no org id (keyed on auth.uid()), so the secdef-org-rpc guard does not
-- apply — symmetric with my_assigned_job_ids().
create or replace function public.my_assigned_material_request_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from public.material_requests
  where job_id in (select public.my_assigned_job_ids());
$$;

drop policy if exists "material_requests: members can select" on public.material_requests;
create policy "material_requests: members can select" on public.material_requests
  for select to authenticated using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

drop policy if exists "material_request_lines: members can select" on public.material_request_lines;
create policy "material_request_lines: members can select" on public.material_request_lines
  for select to authenticated using (
    org_id in (select public.current_org_ids())
    and (
      public.is_org_admin(org_id)
      or material_request_id in (select public.my_assigned_material_request_ids())
    )
  );
