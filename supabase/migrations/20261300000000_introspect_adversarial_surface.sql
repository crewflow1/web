-- Adversarial tenant-isolation suite — catalogue introspection (programme: security-tenant).
--
-- The adversarial suite under __tests__/integration/adversarial/ attacks the Data API
-- DIRECTLY (anon key / forged + real JWTs) and must cover EVERY client-reachable table,
-- view and function — including the ones added next month. supabase-js cannot run
-- arbitrary SQL, so (like _introspect_secdef_org_rpcs / _introspect_org_scoped_tables
-- before it) the catalogue query lives in a function the suite calls as service_role.
--
-- CATALOGUE-ONLY: reads pg_catalog / storage.buckets metadata. It returns NO tenant row
-- data, takes no arguments, and is SECURITY INVOKER (it can see nothing the caller
-- cannot). service_role only — the explicit anon/authenticated revoke below is REQUIRED
-- because Supabase default privileges grant EXECUTE to both at CREATE time and
-- `revoke ... from public` does not strip those role-specific grants.
--
-- data-api:exempt: adds no table; the one function it adds is service_role-only.
--
-- Rollback: drop function public._introspect_adversarial_surface();

create or replace function public._introspect_adversarial_surface()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with rels as (
    select c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'graphql_public')
       and c.relkind in ('r', 'p', 'v', 'm')
  ),
  rel_json as (
    select jsonb_agg(
      jsonb_build_object(
        'schema', r.nspname,
        'name', r.relname,
        'kind', r.relkind,
        'rls', r.relrowsecurity,
        'anon', (
          select coalesce(jsonb_agg(p), '[]'::jsonb)
            from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
           where has_table_privilege('anon', r.oid, p)
        ),
        'authenticated', (
          select coalesce(jsonb_agg(p), '[]'::jsonb)
            from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
           where has_table_privilege('authenticated', r.oid, p)
        ),
        'columns', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'name', a.attname,
              'type', format_type(a.atttypid, a.atttypmod),
              'notnull', a.attnotnull,
              'has_default', a.atthasdef,
              'generated', a.attgenerated <> '',
              'identity', a.attidentity <> '',
              'enum', (
                select jsonb_agg(e.enumlabel order by e.enumsortorder)
                  from pg_enum e
                 where e.enumtypid = a.atttypid
              )
            ) order by a.attnum), '[]'::jsonb)
            from pg_attribute a
           where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
        ),
        'pk', (
          select coalesce(jsonb_agg(a.attname order by k.ord), '[]'::jsonb)
            from pg_constraint con
            cross join lateral unnest(con.conkey) with ordinality as k(attnum, ord)
            join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
           where con.conrelid = r.oid and con.contype = 'p'
        ),
        'fks', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'cols', (
                select jsonb_agg(a.attname order by k.ord)
                  from unnest(con.conkey) with ordinality as k(attnum, ord)
                  join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
              ),
              'ref_schema', fn.nspname,
              'ref_table', fc.relname,
              'ref_cols', (
                select jsonb_agg(a.attname order by k.ord)
                  from unnest(con.confkey) with ordinality as k(attnum, ord)
                  join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
              )
            )), '[]'::jsonb)
            from pg_constraint con
            join pg_class fc on fc.oid = con.confrelid
            join pg_namespace fn on fn.oid = fc.relnamespace
           where con.conrelid = r.oid and con.contype = 'f'
        ),
        'checks', (
          select coalesce(jsonb_agg(pg_get_constraintdef(con.oid)), '[]'::jsonb)
            from pg_constraint con
           where con.conrelid = r.oid and con.contype = 'c'
        )
      ) order by r.nspname, r.relname) as j
    from rels r
  ),
  fn_json as (
    select jsonb_agg(
      jsonb_build_object(
        'name', p.proname,
        'identity_args', pg_get_function_identity_arguments(p.oid),
        'arg_names', coalesce(to_jsonb(p.proargnames), '[]'::jsonb),
        'arg_types', (
          select coalesce(jsonb_agg(format_type(t.oid, null) order by x.ord), '[]'::jsonb)
            from unnest(p.proargtypes::oid[]) with ordinality as x(oid, ord)
            join pg_type t on t.oid = x.oid
        ),
        'n_defaults', p.pronargdefaults,
        'returns', pg_get_function_result(p.oid),
        'secdef', p.prosecdef,
        'volatile', p.provolatile = 'v',
        'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
        'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE')
      ) order by p.proname, pg_get_function_identity_arguments(p.oid)) as j
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      -- PostgREST cannot invoke trigger functions.
      and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
      -- Extension-owned functions (pg_trgm, vector, …) are not application surface.
      and not exists (
        select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'
      )
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )
  ),
  bucket_json as (
    select jsonb_agg(jsonb_build_object('id', b.id, 'public', b.public) order by b.id) as j
      from storage.buckets b
  )
  select jsonb_build_object(
    'relations', coalesce((select j from rel_json), '[]'::jsonb),
    'functions', coalesce((select j from fn_json), '[]'::jsonb),
    'buckets',   coalesce((select j from bucket_json), '[]'::jsonb)
  );
$$;

revoke all on function public._introspect_adversarial_surface() from public;
revoke execute on function public._introspect_adversarial_surface() from anon, authenticated;
grant execute on function public._introspect_adversarial_surface() to service_role;

comment on function public._introspect_adversarial_surface() is
  'Schema self-audit for the adversarial tenant-isolation suite '
  '(__tests__/integration/adversarial): every public/graphql_public relation with its '
  'client grants, columns, keys and checks; every client-executable non-trigger public '
  'function with its argument shape; every storage bucket. Catalog-only, no tenant '
  'data; service_role only.';
