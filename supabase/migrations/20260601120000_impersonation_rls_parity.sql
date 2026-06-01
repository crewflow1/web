-- Fix: 6 tables used is_org_member(org_id) for SELECT, which checks auth.uid()
-- and is therefore blind to HQ impersonation. Every other tenant table uses
-- current_org_ids() (impersonation-aware), so under "Switch to customer view"
-- an HQ admin could see jobs/customers/invoices but NOT timesheets, leave,
-- rota, bank statements or payments. Align these 6 to current_org_ids().
--
-- Security is unchanged for normal users: current_org_ids() already returns
-- only the caller's own org(s); it additionally includes the impersonated org
-- for an active HQ impersonation session (same helper the 34 other tables use).

drop policy if exists "time_entries: members select" on public.time_entries;
create policy "time_entries: members select" on public.time_entries
  for select using (org_id in (select current_org_ids()));

drop policy if exists "leave: org members select" on public.leave_requests;
create policy "leave: org members select" on public.leave_requests
  for select using (org_id in (select current_org_ids()));

drop policy if exists "rota: members select" on public.rota_entries;
create policy "rota: members select" on public.rota_entries
  for select using (org_id in (select current_org_ids()));

drop policy if exists "bank_statements: members select" on public.bank_statements;
create policy "bank_statements: members select" on public.bank_statements
  for select using (org_id in (select current_org_ids()));

drop policy if exists "bank_lines: members select" on public.bank_statement_lines;
create policy "bank_lines: members select" on public.bank_statement_lines
  for select using (org_id in (select current_org_ids()));

drop policy if exists "invoice_payments: members select" on public.invoice_payments;
create policy "invoice_payments: members select" on public.invoice_payments
  for select using (org_id in (select current_org_ids()));
