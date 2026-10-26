-- Reports A6 — windowed dashboard/report aggregate scalars as DB-side grouped
-- aggregates (jobs-per-week + revenue-per-month).
--
-- WHY THIS EXISTS
-- ---------------
-- lib/reports/jobsPerWeek() and revenuePerMonth() each fetched EVERY matching row
-- for the whole window — all jobs scheduled in the last N weeks, all paid invoices
-- in the last N months — PAGED through fetchAllRows (so correct past the 1000-row
-- PostgREST cap), then grouped/counted/summed in TypeScript into a handful of
-- buckets (~8 weeks / ~12 months). The read scales with the org's row volume while
-- the output is a tiny fixed-size bucket list. This moves the `count … group by
-- week` / `sum(amount) … group by month` into SQL so PostgREST returns only the
-- bucket rows the chart renders — the same shape as reports_top_customers_by_revenue.
--
-- SEMANTICS — preserved EXACTLY from the TypeScript it replaces
-- ------------------------------------------------------------
-- Everything is computed in UTC, matching the TS (which used getUTC*/Date.UTC
-- throughout). The windows are day-1-normalised (first-of-month / Monday floors
-- happen BEFORE any month subtraction), so, like the fixed TS, they can never
-- overflow on a 29/30/31 `now` (the C48 class) and always yield exactly N distinct
-- buckets. Empty buckets are pre-filled to 0 (a flat period reads as 0, never a
-- gap). Each row is bucketed by the UTC week/month it falls in, so a timezone-edge
-- timestamp (e.g. 23:30Z on the last of a month vs 00:30Z on the first of the next)
-- lands in the same bucket the TS put it in.
--
--   jobsPerWeek:    week_start = date_trunc('week', scheduled_date) [ISO Monday];
--                   window = jobs with scheduled_date >= (today_utc - N*7 days);
--                   total = count, completed = count filter status='completed'.
--   revenuePerMonth: month = date_trunc('month', paid_at @ UTC); status='paid';
--                   paid_at >= first-of-(current_month - (N-1)); revenue = SUM of
--                   invoices.amount — EX-VAT net subtotal, NEVER the stored GROSS
--                   generated `total` (= amount + vat_total). Summing `total`
--                   overstated turnover by the VAT rate and disagreed with
--                   /insights + /dashboard (lib/intelligence/concentration.ts owns
--                   the rule). NULL amount contributes 0, exactly as Number(x ?? 0).
--
-- A row whose bucket falls outside the pre-filled window (older than the oldest
-- bucket, or in the future) is dropped by the series LEFT JOIN — identical to the
-- TS `if (!slot) continue;`.
--
-- SECURITY
-- --------
-- SECURITY DEFINER bypasses RLS, so each function is a member of the secdef-org-RPC
-- class that __tests__/integration/rls/secdef-org-rpc-guard.test.ts introspects. Each
-- MIRRORS the canonical guard (next_invoice_number / reports_top_customers_by_revenue
-- / the systemic fix in 20261116000000): the FIRST act authorises the caller against
-- p_org_id via public.current_org_ids() and raises 42501 for a non-member, so a
-- Data-API caller with the public anon key cannot read across the tenant boundary.
-- service_role (the report-delivery cron render path, which has no JWT) skips the
-- check exactly as the sibling RPCs do, and is STILL org-filtered by p_org_id inside.
-- The explicit `grant execute ... to authenticated` mirrors the sibling reports RPC
-- (guarded, not revoked — real members must still call it).

-- ── jobs per week ───────────────────────────────────────────────────────────
create or replace function public.reports_jobs_per_week(
  p_org_id uuid,
  p_weeks int default 8
)
returns table (
  week_start date,
  total bigint,
  completed bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today_monday date;
  v_since        date;
begin
  -- Canonical org-membership guard — MUST be the first act (SECURITY DEFINER
  -- bypasses RLS). A non-member calling via the Data API is refused with 42501
  -- before any row is read; service_role (cron/admin render) skips it and is
  -- org-filtered by p_org_id below.
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  -- Monday of the current UTC week (ISO week = Monday start), and the lower bound
  -- the TS used: today_utc - N*7 days (matches new Date(now - weeks*7d).slice(0,10)).
  v_today_monday := date_trunc('week', timezone('utc', now()))::date;
  v_since        := (timezone('utc', now()))::date - (p_weeks * 7);

  return query
  with series as (
    -- The N pre-filled Monday buckets, oldest first (the TS insertion order).
    select (v_today_monday - (g.i * 7))::date as wk
    from generate_series(0, p_weeks - 1) as g(i)
  ),
  counted as (
    select
      date_trunc('week', j.scheduled_date::timestamp)::date as wk,
      count(*)::bigint                                        as total,
      count(*) filter (where j.status = 'completed')::bigint  as completed
    from public.jobs j
    where j.org_id = p_org_id
      and j.scheduled_date is not null
      and j.scheduled_date >= v_since
    group by 1
  )
  select
    s.wk                        as week_start,
    coalesce(c.total, 0)::bigint     as total,
    coalesce(c.completed, 0)::bigint as completed
  from series s
  left join counted c on c.wk = s.wk
  order by s.wk asc;
end;
$$;

grant execute on function public.reports_jobs_per_week(uuid, int) to authenticated;

-- ── revenue per month ─────────────────────────────────────────────────────────
create or replace function public.reports_revenue_per_month(
  p_org_id uuid,
  p_months int default 12
)
returns table (
  month   date,
  revenue numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_current_month timestamp;    -- first of the current UTC month (wall-clock UTC)
  v_since         timestamptz;  -- first of the oldest window month, as a UTC instant
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  -- Day-1-normalised window (floor to first-of-month BEFORE subtracting months) so
  -- it can never overflow on a 29/30/31 now — the C48 guarantee, now in SQL.
  v_current_month := date_trunc('month', timezone('utc', now()));
  v_since         := (v_current_month - make_interval(months => p_months - 1)) at time zone 'utc';

  return query
  with series as (
    -- The N pre-filled first-of-month buckets, oldest first.
    select (v_current_month - make_interval(months => g.i))::date as m
    from generate_series(0, p_months - 1) as g(i)
  ),
  summed as (
    select
      date_trunc('month', timezone('utc', i.paid_at))::date as m,
      -- EX-VAT net subtotal, never the gross generated `total`. NULL => 0.
      sum(i.amount)::numeric                                 as revenue
    from public.invoices i
    where i.org_id = p_org_id
      and i.status = 'paid'
      and i.paid_at >= v_since
    group by 1
  )
  select
    s.m                           as month,
    coalesce(x.revenue, 0)::numeric as revenue
  from series s
  left join summed x on x.m = s.m
  order by s.m asc;
end;
$$;

grant execute on function public.reports_revenue_per_month(uuid, int) to authenticated;
