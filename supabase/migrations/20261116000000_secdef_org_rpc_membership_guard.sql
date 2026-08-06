-- SECURITY DEFINER org-RPC membership guard.
--
-- WHY THIS EXISTS
-- ---------------
-- Six public SECURITY DEFINER functions take an org argument, are EXECUTE-able
-- by anon AND authenticated (Supabase default privileges grant EXECUTE on new
-- public functions to anon + authenticated at CREATE time), and carried NO
-- membership guard. Because SECURITY DEFINER bypasses RLS, each was directly
-- callable via POST /rest/v1/rpc/<fn> with the PUBLIC anon key against an
-- arbitrary target org — a cross-tenant read primitive:
--
--   next_po_number / next_certificate_number / next_grn_number /
--   next_material_request_number    — leak each victim org's document
--                                     high-water counter.
--   cis_statement_ledger_fingerprint /
--   cis_monthly_return_ledger_fingerprint
--                                   — return a SHA-256 change-detection oracle
--                                     over a victim org's CIS ledger.
--
-- THE FIX
-- -------
-- The CORRECT pattern already ships on next_invoice_number / next_quote_number /
-- next_variation_number: an impersonation-aware guard that authorises via
-- public.current_org_ids() and raises 42501 for a non-member, while leaving
-- service_role (and real members) unaffected. This migration CREATE OR REPLACEs
-- each of the six functions PRESERVING its exact signature, return type,
-- SECURITY DEFINER, `set search_path` and its counting / fingerprint logic
-- VERBATIM, and only PREPENDS that guard. No counting or fingerprint logic is
-- changed. The `grant execute ... to authenticated` is kept (mirroring the
-- invoice/quote pattern: guarded, not revoked — real members must still call
-- these). Idempotent by construction (CREATE OR REPLACE).
--
-- The two cis_*_fingerprint functions were `language sql`, which cannot host an
-- imperative guard; they are converted to `language plpgsql` with the SELECT
-- returned verbatim inside `return (...)`. The computed digest is byte-identical.
--
-- Original (immutable) definitions, unchanged except for the prepended guard:
--   next_po_number                        supabase/migrations/20261006000000_purchase_orders.sql
--   next_certificate_number               supabase/migrations/20261014000000_completion_certificates.sql
--   next_grn_number                       supabase/migrations/20261059000000_goods_received_notes.sql
--   next_material_request_number          supabase/migrations/20261066000000_material_requests.sql
--   cis_statement_ledger_fingerprint      supabase/migrations/20261055000000_cis_statements.sql
--   cis_monthly_return_ledger_fingerprint supabase/migrations/20261055000000_cis_statements.sql

-- ─────────────────────────────────────────────────────────────────────────
-- 1. next_po_number(target_org uuid)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.next_po_number(target_org uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  next_num int;
begin
  if auth.role() is distinct from 'service_role'
     and target_org not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  select coalesce(max(cast(substring(number from 'PO-(\d+)') as int)), 0) + 1
  into next_num
  from public.purchase_orders
  where org_id = target_org
    and number ~ '^PO-\d+$';
  return 'PO-' || lpad(next_num::text, 4, '0');
end;
$$;
grant execute on function public.next_po_number(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. next_certificate_number(target_org uuid)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.next_certificate_number(target_org uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  next_num int;
begin
  if auth.role() is distinct from 'service_role'
     and target_org not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  select coalesce(max(cast(substring(certificate_number from 'CERT-(\d+)') as int)), 0) + 1
  into next_num
  from public.completion_certificates
  where org_id = target_org
    and certificate_number ~ '^CERT-\d+$';
  return 'CERT-' || lpad(next_num::text, 4, '0');
end;
$$;
grant execute on function public.next_certificate_number(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. next_grn_number(target_org uuid)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.next_grn_number(target_org uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  next_num int;
begin
  if auth.role() is distinct from 'service_role'
     and target_org not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  select coalesce(max(cast(substring(number from 'GRN-(\d+)') as int)), 0) + 1
  into next_num
  from public.goods_received_notes
  where org_id = target_org
    and number ~ '^GRN-\d+$';
  return 'GRN-' || lpad(next_num::text, 4, '0');
end;
$$;
grant execute on function public.next_grn_number(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. next_material_request_number(target_org uuid)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.next_material_request_number(target_org uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  next_num int;
begin
  if auth.role() is distinct from 'service_role'
     and target_org not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  select coalesce(max(cast(substring(number from 'MR-(\d+)') as int)), 0) + 1
  into next_num
  from public.material_requests
  where org_id = target_org
    and number ~ '^MR-\d+$';
  return 'MR-' || lpad(next_num::text, 4, '0');
end;
$$;
grant execute on function public.next_material_request_number(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. cis_statement_ledger_fingerprint(p_org_id uuid, p_supplier_id uuid, p_tax_month_end date)
--    (was language sql — converted to plpgsql to host the guard; digest verbatim)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.cis_statement_ledger_fingerprint(
  p_org_id uuid, p_supplier_id uuid, p_tax_month_end date
) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  return (
    select encode(
      extensions.digest(
        coalesce(
          string_agg(
            s.payment_id::text || ':' || s.cis_gross_payment::text || ':'
              || s.materials_total::text || ':' || s.citb_total::text || ':'
              || s.cis_basis::text || ':' || s.cis_deduction::text,
            '|' order by s.payment_id
          ),
          ''  -- an empty month has a stable, well-defined fingerprint of its own
        ),
        'sha256'
      ),
      'hex'
    )
    from public.cis_payment_snapshots s
    join public.supplier_payments p on p.id = s.payment_id
   where s.org_id = p_org_id
     and s.supplier_id = p_supplier_id
     and s.tax_month_end = p_tax_month_end
     and p.voided_at is null
  );
end;
$$;

grant execute on function public.cis_statement_ledger_fingerprint(uuid, uuid, date)
  to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. cis_monthly_return_ledger_fingerprint(p_org_id uuid, p_tax_month_end date)
--    (was language sql — converted to plpgsql to host the guard; digest verbatim)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.cis_monthly_return_ledger_fingerprint(
  p_org_id uuid, p_tax_month_end date
) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  return (
    select encode(extensions.digest(
      coalesce(string_agg(
        x.supplier_id::text || ':' || x.gross::text || ':'
          || x.materials::text || ':' || x.deduction::text,
        '|' order by x.supplier_id), ''), 'sha256'), 'hex')
    from (
      select s.supplier_id,
             sum(s.cis_gross_payment) as gross,
             sum(s.materials_total)   as materials,
             sum(s.cis_deduction)     as deduction
        from public.cis_payment_snapshots s
        join public.supplier_payments p on p.id = s.payment_id
       where s.org_id = p_org_id
         and s.tax_month_end = p_tax_month_end
         and p.voided_at is null
       group by s.supplier_id
    ) x
  );
end;
$$;

grant execute on function public.cis_monthly_return_ledger_fingerprint(uuid, date)
  to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. purchase_order_receipt_state(p_po_id uuid, p_org_id uuid)
--    orig def: supabase/migrations/20261060000000_purchase_order_receipt_state.sql
--
--    Its membership check was gated on `auth.uid() is not null`, so an ANON
--    caller SKIPPED it entirely — and because this is SECURITY DEFINER (RLS
--    bypassed), anon holding a matching (po_id, org_id) uuid pair could read a
--    victim org's receipt state. Replace ONLY that gated check with the same
--    canonical guard applied to the six (for anon, current_org_ids() is empty,
--    so anon is denied; genuine members and service_role still pass). The
--    existence check and return are preserved verbatim.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.purchase_order_receipt_state(p_po_id uuid, p_org_id uuid)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.purchase_orders where id = p_po_id and org_id = p_org_id
  ) then
    raise exception 'purchase order not found' using errcode = 'no_data_found';
  end if;
  return public.po_receipt_state(p_po_id);
end $$;
grant execute on function public.purchase_order_receipt_state(uuid, uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. material_request_fulfilment_state(p_request_id uuid, p_org_id uuid, p_fulfilled jsonb)
--    orig def: supabase/migrations/20261067000000_material_request_lifecycle.sql
--
--    Same anon-reachable weakness as section 7 — same canonical-guard fix. The
--    existence check and return are preserved verbatim.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.material_request_fulfilment_state(
  p_request_id uuid,
  p_org_id     uuid,
  p_fulfilled  jsonb
)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.material_requests where id = p_request_id and org_id = p_org_id
  ) then
    raise exception 'material request not found' using errcode = 'no_data_found';
  end if;
  return public.material_request_state(p_request_id, p_fulfilled);
end $$;
grant execute on function public.material_request_fulfilment_state(uuid, uuid, jsonb)
  to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Schema self-audit for the systemic guard test.
--
-- Lists every public SECURITY DEFINER function that (a) is EXECUTE-able by anon
-- or authenticated and (b) takes at least one uuid argument — i.e. the exact
-- class this migration hardens. For each it reports whether the body is
-- membership-guarded (references current_org_ids AND raises 42501). The test
-- asserts every such function is either guarded or explicitly allowlisted.
--
-- Catalog-only, no tenant data; SECURITY INVOKER; service_role only (mirrors
-- public._introspect_bare_cross_tenant_fks, migration 20261113000000).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public._introspect_secdef_org_rpcs()
returns table (
  proname text,
  identity_args text,
  anon_exec boolean,
  auth_exec boolean,
  guarded boolean
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select
    p.proname::text,
    pg_get_function_identity_arguments(p.oid) as identity_args,
    has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_exec,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
    (pg_get_functiondef(p.oid) ilike '%current_org_ids%'
       and pg_get_functiondef(p.oid) like '%42501%')          as guarded
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef                                   -- SECURITY DEFINER only
    and 'uuid'::regtype = any (p.proargtypes)          -- takes a uuid argument
    and (
      has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
    )
  order by p.proname, identity_args;
$$;

-- service_role only. `revoke ... from public` does NOT strip the role-specific
-- anon/authenticated EXECUTE grants that Supabase default privileges add at
-- CREATE time (the exact trap 20261114000000 documents), so revoke those
-- explicitly too — otherwise this catalog self-audit ships anon-readable.
revoke all on function public._introspect_secdef_org_rpcs() from public;
revoke execute on function public._introspect_secdef_org_rpcs() from anon, authenticated;
grant execute on function public._introspect_secdef_org_rpcs() to service_role;

comment on function public._introspect_secdef_org_rpcs() is
  'Schema self-audit for the SECURITY DEFINER org-RPC membership-guard test: '
  'lists every public SECURITY DEFINER function that is EXECUTE-able by anon or '
  'authenticated and takes a uuid argument, flagging whether its body is '
  'membership-guarded (references current_org_ids and raises 42501). '
  'Catalog-only, no tenant data; service_role only.';
