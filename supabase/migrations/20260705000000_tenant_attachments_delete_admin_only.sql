-- Tenant attachments: restrict DELETE to org owners/admins (launch stabilization).
--
-- P2 audit M-5. tenant_attachments holds polymorphic file attachments for
-- tenant entities (customers, jobs, quotes, invoices, suppliers, memberships,
-- leads). Its original RLS (migration 20260623000000) granted DELETE to ANY
-- member of the owning org:
--
--   create policy tenant_attachments_delete on public.tenant_attachments
--     for delete using (org_id in (select public.current_org_ids()));
--
-- That contradicts the documented intent ("Delete: owner/admin only") and lets
-- a low-privilege staff/member account permanently destroy any file attached to
-- any record in their org — including financial documents on quotes/invoices.
-- It is also the unsafe default for the upcoming Job Documents feature, where
-- some attachments are meant to be admin-managed.
--
-- This migration tightens DELETE to owner/admin only, reusing the existing
-- impersonation-aware helper public.is_org_admin(org_id) (true only for a real
-- owner/admin membership in that org — or, during an operator impersonation
-- session, only within the impersonated org). SELECT and INSERT are deliberately
-- LEFT UNCHANGED: every member may still view and upload attachments.
--
-- Idempotent: drop-if-exists then recreate, so re-running is a no-op.
-- Non-destructive: policy-only change; no data is touched.

drop policy if exists tenant_attachments_delete on public.tenant_attachments;

create policy tenant_attachments_delete on public.tenant_attachments
  for delete using (public.is_org_admin(org_id));
