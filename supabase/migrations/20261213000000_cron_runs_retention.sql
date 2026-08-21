-- Ops telemetry retention — bound the growth of `public.cron_runs`.
--
-- WHY. `cron_runs` (20260619000000) records one row per cron invocation and has
-- never been pruned. At the time of writing it held ~400,000 rows / 169 MB —
-- roughly 70% of the entire 240 MB production database — growing ~12,000
-- rows/day and accelerating as more schedules were registered. The table is
-- OPERATIONAL TELEMETRY, explicitly not audit, financial or statutory evidence
-- (see its own header: it powers the /admin/ops "last successful job" tile and a
-- recent-failures list). Nothing in the codebase treats it as a record of
-- account, so retaining it forever buys nothing and costs storage, backup
-- volume and PITR WAL indefinitely.
--
-- THE ONE HARD CONSTRAINT. `server/services/ops-snapshot.ts` computes per-route
-- health over a SEVEN-DAY lookback (`.gte("started_at", sevenDaysAgo)`), and
-- `server/services/hq-monitoring-runner.ts` reads the most recent 200 rows to
-- decide whether it can make a health claim at all — with zero rows it reports
-- `insufficient`, i.e. monitoring goes blind. Retention must therefore never
-- cut into that window. The function REFUSES a success horizon under 8 days, so
-- a future caller cannot silently shrink the window below what ops reads: the
-- unsafe configuration is unrepresentable rather than merely discouraged.
--
-- ASYMMETRIC BY DESIGN. A successful no-op run is noise the moment it leaves the
-- health window; a FAILURE is the diagnostic record you actually want months
-- later when asking "when did this route start breaking?". So failures (and
-- rows whose outcome was never recorded — a crashed run) are kept far longer
-- than successes. Defaults: successes 14 days (2x the ops contract), failures
-- 90 days.
--
-- BATCHED, NEVER BLOCKING. Deletes run in bounded ctid batches with a total
-- per-invocation ceiling, so this can never become the giant blocking DELETE
-- that takes a lock long enough to stall the per-minute crons writing into the
-- same table. Catch-up is spread across runs instead.
--
-- Service-role only, matching the table (RLS on, no policies).

create or replace function public.prune_cron_runs(
  p_success_days integer default 14,
  p_failure_days integer default 90,
  p_max_rows     integer default 50000
)
returns table (deleted_success bigint, deleted_failure bigint)
language plpgsql
security definer
set search_path = public, pg_catalog
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

comment on function public.prune_cron_runs(integer, integer, integer) is
  'Bounded, batched retention pass over public.cron_runs. Successes older than p_success_days (>= 8, enforced) and failures older than p_failure_days are deleted in ctid batches, capped at p_max_rows per invocation. Operational telemetry only — cron_runs is not audit or statutory evidence. Service-role only.';

-- Service-role only, matching the table. The default PUBLIC execute grant on a
-- SECURITY DEFINER function would otherwise expose a privileged delete to every
-- anon/authenticated caller through PostgREST.
revoke all on function public.prune_cron_runs(integer, integer, integer)
  from public, anon, authenticated;

-- Supports the (ok, started_at) predicate both loops scan. The existing
-- cron_runs_ok_started_idx already covers this exactly; no new index needed.
