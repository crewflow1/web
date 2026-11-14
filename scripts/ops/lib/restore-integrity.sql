-- restore-integrity.sql — independent key-constraint validation of a RESTORED
-- throwaway database (scripts/ops/restore-verify.sh). Never run against the
-- source: it creates a temp table and scans every foreign key.
--
-- pg_restore already re-validates each foreign key when it re-creates it, but
-- "the tool said so" is exactly what a restore drill must not rely on. This
-- re-derives referential integrity from the data itself: for EVERY validated
-- foreign key it counts child rows whose (fully non-null) key has no parent
-- row. The expected answer is zero. NOT VALID foreign keys are skipped — they
-- legitimately tolerate historical orphans at source — and reported as such.
--
-- It also re-checks that every PRIMARY KEY / UNIQUE constraint is backed by a
-- valid, ready, unique index (a failed index build would leave it invalid).
--
-- Input : psql variable `schemas` (comma list of the restored schemas).
-- Output: one summary row, then one row per violating constraint (catalogue
--         identifiers and counts only — never key values).

\set ON_ERROR_STOP on
set search_path = '';
select set_config('cf.schemas', :'schemas', false) \g /dev/null

create temp table _cf_fk_scan (conname text, child text, orphans bigint);

do $scan$
declare
  r record;
  n bigint;
  join_cond text;
  not_null_cond text;
begin
  for r in
    select con.conname, con.conrelid, con.confrelid, con.conkey, con.confkey,
           con.conrelid::regclass::text as child,
           con.confrelid::regclass::text as parent
    from pg_constraint con
    join pg_namespace ns on ns.oid = con.connamespace
    where con.contype = 'f'
      and con.convalidated
      and con.conparentid = 0
      and ns.nspname = any (string_to_array(current_setting('cf.schemas'), ','))
  loop
    select string_agg(format('p.%I = c.%I', pa.attname, ca.attname), ' and ' order by k.ord),
           string_agg(format('c.%I is not null', ca.attname), ' and ' order by k.ord)
      into join_cond, not_null_cond
    from unnest(r.conkey, r.confkey) with ordinality as k(child_att, parent_att, ord)
    join pg_attribute ca on ca.attrelid = r.conrelid and ca.attnum = k.child_att
    join pg_attribute pa on pa.attrelid = r.confrelid and pa.attnum = k.parent_att;

    execute format(
      'select count(*) from %s c where %s and not exists (select 1 from %s p where %s)',
      r.child, not_null_cond, r.parent, join_cond
    ) into n;
    insert into _cf_fk_scan values (r.conname, r.child, n);
  end loop;
end
$scan$;

-- Summary: fk_checked | fk_with_orphans | fk_skipped_not_valid | key_constraints | key_constraints_bad
select
  (select count(*) from _cf_fk_scan),
  (select count(*) from _cf_fk_scan where orphans > 0),
  (select count(*)
     from pg_constraint con join pg_namespace ns on ns.oid = con.connamespace
    where con.contype = 'f' and not con.convalidated and con.conparentid = 0
      and ns.nspname = any (string_to_array(current_setting('cf.schemas'), ','))),
  (select count(*)
     from pg_constraint con join pg_namespace ns on ns.oid = con.connamespace
    where con.contype in ('p', 'u')
      and ns.nspname = any (string_to_array(current_setting('cf.schemas'), ','))),
  (select count(*)
     from pg_constraint con
     join pg_namespace ns on ns.oid = con.connamespace
     left join pg_index i on i.indexrelid = con.conindid
    where con.contype in ('p', 'u')
      and ns.nspname = any (string_to_array(current_setting('cf.schemas'), ','))
      and (i.indexrelid is null or not i.indisvalid or not i.indisready or not i.indisunique));

select 'VIOLATION', child, conname, orphans from _cf_fk_scan where orphans > 0 order by 2, 3;
