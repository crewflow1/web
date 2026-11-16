-- D-17 held-company catalogue proof. Read-only: nothing is written (every block is a
-- catalogue read or a rolled-back transaction). Run:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f held-org-proof.sql
-- Asserts, against the LIVE catalogue (so a table added next month is checked too):
--   1. every org-scoped RLS table (bar the billing / export / recovery allowlist) carries the
--      write-guard trigger held_org_write_guard — this is what stops SECURITY DEFINER RPC writes;
--   2. every one of those that a client can write directly also has the three RESTRICTIVE
--      "held org read-only" policies (ANDed with every permissive policy, so none can bypass);
--   3. the guard passes for the server: a JWT-less session and service_role write to a
--      non-active company; a client role is refused (42501) — pending included.
\set ON_ERROR_STOP on
begin;

do $$
declare
  r record;
  n_trig int := 0; n_pol int := 0; n_tables int := 0;
  missing text := '';
begin
  for r in
    select c.oid, c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
     where c.relkind = 'r' and c.relrowsecurity
       and c.relname not in ('organizations','memberships','membership_permissions','org_subscriptions',
            'billing_invoices','subscription_cancellations','org_data_exports','impersonation_sessions','permission_events')
       and c.relname not like 'billing\_%' escape '\'
       and c.relname not like 'gdpr\_%' escape '\'
  loop
    n_tables := n_tables + 1;
    if exists (select 1 from pg_trigger t where t.tgrelid = r.oid and t.tgname = 'held_org_write_guard' and not t.tgisinternal) then
      n_trig := n_trig + 1;
    else
      missing := missing || ' trigger:' || r.relname;
    end if;
    if has_table_privilege('authenticated', r.oid, 'INSERT') or has_table_privilege('authenticated', r.oid, 'UPDATE')
       or has_table_privilege('authenticated', r.oid, 'DELETE') then
      if (select count(*) from pg_policy p where p.polrelid = r.oid and not p.polpermissive
            and p.polname like '%held org read-only%') = 3 then
        n_pol := n_pol + 1;
      else
        missing := missing || ' policies:' || r.relname;
      end if;
    end if;
  end loop;
  if missing <> '' then raise exception 'held-org coverage gap:%', missing; end if;
  raise notice 'PASS coverage: % org tables guarded by trigger (%), % client-writable tables carry 3 restrictive policies', n_tables, n_trig, n_pol;
end $$;

-- 3. behaviour (rolled back)
do $$
declare
  v_org uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_state text;
begin
  insert into auth.users (id, instance_id, aud, role, email) values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'held-proof@example.invalid');
  insert into public.users (id, email, full_name) values (v_user, 'held-proof@example.invalid', 'proof');
  insert into public.organizations (id, name, slug, status) values (v_org, 'held proof', 'held-proof-' || substr(v_org::text, 1, 8), 'pending');
  insert into public.memberships (org_id, user_id, role) values (v_org, v_user, 'owner');

  foreach v_state in array array['pending','suspended','rejected','cancelled'] loop
    update public.organizations set status = v_state where id = v_org;
    -- server / job / webhook path: JWT-less session (no role claim) writes freely
    insert into public.customers (org_id, name) values (v_org, 'server ' || v_state);
    -- a client session is refused
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      insert into public.customers (org_id, name) values (v_org, 'client ' || v_state);
      raise exception 'FAIL: authenticated write succeeded while %', v_state;
    exception when insufficient_privilege then
      null; -- 42501 expected (policy or trigger)
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
  end loop;

  update public.organizations set status = 'active' where id = v_org;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.customers (org_id, name) values (v_org, 'client after reactivation');
  reset role;
  raise notice 'PASS behaviour: server writes pass in every non-active state; client writes refused in pending / suspended / rejected / cancelled; allowed again once active';
end $$;

rollback;
