-- residue-scan.sql — catalogue-driven marker search (LOCAL verification tool).
--
-- Searches EVERY text / citext / varchar / json / jsonb / text[] column of
-- EVERY ordinary table in every non-system schema (public, auth, storage, and
-- anything else present) for each marker string, case-insensitively. Nothing is
-- assumed about which tables "should" hold personal data — that is the point.
--
-- psql vars: markers — a Postgres text[] literal, e.g. '{Zq1,zq1@x.invalid}'.
-- Output: one line per (schema.table.column, marker) with a non-zero hit count.
select set_config('scan.markers', :'markers', false) \gset _ignored_

create temp table if not exists _residue (sch text, tbl text, col text, marker text, hits bigint);
truncate _residue;

do $do$
declare
  r record;
  m text;
  n bigint;
begin
  for r in
    select n.nspname as sch, c.relname as tbl, a.attname as col
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    join pg_type t on t.oid = a.atttypid
    where c.relkind = 'r'
      and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
      and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast%'
      and (t.typname in ('text', 'varchar', 'bpchar', 'citext', 'json', 'jsonb', 'name', '_text', '_varchar', '_citext'))
      and has_table_privilege(c.oid, 'select')
    order by 1, 2, 3
  loop
    foreach m in array current_setting('scan.markers')::text[] loop
      execute format('select count(*) from %I.%I where %I::text ilike $1', r.sch, r.tbl, r.col)
        into n using '%' || replace(replace(m, '%', '\%'), '_', '\_') || '%';
      if n > 0 then
        insert into _residue values (r.sch, r.tbl, r.col, m, n);
      end if;
    end loop;
  end loop;
end $do$;

select sch || '.' || tbl || '.' || col as location, marker, hits from _residue order by 1, 2;
select count(*) as residue_locations, coalesce(sum(hits), 0) as residue_hits from _residue;
