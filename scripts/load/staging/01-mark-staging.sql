-- scripts/load/staging/01-mark-staging.sql — mark a DISPOSABLE staging database
-- as a load-test environment. This is the database-side half of the two-key
-- interlock in scripts/load/_guard.mjs (the other key is LOAD_STAGING_REF).
--
-- Run ONLY against the dedicated load-test staging project, by a human, once,
-- after the founder has approved that project (docs/engineering/STAGING-AND-LOAD-PLAN.md):
--
--   psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -v staging_ref=<staging-project-ref> \
--        -f scripts/load/staging/01-mark-staging.sql
--
-- It refuses (raises, writes nothing) when:
--   * staging_ref is missing, malformed, or is the production project ref;
--   * the database holds ANY organisation that is not a synthetic `lt-%` tenant
--     (i.e. it is not a fresh, synthetic-only project — production always fails here).
-- The marker table carries no client grant (service-role / postgres only).
-- This is NOT a migration: it must never ship in supabase/migrations.

\set ON_ERROR_STOP on
select set_config('loadtest.staging_ref', :'staging_ref', false);

do $mark$
declare
  v_ref text := current_setting('loadtest.staging_ref', true);
  v_foreign bigint;
begin
  if v_ref is null or v_ref !~ '^[a-z0-9]{8,40}$' then
    raise exception 'mark-staging: pass -v staging_ref=<bare staging project ref>';
  end if;
  if v_ref = 'jzntbskdqdopzwdqwvkp' then
    raise exception 'mark-staging: REFUSED — that is the PRODUCTION project ref';
  end if;
  if to_regclass('public.organizations') is not null then
    execute 'select count(*) from public.organizations where slug not like ''lt-%''' into v_foreign;
    if v_foreign > 0 then
      raise exception 'mark-staging: REFUSED — % non-synthetic organisation(s) present; a load-test staging database must be synthetic-only', v_foreign;
    end if;
  end if;

  create table if not exists public.loadtest_environment (
    id            smallint primary key default 1 check (id = 1),
    staging_ref   text not null,
    is_disposable boolean not null default true,
    marked_at     timestamptz not null default now(),
    marked_by     text not null default current_user
  );
  revoke all on table public.loadtest_environment from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.loadtest_environment from anon, authenticated';
  end if;
  insert into public.loadtest_environment (staging_ref) values (v_ref)
  on conflict (id) do update set staging_ref = excluded.staging_ref, marked_at = now();
end
$mark$;

select 'marked as disposable load-test environment: ' || staging_ref from public.loadtest_environment;
