-- backup-facts.sql — the ONE definition of "what a CrewFlow database contains",
-- shared by the capture side (scripts/ops/offsite-backup.sh, run against the
-- SOURCE database inside the same exported snapshot pg_dump uses) and the proof
-- side (scripts/ops/restore-verify.sh, run against the RESTORED throwaway
-- database). Because both sides execute this exact file, a restore is verified
-- like-for-like by construction: any difference in the JSON it emits is a real
-- difference between source-at-snapshot and the restored copy.
--
-- Input : psql variable `schemas` — comma-separated list of the dumped schemas.
-- Output: ONE row, ONE column — a JSON document (psql must run tuples-only /
--         unaligned). It contains COUNTS and catalogue names only. The only
--         row-derived values are Storage object keys + sizes (needed to cross-
--         check the Storage payload); those stay inside the encrypted bundle
--         and are never printed by either script.
--
-- Read-only: every statement is a SELECT (safe inside a READ ONLY transaction).
-- Extension-owned objects are excluded everywhere (pg_dump does not dump them;
-- they are recreated by CREATE EXTENSION and vary with the extension version).

with params as (
  select string_to_array(:'schemas', ',')::name[] as schemas
),
ns as (
  select n.oid, n.nspname
  from pg_namespace n, params p
  where n.nspname = any (p.schemas)
),
ext_member as (
  select classid, objid from pg_depend where deptype = 'e'
),
rels as (
  select c.oid, ns.nspname, c.relname, c.relkind, c.relrowsecurity, c.relacl
  from pg_class c
  join ns on ns.oid = c.relnamespace
  where not exists (
    select 1 from ext_member e
    where e.classid = 'pg_class'::regclass and e.objid = c.oid
  )
),
kinds as (
  select nspname, 'tables' as kind, count(*) as n
    from rels where relkind in ('r', 'p') group by 1
  union all
  select nspname, 'partitioned_tables', count(*)
    from rels where relkind = 'p' group by 1
  union all
  select nspname, 'views', count(*) from rels where relkind = 'v' group by 1
  union all
  select nspname, 'matviews', count(*) from rels where relkind = 'm' group by 1
  union all
  select nspname, 'sequences', count(*) from rels where relkind = 'S' group by 1
  union all
  select nspname, 'indexes', count(*) from rels where relkind in ('i', 'I') group by 1
  union all
  select r.nspname, 'indexes_invalid', count(*)
    from pg_index i join rels r on r.oid = i.indexrelid
    where not i.indisvalid or not i.indisready group by 1
  union all
  select nspname, 'rls_enabled_tables', count(*)
    from rels where relkind in ('r', 'p') and relrowsecurity group by 1
  union all
  select r.nspname, 'columns', count(*)
    from rels r join pg_attribute a on a.attrelid = r.oid
    where r.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped
    group by 1
  union all
  select r.nspname, 'policies', count(*)
    from pg_policy p join rels r on r.oid = p.polrelid group by 1
  union all
  select r.nspname, 'triggers', count(*)
    from pg_trigger t join rels r on r.oid = t.tgrelid
    where not t.tgisinternal group by 1
  union all
  select r.nspname,
         'constraints_' || case con.contype
           when 'p' then 'primary_key' when 'u' then 'unique'
           when 'f' then 'foreign_key' when 'c' then 'check'
           when 'x' then 'exclusion' else con.contype::text end,
         count(*)
    from pg_constraint con join rels r on r.oid = con.conrelid group by 1, 2
  union all
  select r.nspname, 'constraints_not_valid', count(*)
    from pg_constraint con join rels r on r.oid = con.conrelid
    where not con.convalidated group by 1
  union all
  select ns.nspname, 'functions', count(*)
    from pg_proc p join ns on ns.oid = p.pronamespace
    where not exists (
      select 1 from ext_member e
      where e.classid = 'pg_proc'::regclass and e.objid = p.oid
    ) group by 1
  union all
  select ns.nspname, 'types_enum_domain', count(*)
    from pg_type t join ns on ns.oid = t.typnamespace
    where t.typtype in ('e', 'd')
      and not exists (
        select 1 from ext_member e
        where e.classid = 'pg_type'::regclass and e.objid = t.oid
      ) group by 1
  union all
  -- Data-API reachability: table/view/sequence privileges held by the three
  -- client-facing roles. A restore that silently lost these returns 42501 on
  -- every read even though the rows are present (see the runbook).
  select r.nspname, 'data_api_grants', count(*)
    from rels r
    cross join lateral aclexplode(r.relacl) a
    join pg_roles g on g.oid = a.grantee
    where r.relkind in ('r', 'p', 'v', 'm', 'S')
      and g.rolname in ('anon', 'authenticated', 'service_role') group by 1
  union all
  select r.nspname, 'column_acl_entries', count(*)
    from rels r
    join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    cross join lateral aclexplode(a.attacl) x
    group by 1
),
table_counts as (
  -- Exact per-table row counts. ONLY => a partitioned parent counts 0 and each
  -- partition counts itself, so nothing is double-counted on either side.
  select r.nspname || '.' || r.relname as tbl,
         (xpath('/row/c/text()',
                query_to_xml(format('select count(*) as c from only %I.%I',
                                    r.nspname, r.relname),
                             false, true, '')))[1]::text::bigint as n
  from rels r
  where r.relkind in ('r', 'p')
)
select json_build_object(
  'facts_version', 1,
  'server_version', current_setting('server_version'),
  'server_version_num', current_setting('server_version_num')::int,
  'migration_tip', (select max(version) from supabase_migrations.schema_migrations),
  'migration_count', (select count(*) from supabase_migrations.schema_migrations),
  'schemas', (select json_agg(nspname order by nspname) from ns),
  'extensions', (
    select json_agg(json_build_object('name', e.extname, 'schema', n.nspname,
                                      'version', e.extversion) order by e.extname)
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  ),
  'roles', (select json_agg(rolname order by rolname) from pg_roles where rolname !~ '^pg_'),
  'publications', (select coalesce(json_agg(pubname order by pubname), '[]'::json) from pg_publication),
  'object_counts', (
    select coalesce(json_object_agg(nspname || '.' || kind, n order by nspname, kind), '{}'::json)
    from kinds
  ),
  'table_counts', (
    select coalesce(json_object_agg(tbl, n order by tbl), '{}'::json) from table_counts
  ),
  'storage_buckets', (select coalesce(json_agg(id order by id), '[]'::json) from storage.buckets),
  'storage_objects', (
    select coalesce(json_agg(json_build_object(
             'bucket', o.bucket_id, 'name', o.name,
             'size', nullif(o.metadata ->> 'size', '')::bigint
           ) order by o.bucket_id, o.name), '[]'::json)
    from storage.objects o
  )
)::text;
