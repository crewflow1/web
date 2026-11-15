-- Column-ACL proof (migrations 20261341 / 20261342 / 20261343) — NON-DESTRUCTIVE.
--
-- Applies the three migrations inside ONE transaction, asserts the resulting
-- privileges as the `authenticated` and `service_role` roles, then ROLLS BACK.
-- Nothing is committed, so it is safe on a database other workstreams share and on
-- any database where the migrations are already applied (they are idempotent).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f docs/programme/security-least-privilege/proofs/column-acl-proof.sql
--
-- Every line of output starts PASS or FAIL; the script raises on the first FAIL.
\set QUIET on
\pset tuples_only on
\pset format unaligned
set client_min_messages = warning;
begin;
\i supabase/migrations/20261341000000_customers_portal_credential_column_acl.sql
\i supabase/migrations/20261342000000_users_private_profile_column_acl.sql
\i supabase/migrations/20261343000000_asset_and_vehicle_money_column_acl.sql
set client_min_messages = notice;

create function pg_temp.expect(label text, sql text, want_denied boolean) returns void
language plpgsql as $$
declare denied boolean := false;
begin
  begin
    execute sql;
  exception when insufficient_privilege then
    denied := true;
  end;
  if denied is distinct from want_denied then
    raise exception 'FAIL %: expected % but was %', label,
      case when want_denied then 'DENIED' else 'ALLOWED' end,
      case when denied then 'DENIED' else 'ALLOWED' end;
  end if;
  raise notice 'PASS % → %', label, case when denied then 'denied (42501)' else 'allowed' end;
end $$;
grant execute on function pg_temp.expect(text, text, boolean) to authenticated, anon, service_role;

-- ── as a signed-in member (any role: owner, admin or staff share `authenticated`) ──
set local role authenticated;
select pg_temp.expect('authenticated: customers.portal_token',            'select portal_token from public.customers limit 0', true);
select pg_temp.expect('authenticated: customers.*',                       'select * from public.customers limit 0', true);
select pg_temp.expect('authenticated: customers name/phone/address',      'select id, org_id, name, email, phone, address_line1, postcode, portal_token_expires_at from public.customers limit 0', false);
select pg_temp.expect('authenticated: UPDATE customers.portal_token (rotate action; RLS still decides the row)',
                                                                           'update public.customers set portal_token = gen_random_uuid() where id = ''00000000-0000-0000-0000-000000000000''', false);
select pg_temp.expect('authenticated: customer_contacts.portal_token',    'select portal_token from public.customer_contacts limit 0', true);
select pg_temp.expect('authenticated: customer_contacts name/email',      'select id, org_id, customer_id, name, email, phone, portal_access_enabled from public.customer_contacts limit 0', false);
select pg_temp.expect('authenticated: users.phone',                       'select phone from public.users limit 0', true);
select pg_temp.expect('authenticated: users.employment_type',             'select employment_type from public.users limit 0', true);
select pg_temp.expect('authenticated: users.start_date',                  'select start_date from public.users limit 0', true);
select pg_temp.expect('authenticated: users id/full_name/email/avatar',   'select id, full_name, email, avatar_url from public.users limit 0', false);
select pg_temp.expect('authenticated: assets.purchase_price',             'select purchase_price from public.assets limit 0', true);
select pg_temp.expect('authenticated: assets.current_value',              'select current_value from public.assets limit 0', true);
select pg_temp.expect('authenticated: assets.hire_rate',                  'select hire_rate from public.assets limit 0', true);
select pg_temp.expect('authenticated: assets identity columns',           'select id, org_id, name, category, status, serial_number, registration from public.assets limit 0', false);
select pg_temp.expect('authenticated: fleet_vehicles.finance_monthly_payment', 'select finance_monthly_payment from public.fleet_vehicles limit 0', true);
select pg_temp.expect('authenticated: fleet_vehicles.finance_agreement_ref',   'select finance_agreement_ref from public.fleet_vehicles limit 0', true);
select pg_temp.expect('authenticated: fleet_vehicles operational columns','select asset_id, org_id, operational_status, odometer_miles, home_site_id from public.fleet_vehicles limit 0', false);
reset role;

-- ── anon: same narrowed grant (it has no policy path to any row) ──
set local role anon;
select pg_temp.expect('anon: customers.portal_token', 'select portal_token from public.customers limit 0', true);
select pg_temp.expect('anon: users.phone',            'select phone from public.users limit 0', true);
select pg_temp.expect('anon: assets.purchase_price',  'select purchase_price from public.assets limit 0', true);
select pg_temp.expect('anon: customers.id (grant unchanged; RLS returns no rows)', 'select id from public.customers limit 0', false);
reset role;

-- ── the server keeps full access ──
set local role service_role;
select pg_temp.expect('service_role: customers.portal_token', 'select portal_token from public.customers limit 0', false);
select pg_temp.expect('service_role: users.phone',            'select phone, employment_type, start_date from public.users limit 0', false);
select pg_temp.expect('service_role: assets money',           'select purchase_price, current_value, hire_rate from public.assets limit 0', false);
select pg_temp.expect('service_role: fleet finance',          'select finance_type, finance_monthly_payment from public.fleet_vehicles limit 0', false);
reset role;

-- ── completeness: every non-private column IS client-readable (the new-column trap) ──
do $$
declare missing text;
begin
  select string_agg(c.relname || '.' || a.attname, ', ')
    into missing
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
   where c.oid in ('public.customers'::regclass, 'public.customer_contacts'::regclass, 'public.users'::regclass,
                   'public.assets'::regclass, 'public.fleet_vehicles'::regclass)
     and a.attnum > 0 and not a.attisdropped
     and (c.relname, a.attname) not in (
       ('customers', 'portal_token'), ('customer_contacts', 'portal_token'),
       ('users', 'phone'), ('users', 'employment_type'), ('users', 'start_date'),
       ('assets', 'purchase_price'), ('assets', 'current_value'), ('assets', 'hire_rate'),
       ('fleet_vehicles', 'finance_type'), ('fleet_vehicles', 'finance_provider_id'),
       ('fleet_vehicles', 'finance_agreement_ref'), ('fleet_vehicles', 'finance_monthly_payment'),
       ('fleet_vehicles', 'finance_end_date'))
     and not has_column_privilege('authenticated', c.oid, a.attname, 'SELECT');
  if missing is not null then
    raise exception 'FAIL completeness: non-private column(s) lost client SELECT: %', missing;
  end if;
  raise notice 'PASS completeness → every non-private column of the five tables is still client-readable';
end $$;

rollback;
\echo ROLLED BACK — nothing was changed.
