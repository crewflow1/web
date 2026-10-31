-- ============================================================================
-- R5 Phase 4 (slice 3) — report RPCs: add the is_org_admin guard (indirect-leak).
-- ============================================================================
-- Six SECURITY DEFINER report RPCs guarded only on org-MEMBERSHIP, not admin.
-- Because they are SECURITY DEFINER (RLS bypassed) and EXECUTE is granted to
-- `authenticated`, a non-admin staff JWT could call them via POST /rest/v1/rpc
-- and read profit / revenue / COGS / aged receivables / per-worker hours — the
-- app only gates the /reports PAGES (client redirect), not the RPCs. Once R5
-- Phase 3/4 narrows the base tables this re-opens exactly what was closed, and
-- report_profit_labour_hours already leaks every worker's hours (breaks Phase 5)
-- regardless. Fix mirrors the correct sibling report_aged_payables: the same
-- canonical membership guard PLUS `and not is_org_admin(<org>)` → 42501.
-- Bodies are reproduced verbatim from pg_get_functiondef with only the guard
-- added (CREATE OR REPLACE; no logic change). secdef-org-rpc guard still passes.
-- ROLLBACK: CREATE OR REPLACE each without the admin clause (prior definition).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.report_profit_labour_hours(p_org uuid, p_now timestamp with time zone DEFAULT now())
 RETURNS TABLE(job_id uuid, user_id uuid, hours numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Canonical org-membership guard (service_role bypasses for the delivery cron,
  -- which renders a report for an org it holds no JWT for). anon's
  -- current_org_ids() is empty, so anon is denied 42501.
  if auth.role() is distinct from 'service_role'
     and p_org not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  -- R5 Phase 4: reports are owner/admin only. Staff are denied even
  -- though this SECURITY DEFINER RPC bypasses RLS and the app page gate
  -- is client-side only (a staff JWT could POST /rest/v1/rpc directly).
  if auth.role() is distinct from 'service_role' and not public.is_org_admin(p_org) then
    raise exception 'Forbidden: reports are owner/admin only' using errcode = '42501';
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
$function$;

CREATE OR REPLACE FUNCTION public.report_profit_stock_cogs(p_org uuid)
 RETURNS TABLE(job_id uuid, amount numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.role() is distinct from 'service_role'
     and p_org not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  -- R5 Phase 4: reports are owner/admin only. Staff are denied even
  -- though this SECURITY DEFINER RPC bypasses RLS and the app page gate
  -- is client-side only (a staff JWT could POST /rest/v1/rpc directly).
  if auth.role() is distinct from 'service_role' and not public.is_org_admin(p_org) then
    raise exception 'Forbidden: reports are owner/admin only' using errcode = '42501';
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
$function$;

CREATE OR REPLACE FUNCTION public.report_aged_receivables(p_org_id uuid, p_as_at date)
 RETURNS TABLE(invoice_id uuid, reference text, status text, due_date date, party_id uuid, party_name text, remaining numeric, age_days integer, bucket text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Canonical membership guard (current_org_ids + 42501).
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  -- R5 Phase 4: reports are owner/admin only. Staff are denied even
  -- though this SECURITY DEFINER RPC bypasses RLS and the app page gate
  -- is client-side only (a staff JWT could POST /rest/v1/rpc directly).
  if auth.role() is distinct from 'service_role' and not public.is_org_admin(p_org_id) then
    raise exception 'Forbidden: reports are owner/admin only' using errcode = '42501';
  end if;

  return query
  with paid as (
    -- Per-invoice Σ payments, org-pinned. round(.,2): invoice_payments.amount is
    -- numeric(12,2), so this equals the TS round2-fold to the penny.
    select ip.invoice_id as inv_id,
           round(coalesce(sum(ip.amount), 0)::numeric, 2) as paid_sum
      from public.invoice_payments ip
     where ip.org_id = p_org_id
     group by ip.invoice_id
  ),
  base as (
    select i.id as inv_id,
           i.number as ref,
           -- invoices.status is the `invoice_status` enum; the RETURNS TABLE
           -- column is text, so cast explicitly or PostgREST/plpgsql raises
           -- 42804 "structure of query does not match function result type".
           i.status::text as status,
           i.due_date as due_date,
           coalesce(i.customer_id, j.customer_id) as party_id,
           c.name as party_name,
           -- invoiceRemaining: round2(max(0, total - round2(Σ payments))).
           round(greatest(0::numeric, i.total - coalesce(p.paid_sum, 0))::numeric, 2) as remaining,
           -- invoiceDaysOverdue: null unless overdue (collectable already; due
           -- date present; strictly before the as-at day).
           case
             when i.due_date is not null and i.due_date < p_as_at
               then (p_as_at - i.due_date)
             else null
           end as age_days
      from public.invoices i
      left join paid p on p.inv_id = i.id
      left join public.jobs j on j.id = i.job_id and j.org_id = i.org_id
      left join public.customers c
        on c.id = coalesce(i.customer_id, j.customer_id) and c.org_id = i.org_id
     where i.org_id = p_org_id
       -- isCollectableStatus (OVERDUE_COLLECTABLE_STATUSES). Mirrored here for
       -- the SQL pre-filter; the TS authority remains the source of truth and
       -- the integration test pins this set to it.
       and i.status in ('sent', 'awaiting_payment', 'partially_paid', 'overdue')
  )
  select b.inv_id,
         b.ref,
         b.status,
         b.due_date,
         b.party_id,
         b.party_name,
         b.remaining,
         b.age_days::integer,
         case
           when b.age_days is null then 'current'
           when b.age_days <= 0   then 'current'
           when b.age_days <= 30  then 'd1_30'
           when b.age_days <= 60  then 'd31_60'
           when b.age_days <= 90  then 'd61_90'
           else 'd91_plus'
         end as bucket
    from base b
   -- buildAgeingLedger drops non-positive amounts; exclude settled here so the
   -- whole settled tail never crosses the wire.
   where b.remaining > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reports_revenue_per_month(p_org_id uuid, p_months integer DEFAULT 12)
 RETURNS TABLE(month date, revenue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_current_month timestamp;    -- first of the current UTC month (wall-clock UTC)
  v_since         timestamptz;  -- first of the oldest window month, as a UTC instant
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  -- R5 Phase 4: reports are owner/admin only. Staff are denied even
  -- though this SECURITY DEFINER RPC bypasses RLS and the app page gate
  -- is client-side only (a staff JWT could POST /rest/v1/rpc directly).
  if auth.role() is distinct from 'service_role' and not public.is_org_admin(p_org_id) then
    raise exception 'Forbidden: reports are owner/admin only' using errcode = '42501';
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
$function$;

CREATE OR REPLACE FUNCTION public.reports_top_customers_by_revenue(p_org_id uuid, p_limit integer DEFAULT 10)
 RETURNS TABLE(customer_id uuid, name text, revenue numeric, invoice_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Canonical org-membership guard — MUST be the first act (SECURITY DEFINER
  -- bypasses RLS). A non-member calling via the Data API is refused with 42501
  -- before any row is read; service_role (cron/admin render) skips it and is
  -- org-filtered by p_org_id below.
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  -- R5 Phase 4: reports are owner/admin only. Staff are denied even
  -- though this SECURITY DEFINER RPC bypasses RLS and the app page gate
  -- is client-side only (a staff JWT could POST /rest/v1/rpc directly).
  if auth.role() is distinct from 'service_role' and not public.is_org_admin(p_org_id) then
    raise exception 'Forbidden: reports are owner/admin only' using errcode = '42501';
  end if;

  return query
  with paid as (
    -- customer_id FIRST, quote->customer as fallback, NULL => Unattributed.
    -- The quote is joined org-pinned so a (defensively) cross-org quote_id can
    -- never contribute a foreign customer id.
    select
      coalesce(i.customer_id, q.customer_id) as resolved_id,
      i.amount                                as amount
    from public.invoices i
    left join public.quotes q
      on q.id = i.quote_id
     and q.org_id = p_org_id
    where i.org_id = p_org_id
      and i.status = 'paid'
  )
  select
    p.resolved_id                     as customer_id,
    coalesce(c.name, '—')             as name,
    coalesce(sum(p.amount), 0)::numeric as revenue,
    count(*)::bigint                  as invoice_count
  from paid p
  left join public.customers c
    on c.id = p.resolved_id
   and c.org_id = p_org_id
  group by p.resolved_id, c.name
  -- Deterministic ranking: revenue desc, then a stable tiebreak so a tie that
  -- straddles the N boundary resolves the same way every call (the old JS sort
  -- was stable but tie order was incidental; this makes it explicit).
  order by revenue desc, invoice_count desc, name asc, p.resolved_id asc nulls last
  limit greatest(coalesce(p_limit, 10), 0);
end;
$function$;

CREATE OR REPLACE FUNCTION public.reports_jobs_per_week(p_org_id uuid, p_weeks integer DEFAULT 8)
 RETURNS TABLE(week_start date, total bigint, completed bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- R5 Phase 4: reports are owner/admin only. Staff are denied even
  -- though this SECURITY DEFINER RPC bypasses RLS and the app page gate
  -- is client-side only (a staff JWT could POST /rest/v1/rpc directly).
  if auth.role() is distinct from 'service_role' and not public.is_org_admin(p_org_id) then
    raise exception 'Forbidden: reports are owner/admin only' using errcode = '42501';
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
$function$;
