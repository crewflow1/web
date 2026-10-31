-- ============================================================================
-- R5 Phase 3 (slice 2) — safety / inspection / materials operational child RLS.
--   ⚠️ ACCESS POLICY migration — apply-held until explicit founder approval.
-- ============================================================================
-- Continues Phase 3 (slice 1, 20261244) across the H&S / inspection / materials
-- operational child tables a field worker legitimately needs on their ASSIGNED
-- jobs: permits_to_work, risk_assessments, toolbox_talks, inspection_test_plans,
-- completion_certificates, material_requests.
--
-- Each SELECT policy → member AND (is_org_admin(org_id) OR job_id in
--   (select my_assigned_job_ids())). Owner/admin keep full org access; assigned
-- staff see their jobs' records; a NULL job_id (org-level, e.g. a template or an
-- unassigned record) stays management-only. Same pattern + helper as slice 1.
-- INSERT/UPDATE/DELETE untouched, so operative FIELD WRITES (raising a permit,
-- recording a toolbox talk, confirming goods received) are unchanged — only READ
-- visibility narrows. Each policy keeps its original name + role targeting (the
-- five safety/inspection tables have no explicit role; material_requests is
-- `to authenticated`).
--
-- OWNER LOCKOUT: none (is_org_admin short-circuits). PERFORMANCE: the assignee
-- set is evaluated once per statement for non-admins only. ROLLBACK: recreate
-- each policy with `using (org_id in (select public.current_org_ids()))` and the
-- original name/role. IDEMPOTENT: dropped by name before (re)create.
-- ============================================================================

-- permits_to_work -------------------------------------------------------------
drop policy if exists permits_select on public.permits_to_work;
create policy permits_select on public.permits_to_work
  for select using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

-- risk_assessments ------------------------------------------------------------
drop policy if exists risk_assessments_select on public.risk_assessments;
create policy risk_assessments_select on public.risk_assessments
  for select using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

-- toolbox_talks ---------------------------------------------------------------
drop policy if exists toolbox_talks_select on public.toolbox_talks;
create policy toolbox_talks_select on public.toolbox_talks
  for select using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

-- inspection_test_plans -------------------------------------------------------
drop policy if exists itp_select on public.inspection_test_plans;
create policy itp_select on public.inspection_test_plans
  for select using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

-- completion_certificates -----------------------------------------------------
drop policy if exists "completion_certificates: members select" on public.completion_certificates;
create policy "completion_certificates: members select" on public.completion_certificates
  for select using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or job_id in (select public.my_assigned_job_ids()))
  );

-- NOTE: material_requests is DEFERRED to its own slice. It has an offline
-- idempotency path (offline-write-expansion, mig 20261083) whose duplicate
-- lookup reads the row back under the member's client — narrowing its SELECT
-- needs the same narrow self-scoped service-role lookup applied to
-- site_diary_entries in slice 1 (server/services/offline-writes.ts), plus the
-- lifecycle tests reconciled. Kept out of this slice to ship the 5 safety/
-- inspection tables cleanly; materials lands next with that offline fix.
