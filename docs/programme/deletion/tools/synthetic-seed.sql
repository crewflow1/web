-- synthetic-seed.sql — catalogue-driven SYNTHETIC fixture generator (LOCAL ONLY).
--
-- Purpose: populate ONE synthetic organisation with a row in as many org-scoped
-- tables as the schema will accept, writing distinctive MARKER strings into
-- every text / citext / jsonb column, so an erasure can afterwards be verified
-- by a catalogue-wide marker search (see residue-scan.sql). Never run against
-- production: it is a fixture fuzzer.
--
-- psql vars: org (uuid), usr (uuid, an existing public.users id that is a
-- member of the org), mname / memail / mphone (marker strings).
--
-- Strategy per table (retried in passes until no further progress, so FK
-- parents fill before children):
--   * org_id            -> :org
--   * FK -> users       -> :usr
--   * FK -> other table -> a row of that table in the same org (else skip col;
--                          if NOT NULL the table waits for a later pass)
--   * CHECK col = ANY(ARRAY[..]) / enum -> first allowed value
--   * text-ish          -> marker (email-ish names get the email marker,
--                          phone-ish the phone marker, the rest the name marker)
--   * jsonb             -> {"name":..,"email":..,"phone":..}
--   * other NOT NULL without default -> a neutral literal
-- Attempt 1 fills ALL text/jsonb columns; attempt 2 only the required ones.
-- A table that still refuses (a state-machine trigger, a composite invariant)
-- is REPORTED as unseeded — coverage is stated, never assumed.

create or replace function pg_temp.seed_table(
  p_tbl text, p_org uuid, p_usr uuid, p_name text, p_email text, p_phone text, p_all boolean
) returns text language plpgsql as $f$
declare
  r record;
  v_cols text[] := '{}';
  v_vals text[] := '{}';
  v_val  text;
  v_ref  record;
  v_chk  text;
  v_first text;
  v_txt  boolean;
begin
  for r in
    select a.attname as col, format_type(a.atttypid, a.atttypmod) as typ, t.typtype, t.typname,
           a.attnotnull as notnull, (ad.adbin is not null) as hasdef, a.attgenerated, a.attidentity,
           a.attnum, t.typcategory
    from pg_attribute a
    join pg_type t on t.oid = a.atttypid
    left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where a.attrelid = ('public.' || quote_ident(p_tbl))::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attnum
  loop
    v_val := null;
    continue when r.attgenerated <> '' or r.attidentity <> '';
    v_txt := r.typname in ('text','varchar','bpchar','citext');

    if r.col = 'org_id' then
      v_val := quote_literal(p_org) || '::uuid';
    else
      -- single-column or composite FK containing this column
      select frel.relname as ftbl,
             (select att2.attname from pg_attribute att2
               where att2.attrelid = c.confrelid
                 and att2.attnum = c.confkey[array_position(c.conkey, r.attnum)]) as fcol,
             exists (select 1 from pg_attribute o where o.attrelid = c.confrelid and o.attname = 'org_id' and not o.attisdropped) as f_has_org,
             fns.nspname as fns
        into v_ref
      from pg_constraint c
      join pg_class frel on frel.oid = c.confrelid
      join pg_namespace fns on fns.oid = frel.relnamespace
      where c.contype = 'f' and c.conrelid = ('public.' || quote_ident(p_tbl))::regclass
        and r.attnum = any (c.conkey)
      order by array_length(c.conkey, 1) desc
      limit 1;

      if found then
        if v_ref.ftbl = 'users' then
          v_val := quote_literal(p_usr) || '::uuid';
        elsif v_ref.ftbl = 'organizations' then
          v_val := quote_literal(p_org) || '::uuid';
        elsif v_ref.fns = 'public' and v_ref.f_has_org then
          execute format('select %I::text from public.%I where org_id = $1 limit 1', v_ref.fcol, v_ref.ftbl)
            into v_val using p_org;
          if v_val is null then
            if r.notnull then return 'WAIT:' || v_ref.ftbl; end if;
            continue;
          end if;
          v_val := quote_literal(v_val);
        else
          if r.notnull and not r.hasdef then return 'SKIP:fk-to-' || v_ref.ftbl; end if;
          continue;
        end if;
      else
        -- CHECK col = ANY (ARRAY['a', ...])
        select pg_get_constraintdef(c.oid) into v_chk
        from pg_constraint c
        where c.contype = 'c' and c.conrelid = ('public.' || quote_ident(p_tbl))::regclass
          and pg_get_constraintdef(c.oid) ~ ('\(?' || r.col || '\)? = ANY \(\(?ARRAY\[')
        limit 1;
        v_first := null;
        if v_chk is not null then
          v_first := substring(v_chk from (r.col || '\)? = ANY \(\(?ARRAY\[''([^'']*)'''));
        end if;

        if v_first is not null then
          v_val := quote_literal(v_first);
        elsif r.typtype = 'e' then
          select quote_literal(e.enumlabel) into v_val from pg_enum e
            where e.enumtypid = (select atttypid from pg_attribute where attrelid = ('public.'||quote_ident(p_tbl))::regclass and attname = r.col)
            order by e.enumsortorder limit 1;
        elsif v_txt then
          if p_all or (r.notnull and not r.hasdef) then
            if r.col ~* '(email)' then v_val := quote_literal(p_email);
            elsif r.col ~* '(phone|mobile|tel|fax|msisdn|wa_id|e164|number_e)' then v_val := quote_literal(p_phone);
            elsif r.col ~* '(slug|key|code|ref|reference|token|hash)$' then
              v_val := quote_literal(lower(regexp_replace(p_name, '[^a-zA-Z0-9]', '', 'g')) || '-' || substr(md5(random()::text), 1, 8));
            else v_val := quote_literal(p_name || ' ' || r.col);
            end if;
          end if;
        elsif r.typname = 'jsonb' then
          if p_all or (r.notnull and not r.hasdef) then
            v_val := quote_literal(jsonb_build_object('name', p_name, 'email', p_email, 'phone', p_phone)::text) || '::jsonb';
          end if;
        elsif r.notnull and not r.hasdef then
          v_val := case
            when r.typname = 'uuid' then 'gen_random_uuid()'
            when r.typname in ('int2','int4','int8','numeric','float4','float8') then '1'
            when r.typname = 'bool' then 'false'
            when r.typname = 'date' then 'current_date'
            when r.typname in ('timestamptz','timestamp') then 'now()'
            when r.typname = 'time' then '''09:00'''
            when r.typname = 'inet' then '''127.0.0.1'''
            when r.typname = 'bytea' then '''\x00'''
            when r.typcategory = 'A' then '''{}'''
            when r.typname = 'json' then '''{}'''
            when r.typname = 'interval' then '''1 hour'''
            else null end;
          if v_val is null then return 'SKIP:type-' || r.typname; end if;
        end if;
      end if;
    end if;

    if v_val is not null then
      v_cols := array_append(v_cols, quote_ident(r.col));
      v_vals := array_append(v_vals, v_val);
    end if;
  end loop;

  begin
    execute format('insert into public.%I (%s) values (%s)', p_tbl,
                   array_to_string(v_cols, ', '), array_to_string(v_vals, ', '));
  exception when others then
    return 'ERR:' || sqlstate || ':' || left(sqlerrm, 160);
  end;
  return 'OK';
end $f$;

create temp table if not exists _seed_report (tbl text primary key, outcome text, mode text);

-- psql does not interpolate :vars inside a dollar-quoted block; hand them over
-- as session settings instead.
select set_config('seed.org', :'org', false), set_config('seed.usr', :'usr', false),
       set_config('seed.mname', :'mname', false), set_config('seed.memail', :'memail', false),
       set_config('seed.mphone', :'mphone', false) \gset _ignored_

do $do$
declare
  v_org  uuid := current_setting('seed.org')::uuid;
  v_usr  uuid := current_setting('seed.usr')::uuid;
  v_n    text := current_setting('seed.mname');
  v_e    text := current_setting('seed.memail');
  v_p    text := current_setting('seed.mphone');
  v_tbls text[];
  v_tbl  text;
  v_out  text;
  v_pass int := 0;
  v_progress boolean;
begin
  select array_agg(c.relname order by c.relname) into v_tbls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
    and c.relname not in ('memberships');  -- fixture-owned
  loop
    v_pass := v_pass + 1;
    v_progress := false;
    foreach v_tbl in array v_tbls loop
      continue when exists (select 1 from _seed_report where tbl = v_tbl and outcome = 'OK');
      v_out := pg_temp.seed_table(v_tbl, v_org, v_usr, v_n, v_e, v_p, true);
      if v_out = 'OK' then
        insert into _seed_report values (v_tbl, 'OK', 'all-text') on conflict (tbl) do update set outcome = 'OK', mode = 'all-text';
        v_progress := true;
        continue;
      end if;
      if v_out like 'ERR:%' then
        v_out := pg_temp.seed_table(v_tbl, v_org, v_usr, v_n, v_e, v_p, false);
        if v_out = 'OK' then
          insert into _seed_report values (v_tbl, 'OK', 'required-only') on conflict (tbl) do update set outcome = 'OK', mode = 'required-only';
          v_progress := true;
          continue;
        end if;
      end if;
      insert into _seed_report values (v_tbl, v_out, null) on conflict (tbl) do update set outcome = excluded.outcome;
    end loop;
    exit when not v_progress or v_pass >= 12;
  end loop;
end $do$;

\echo == seed coverage ==
select count(*) filter (where outcome = 'OK') as seeded,
       count(*) filter (where outcome <> 'OK') as unseeded,
       count(*) as total from _seed_report;
\echo == unseeded tables ==
select tbl, outcome from _seed_report where outcome <> 'OK' order by tbl;
