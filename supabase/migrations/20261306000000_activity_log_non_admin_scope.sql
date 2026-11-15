-- activity_log: a non-admin member sees only the actions they performed.
--
-- The permissive policy "activity_log: members can select" admits EVERY member of the
-- org to every row (bar private job documents). The activity trigger copies commercial
-- and personal detail into `metadata` — quote and invoice numbers and totals, customer
-- name / email / phone, lead and payroll events — so a `staff` member, who is refused
-- by RLS on quotes, invoices, customers, leads, payroll and finances, could read the
-- same facts here: through the Data API, the /activity page (linked from the
-- notification bell) and /api/activity. (UI-coverage finding S-1.)
--
-- Fix: a RESTRICTIVE select policy, AND-ed with the existing one. Owners/admins keep the
-- whole org's log; everyone else sees rows where they are the actor. All four readers
-- (activity page, dashboard feed, /api/activity, AI aggregates) use the user client, so
-- they follow this policy with no code change. Writes are unaffected (the log is written
-- by triggers / the service role).
--
-- data-api:exempt: policy-only change; adds no table and no grant.
-- Safe to apply before any code deploy. No precondition on existing rows.
-- Rollback (manual — reopens the exposure):
--   drop policy "activity_log: non-admins see only their own actions" on public.activity_log;

drop policy if exists "activity_log: non-admins see only their own actions" on public.activity_log;
create policy "activity_log: non-admins see only their own actions"
  on public.activity_log
  as restrictive
  for select
  to authenticated
  using (public.is_org_admin(org_id) or actor_id = (select auth.uid()));

comment on policy "activity_log: non-admins see only their own actions" on public.activity_log is
  'Staff are refused on quotes/invoices/customers/leads/payroll by RLS; the activity log '
  'copies their totals and contact details into metadata, so non-admins may read only '
  'the rows they authored. Owners and admins see the whole organisation log.';
