-- prune_cron_runs: make the daily retention pass immune to the role statement_timeout.
--
-- DEFECT (found 2026-10-31 in prod): cron-runs-prune reported ok=false on most
-- days with a NULL error. Root cause: the function runs as one transaction and
-- the batched delete of up to p_max_rows (50k) rows exceeds the 8s statement_
-- timeout that PostgREST binds via the `authenticator` role, so the whole pass
-- times out and ROLLS BACK -> zero rows pruned -> cron_runs grew unbounded
-- (177k rows / 35k past the 14-day horizon at time of fix). service_role itself
-- has no timeout, but the function must not depend on the caller's setting.
--
-- FIX: pin a generous statement_timeout on the function itself (SECURITY DEFINER
-- SET applies for the function's scope only). 55s stays under the route's
-- maxDuration=60 (app/api/cron/cron-runs-prune/route.ts). Body is otherwise
-- byte-identical to 20261213000000 — still batched (5k), still bounded by
-- p_max_rows, still refuses an unsafe horizon. Purely additive (CREATE OR REPLACE).
--
-- ROLLBACK: CREATE OR REPLACE from 20261213000000 (drop the statement_timeout line).

create or replace function public.prune_cron_runs(
  p_success_days integer default 14,
  p_failure_days integer default 90,
  p_max_rows     integer default 50000
)
returns table (deleted_success bigint, deleted_failure bigint)
language plpgsql
security definer
set search_path = public, pg_catalog
set statement_timeout = '55s'
as $$
declare
  v_batch  constant integer := 5000;
  v_succ   bigint := 0;
  v_fail   bigint := 0;
  v_n      integer;
begin
  -- Structural guard: ops-snapshot reads a 7-day window. Anything below 8 days
  -- would silently blank the per-route health tiles.
  if p_success_days is null or p_success_days < 8 then
    raise exception
      'prune_cron_runs: p_success_days must be >= 8 (ops-snapshot reads a 7-day window), got %',
      p_success_days;
  end if;

  -- A failure must never be discarded before a success of the same age.
  if p_failure_days is null or p_failure_days < p_success_days then
    raise exception
      'prune_cron_runs: p_failure_days (%) must be >= p_success_days (%)',
      p_failure_days, p_success_days;
  end if;

  if p_max_rows is null or p_max_rows < 1 then
    raise exception 'prune_cron_runs: p_max_rows must be >= 1, got %', p_max_rows;
  end if;

  -- (1) Successful runs past the health window.
  loop
    exit when (v_succ + v_fail) >= p_max_rows;
    delete from public.cron_runs
     where ctid in (
       select ctid
         from public.cron_runs
        where ok is true
          and started_at < now() - make_interval(days => p_success_days)
        limit least(v_batch, p_max_rows - (v_succ + v_fail))
     );
    get diagnostics v_n = row_count;
    v_succ := v_succ + v_n;
    exit when v_n = 0;
  end loop;

  -- (2) Failures and never-completed runs, kept far longer for diagnosis.
  loop
    exit when (v_succ + v_fail) >= p_max_rows;
    delete from public.cron_runs
     where ctid in (
       select ctid
         from public.cron_runs
        where (ok is false or ok is null)
          and started_at < now() - make_interval(days => p_failure_days)
        limit least(v_batch, p_max_rows - (v_succ + v_fail))
     );
    get diagnostics v_n = row_count;
    v_fail := v_fail + v_n;
    exit when v_n = 0;
  end loop;

  deleted_success := v_succ;
  deleted_failure := v_fail;
  return next;
end;
$$;
