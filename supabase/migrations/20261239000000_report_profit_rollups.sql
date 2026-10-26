-- ─────────────────────────────────────────────────────────────────────────────
-- R8 · Profit report labour + COGS pre-rollups (org-guarded SECURITY DEFINER)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The profit report (/reports/profit) is the heaviest and highest-risk report:
-- it drives per-job and org-wide PROFIT and MARGIN. Two of its reads were
-- UNBOUNDED whole-history scans that aggregated in TypeScript:
--
--   1. time_entries — EVERY clock entry the org has ever recorded
--      (lib/reports/report-data.ts), folded into lifetime labour hours per
--      (job, user) by lib/time/compute.entryHours + job-cost-input.buildLabourSlices.
--   2. stock_movements — the WHOLE movement ledger
--      (server/services/stock.loadStockCogsCostRows → listStockMovements),
--      folded into weighted-average COGS per job by
--      lib/stock/valuation.stockCogsByJob/buildStockCogsCostRows.
--
-- Both grow without bound and scale with tenant age, not with what the report
-- shows. This migration moves ONLY THE AGGREGATION the profit report needs into
-- two org-guarded SECURITY DEFINER rollup RPCs, so the report fetches a small
-- per-(job,user) / per-job result instead of the whole history. The arithmetic
-- is replicated BYTE-FAITHFULLY to the existing TypeScript (see the per-function
-- notes); an integration test asserts snapshot-equality of every margin figure.
--
-- SCOPE: these RPCs are consumed by the profit report path only. The dashboard,
-- the per-job pages, CVR/variance and company-health keep their existing TS fold
-- (loadStockCogsCostRows / buildJobCostInput(timeEntries)) and are unchanged.
--
-- SECURITY (the canonical org-RPC guard — next_invoice_number / next_po_number
-- pattern, enforced by __tests__/integration/rls/secdef-org-rpc-guard.test.ts):
--   · SECURITY DEFINER + `set search_path = public`.
--   · First statement raises 42501 unless the caller is a member of the org arg
--     (service_role bypasses, exactly as the app's admin/cron path needs).
--   · Explicit `grant execute ... to authenticated` (no anon grant — anon's
--     current_org_ids() is empty, so the guard denies it 42501). No new table,
--     so no Data-API table grant is involved.
--   · Each function filters strictly by the org argument and returns only that
--     org's rollups.
--
-- ADDITIVE / FORWARD-ONLY. Creates two functions; no table, column, policy or
-- data change. Safe to replay.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. report_profit_labour_hours(p_org, p_now)
--    Lifetime labour hours per (job_id, user_id) for the org — the SQL image of
--    buildLabourSlices(timeEntries, lifetimeHoursSource(now)).
--
--    FAITHFUL REPRODUCTION of lib/time/compute.entryHours, per entry:
--      start_ms = floor(epoch_ms(started_at))                 -- JS getTime() truncates sub-ms
--      end_ms   = floor(epoch_ms(coalesce(ended_at, now)))    -- open entries count to now
--      if end_ms <= start_ms            -> 0 hours             -- entryHours guard
--      break_ms = Σ over breaks of (end_ms_b - start_ms_b),    -- totalBreakMs
--                 an open break (ended_at null) counting to now,
--                 skipping any break whose end_ms_b <= start_ms_b
--      net_ms   = greatest(0, (end_ms - start_ms) - break_ms)  -- max(0, gross - break)
--      hours    = Math.round((net_ms/3_600_000)*100)/100       -- 2dp hours
--
--    THE 2dp ROUNDING IS DONE IN float8 ON PURPOSE. entryHours uses JS
--    `Math.round((netMs/3600000)*100)/100`, an IEEE-754 double computation.
--    Postgres `double precision` IS IEEE-754 double, so computing
--    `floor((net_ms::float8/3600000.0*100.0)+0.5)` reproduces Math.round
--    bit-for-bit for net_ms >= 0 (ties round toward +Inf in both). A numeric
--    round would instead diverge from JS at values such as net_ms = 54000
--    (0.015 h), where the double lands at 1.4999999999999998 and JS rounds DOWN
--    to 0.01 — so float8 here is the faithful choice, not laxity. The integer
--    hundredths are then taken to numeric and summed per group in NUMERIC, so a
--    group total is an exact 2dp decimal (JS sums the same per-entry 2dp values
--    in float; the two agree to full 2dp precision).
--
--    Hours are summed PER ENTRY THEN per group (not over the summed span),
--    exactly as lifetimeHoursSource does — summing rounded-per-entry values, not
--    rounding the summed value. Groups with no job (job_id null) are dropped
--    (overhead, no direct job cost); groups that net to <= 0 hours are dropped.
--
--    ONE STATED DEVIATION: a break object with a malformed/unparseable
--    started_at/ended_at would make this RPC RAISE (cast error) where the TS
--    `NaN` guard silently skips it. Breaks are only ever written by the app as
--    `new Date().toISOString()`, so this cannot arise for real data; a raise is
--    a LOUD failure (never a silent miscount), which is the safer posture.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.report_profit_labour_hours(
  p_org uuid,
  p_now timestamptz default now()
)
returns table (job_id uuid, user_id uuid, hours numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Canonical org-membership guard (service_role bypasses for the delivery cron,
  -- which renders a report for an org it holds no JWT for). anon's
  -- current_org_ids() is empty, so anon is denied 42501.
  if auth.role() is distinct from 'service_role'
     and p_org not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  return query
  with entries as (
    select
      te.job_id as e_job_id,
      te.user_id as e_user_id,
      floor(extract(epoch from te.started_at) * 1000)::bigint as start_ms,
      floor(extract(epoch from coalesce(te.ended_at, p_now)) * 1000)::bigint as end_ms,
      coalesce(te.breaks, '[]'::jsonb) as breaks
    from public.time_entries te
    where te.org_id = p_org
      and te.job_id is not null
  ),
  with_breaks as (
    select
      e.e_job_id,
      e.e_user_id,
      e.start_ms,
      e.end_ms,
      coalesce((
        select sum(
          floor(extract(epoch from coalesce((b->>'ended_at')::timestamptz, p_now)) * 1000)::bigint
          - floor(extract(epoch from (b->>'started_at')::timestamptz) * 1000)::bigint
        )
        from jsonb_array_elements(e.breaks) as b
        where (b->>'started_at') is not null
          and floor(extract(epoch from coalesce((b->>'ended_at')::timestamptz, p_now)) * 1000)::bigint
              > floor(extract(epoch from (b->>'started_at')::timestamptz) * 1000)::bigint
      ), 0)::bigint as break_ms
    from entries e
  ),
  per_entry as (
    select
      wb.e_job_id,
      wb.e_user_id,
      case
        when wb.end_ms <= wb.start_ms then 0::numeric
        else
          -- Math.round((net_ms/3600000)*100)/100 reproduced in IEEE-754 double,
          -- then taken to an exact 2dp numeric.
          floor(
            ((greatest(0::bigint, (wb.end_ms - wb.start_ms) - wb.break_ms))::float8
              / 3600000.0 * 100.0) + 0.5
          )::numeric / 100
      end as entry_hours
    from with_breaks wb
  )
  select
    pe.e_job_id as job_id,
    pe.e_user_id as user_id,
    sum(pe.entry_hours) as hours
  from per_entry pe
  group by pe.e_job_id, pe.e_user_id
  having sum(pe.entry_hours) > 0;
end;
$$;

grant execute on function public.report_profit_labour_hours(uuid, timestamptz) to authenticated;

comment on function public.report_profit_labour_hours(uuid, timestamptz) is
  'R8: lifetime labour hours per (job,user) for an org — SQL image of '
  'buildLabourSlices(time_entries, lifetimeHoursSource(now)). Org-guarded '
  '(current_org_ids + 42501; service_role bypasses). Replaces the profit '
  'report''s unbounded whole-history time_entries read.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. report_profit_stock_cogs(p_org)
--    Weighted-average COGS of stock ISSUED to each job, NET OF CORRECTIONS — the
--    SQL image of lib/stock/valuation.stockCogsByJob + buildStockCogsCostRows
--    over the whole movement ledger.
--
--    FAITHFUL REPRODUCTION of stockCogsByJob:
--      · Only `issue` movements that name a job contribute COGS; the cost is the
--        MAGNITUDE of the movement's frozen `cost_effect` (an issue's cost_effect
--        is a negative release; job COGS is abs()). `cost_effect` is
--        numeric(14,2) — already 2dp — so abs(cost_effect) == abs(round2(toPounds(cost_effect))).
--        Uncosted issues (cost_effect null) contribute nothing, but still register
--        their (id -> job_id) so a correction of them can find the job (jobByIssueId).
--      · A `correction` names the issue it reverses via corrects_movement_id and is
--        itself JOB-LESS; it BACKS OUT abs(cost_effect) from the corrected issue's
--        job. Only corrections of an issue that named a job apply; costed corrections
--        only.
--      · A job that nets to exactly 0 (issue fully corrected) is dropped — matching
--        buildStockCogsCostRows (`amount !== 0`). A negative net (a costed correction
--        of an uncosted issue) is kept, exactly as the TS keeps it.
--    Movement types other than issue/correction (receipt, transfer_*, adjustment_*)
--    are excluded, exactly as the TS ignores them.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.report_profit_stock_cogs(p_org uuid)
returns table (job_id uuid, amount numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role'
     and p_org not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  return query
  with job_issues as (
    -- Every issue that names a job (costed OR not) — the TS jobByIssueId map.
    select sm.id as issue_id, sm.job_id as issue_job_id, sm.cost_effect
    from public.stock_movements sm
    where sm.org_id = p_org
      and sm.movement_type = 'issue'
      and sm.job_id is not null
  ),
  issue_cogs as (
    select ji.issue_job_id as j, sum(abs(ji.cost_effect)) as amt
    from job_issues ji
    where ji.cost_effect is not null
    group by ji.issue_job_id
  ),
  correction_cogs as (
    select ji.issue_job_id as j, sum(abs(c.cost_effect)) as amt
    from public.stock_movements c
    join job_issues ji on ji.issue_id = c.corrects_movement_id
    where c.org_id = p_org
      and c.movement_type = 'correction'
      and c.corrects_movement_id is not null
      and c.cost_effect is not null
    group by ji.issue_job_id
  ),
  net as (
    select
      coalesce(i.j, k.j) as j,
      coalesce(i.amt, 0) - coalesce(k.amt, 0) as amt
    from issue_cogs i
    full outer join correction_cogs k on k.j = i.j
  )
  select n.j as job_id, n.amt as amount
  from net n
  where n.amt <> 0
  order by n.j;
end;
$$;

grant execute on function public.report_profit_stock_cogs(uuid) to authenticated;

comment on function public.report_profit_stock_cogs(uuid) is
  'R8: weighted-average stock COGS per job (net of corrections) for an org — SQL '
  'image of stockCogsByJob/buildStockCogsCostRows. Org-guarded (current_org_ids '
  '+ 42501; service_role bypasses). Replaces the profit report''s unbounded '
  'whole-ledger stock_movements read.';
