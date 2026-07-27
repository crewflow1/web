-- Security hardening: close cross-tenant holes on SECURITY DEFINER RPCs that
-- Supabase's default privileges left reachable through PostgREST with the
-- public anon key (POST /rest/v1/rpc/<fn>).
--
-- Same bug class as 20260708000000_rate_limit_rpc_lockdown.sql. Supabase runs
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO
-- anon, authenticated, service_role`, so every public function is callable by
-- anon + authenticated unless explicitly locked down. Unlike the rate-limit
-- functions (created with `revoke all ... from public`), the three functions
-- below pre-date that hygiene and ALSO carry the built-in PUBLIC execute grant.
-- The fix therefore revokes PUBLIC as well: revoking only anon/authenticated
-- would leave them reachable via the surviving PUBLIC grant.
--
-- 1) public._record_activity(uuid,text,text,uuid,jsonb,text) -- REVOKE.
--    SECURITY DEFINER; inserts into activity_log(org_id := p_org_id, actor_name
--    := coalesce(p_actor_override, ...)) with NO check that the caller belongs
--    to p_org_id, bypassing activity_log RLS. Reachable by anon/authenticated
--    it lets anyone forge audit-log rows into ANY org (cross-tenant) and spoof
--    actor_name. It is only ever invoked from (a) the 13 SECURITY DEFINER
--    `_tg_*_activity` trigger functions, all owned by `postgres` -- they run as
--    the owner and keep EXECUTE -- and (b) server actions using the service-role
--    admin client (app/admin/actions.ts, app/(app)/quotes/actions.ts). No
--    user-client (anon/authenticated) call path exists, so a hard revoke is
--    correct and leaves all application behaviour unchanged.
--    Severity: Medium (audit-log integrity; no data read exposure).
--
-- 2) public.next_invoice_number(uuid) / public.next_quote_number(uuid) -- GUARD.
--    Both are STABLE and compute max(number)+1 by reading the org's existing
--    rows; they do NOT persist/mutate a counter, so there is no "number burn"
--    risk -- a number is only consumed when a quote/invoice row is actually
--    inserted (under RLS). The exposure is a cross-tenant info leak: passing
--    another org's id reveals that org's invoice/quote high-water number. These
--    ARE called from the authenticated user client (createQuote,
--    POST /api/invoices) AND the service-role admin client (the public
--    quote-accept-by-token auto-invoice path), so they cannot be revoked.
--    Instead add an in-function membership guard mirroring public.append_job_photo:
--    end-users must belong to target_org; the service-role admin client (trusted
--    server code) is allowed through. auth.uid()/auth.role() read the request
--    JWT and stay correct inside SECURITY DEFINER (the definer switches the SQL
--    role, not the request context). Severity: Low.
--
-- public.next_variation_number(uuid) already enforces membership via
-- current_org_ids() and is intentionally left unchanged.
--
-- Idempotent: REVOKE of an absent privilege is a no-op; CREATE OR REPLACE
-- re-defines in place. Safe to (re)apply.

-- 1) Lock _record_activity to internal callers (postgres owner + service_role).
revoke execute on function public._record_activity(uuid, text, text, uuid, jsonb, text)
  from public, anon, authenticated;

-- 2) Tenant-guard next_invoice_number (keep callable by org members + service role).
create or replace function public.next_invoice_number(target_org uuid)
returns text
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  next_num int;
begin
  -- Tenant guard: end-users may only allocate numbers for an org they belong
  -- to; the service-role admin client (trusted server code) is exempt.
  if auth.role() is distinct from 'service_role'
     and not exists (
       select 1 from public.memberships
       where user_id = auth.uid() and org_id = target_org
     ) then
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
$function$;

-- 2b) Tenant-guard next_quote_number (same shape).
create or replace function public.next_quote_number(target_org uuid)
returns text
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  next_num int;
begin
  if auth.role() is distinct from 'service_role'
     and not exists (
       select 1 from public.memberships
       where user_id = auth.uid() and org_id = target_org
     ) then
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
$function$;
