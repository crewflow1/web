-- First-customer QA fix — impersonation-consistent number allocation.
--
-- next_quote_number / next_invoice_number guarded number allocation with a
-- DIRECT membership check (memberships where user_id = auth.uid()). Every other
-- tenant path in the app authorises via public.current_org_ids(), which is
-- impersonation-aware (it returns the impersonated org during an active
-- impersonation session). The direct check is NOT — so an operator impersonating
-- a customer org could create a customer (RLS path) but then hit
-- "Forbidden: not a member of this org" when saving a quote/invoice. That
-- inconsistency breaks the support/impersonation workflow.
--
-- Fix: authorise via current_org_ids() so these two RPCs behave exactly like the
-- rest of the app. Real members are unaffected (their org is in current_org_ids);
-- the service-role admin client stays exempt; non-members are still refused. Pure
-- CREATE OR REPLACE of the guard — the number-computation logic is byte-identical
-- to production. Zero-downtime, backward-compatible. (next_po_number has no guard;
-- next_variation_number already uses current_org_ids — neither is touched.)

create or replace function public.next_quote_number(target_org uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  next_num int;
begin
  if auth.role() is distinct from 'service_role'
     and target_org not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  select coalesce(
    max(cast(substring(number from 'Q-(\d+)') as int)),
    0
  ) + 1
  into next_num
  from public.quotes
  where org_id = target_org
    and number ~ '^Q-\d+$';

  return 'Q-' || lpad(next_num::text, 4, '0');
end;
$$;

create or replace function public.next_invoice_number(target_org uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  next_num int;
begin
  if auth.role() is distinct from 'service_role'
     and target_org not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  select coalesce(
    max(cast(substring(number from 'INV-(\d+)') as int)),
    0
  ) + 1
  into next_num
  from public.invoices
  where org_id = target_org
    and number ~ '^INV-\d+$';

  return 'INV-' || lpad(next_num::text, 4, '0');
end;
$$;
