-- ============================================================================
-- R5 Phase 4 (slice 1) — commercial/financial read DENIAL for staff.
-- ============================================================================
-- Unlike Phase 3 (staff see their ASSIGNED jobs' operational records), commercial
-- data is barred from staff REGARDLESS of assignment: budgets, valuations, billing
-- plans/stages, variations, retention, supplier purchase orders, and review
-- requests are owner/admin-only. This narrows SELECT to is_org_admin; owners and
-- admins are unaffected. INSERT/UPDATE/DELETE are unchanged here.
--
-- SCOPE OF THIS SLICE (8 unambiguous commercial tables, no staff write path):
--   job_budgets, job_valuations, job_billing_plans, job_billing_stages,
--   variation_requests, retention_releases, purchase_orders, review_requests.
--
-- DELIBERATELY DEFERRED to their own careful slice (they carry a LEGITIMATE
-- field-worker write path that must be preserved, which a blanket SELECT denial
-- can break — e.g. an action that reads its own row back after insert):
--   • finances  — staff COST ENTRY (expenses/receipts) must keep working;
--   • stock_movements — staff GOODS-RECEIVED confirmation must keep working.
-- These need a write-path audit (RETURNING reads, cost-entry UX) before their
-- SELECT is narrowed, so they are intentionally NOT touched in this slice.
--
-- INDIRECT-LEAK NOTE: narrowing the base-table SELECT is necessary but a full
-- Phase 4 also sweeps views/RPCs/signed-URLs/AI outputs that echo these figures.
-- That sweep is tracked separately; this slice closes the direct base-table read.
--
-- LOCKOUT ANALYSIS: is_org_admin() is true for owner/admin, so they keep full
-- access; only non-admin staff lose read. No write policy changes.
-- ROLLBACK: recreate each policy with `using (org_id in (select current_org_ids()))`.
-- ============================================================================

drop policy if exists "job_budgets: members can select" on public.job_budgets;
create policy "job_budgets: members can select" on public.job_budgets
  for select to authenticated
  using (org_id in (select public.current_org_ids()) and public.is_org_admin(org_id));

drop policy if exists "job_valuations: members select" on public.job_valuations;
create policy "job_valuations: members select" on public.job_valuations
  for select to authenticated
  using (org_id in (select public.current_org_ids()) and public.is_org_admin(org_id));

drop policy if exists job_billing_plans_select on public.job_billing_plans;
create policy job_billing_plans_select on public.job_billing_plans
  for select to authenticated
  using (org_id in (select public.current_org_ids()) and public.is_org_admin(org_id));

drop policy if exists job_billing_stages_select on public.job_billing_stages;
create policy job_billing_stages_select on public.job_billing_stages
  for select to authenticated
  using (org_id in (select public.current_org_ids()) and public.is_org_admin(org_id));

drop policy if exists variation_requests_select on public.variation_requests;
create policy variation_requests_select on public.variation_requests
  for select to authenticated
  using (org_id in (select public.current_org_ids()) and public.is_org_admin(org_id));

drop policy if exists "retention_releases: members can select" on public.retention_releases;
create policy "retention_releases: members can select" on public.retention_releases
  for select to authenticated
  using (org_id in (select public.current_org_ids()) and public.is_org_admin(org_id));

drop policy if exists "purchase_orders: members can select" on public.purchase_orders;
create policy "purchase_orders: members can select" on public.purchase_orders
  for select to authenticated
  using (org_id in (select public.current_org_ids()) and public.is_org_admin(org_id));

drop policy if exists review_requests_select on public.review_requests;
create policy review_requests_select on public.review_requests
  for select to authenticated
  using (org_id in (select public.current_org_ids()) and public.is_org_admin(org_id));
