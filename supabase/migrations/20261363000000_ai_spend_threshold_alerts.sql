-- 20261363000000 — AI spend threshold alerts: tell HQ once per threshold per month.
--
-- WHY: the warn_50 / warn_80 / blocked states only rendered on /admin/ai-costs,
-- so HQ learned an org (or the whole of CrewFlow) had run out of AI budget only
-- by opening that page. This adds the idempotency record for an HQ notification
-- when an org's monthly ceiling, or the CrewFlow-wide ceiling (20261358000000),
-- crosses 80% and 100%.
--
-- EXACTLY ONCE: a mark is the right to notify. ai_claim_spend_alerts inserts the
-- crossed thresholds with ON CONFLICT DO NOTHING against the unique indexes
-- below and returns ONLY the rows it inserted, so of any number of concurrent
-- callers exactly one receives a given (month, scope, org, threshold) and only
-- that caller notifies. The month is the Europe/London budget month, identical
-- to ai_reserve_invocation.
--
-- THRESHOLDS (committed spend from the immutable ledger, ai_invocations):
--   80  — committed >= 80% of the ceiling.
--   100 — committed >= the ceiling, OR the caller saw a reservation refused by
--         that ceiling (p_refused). The reservation refuses a call that would
--         cross the ceiling, so committed spend usually stops just short of it:
--         the refusal IS the "limit reached" event. Reaching 100 also claims 80
--         so a stale 80% notice can never arrive after a 100% one.
--   A ceiling <= 0 (AI deliberately switched off) raises nothing.
--
-- COST: the caller (lib/ai/governor/spend-alerts.ts) only calls this when the
-- org is already near its ceiling, after a refusal, or at most once a minute per
-- server instance for the platform. Inside, a PK-indexed probe returns early
-- once this month's marks exist; otherwise two indexed SUMs, the same ones the
-- reservation already runs. No provider call, no lock.
--
-- Service-role only: no client grant, no policy.
--
-- Rollback: drop function ai_claim_spend_alerts(uuid, integer, text); drop table
-- ai_spend_alert_marks. Nothing else reads either.

begin;

create table if not exists public.ai_spend_alert_marks (
  id            uuid primary key default gen_random_uuid(),
  month_start   date not null,
  scope         text not null check (scope in ('org', 'platform')),
  org_id        uuid references public.organizations(id) on delete cascade,
  threshold     smallint not null check (threshold in (80, 100)),
  spent_pence   bigint not null check (spent_pence >= 0),
  ceiling_pence integer not null check (ceiling_pence > 0),
  created_at    timestamptz not null default now(),
  constraint ai_spend_alert_marks_scope_org check ((scope = 'org') = (org_id is not null))
);

comment on table public.ai_spend_alert_marks is
  'One row per (Europe/London month, scope, org, threshold) HQ has been told about. Service-role only; written by ai_claim_spend_alerts.';

-- Partial unique indexes rather than NULLS NOT DISTINCT so the arbitration does
-- not depend on the Postgres major version.
create unique index if not exists ai_spend_alert_marks_org_once
  on public.ai_spend_alert_marks (month_start, org_id, threshold)
  where scope = 'org';

create unique index if not exists ai_spend_alert_marks_platform_once
  on public.ai_spend_alert_marks (month_start, threshold)
  where scope = 'platform';

alter table public.ai_spend_alert_marks enable row level security;
revoke all on table public.ai_spend_alert_marks from anon, authenticated, public;
grant select, insert on table public.ai_spend_alert_marks to service_role;

create or replace function public.ai_claim_spend_alerts(
  p_org_id uuid,
  p_default_ceiling_pence integer default 10000,
  p_refused text default null
)
returns table(
  scope text,
  org_id uuid,
  threshold smallint,
  spent_pence bigint,
  ceiling_pence integer,
  month_start date
)
language plpgsql
set search_path to ''
as $function$
#variable_conflict use_column
declare
  v_month      date;
  v_start      timestamptz;
  v_end        timestamptz;
  v_org_marks  integer := 0;
  v_plat_marks integer := 0;
  v_ceiling    integer;
  v_spent      bigint;
begin
  if p_refused is not null and p_refused not in ('org', 'platform') then
    raise exception 'p_refused must be org, platform or null'
      using errcode = 'invalid_parameter_value';
  end if;

  v_month := (date_trunc('month', (now() at time zone 'Europe/London')))::date;
  v_start := (date_trunc('month', (now() at time zone 'Europe/London'))
                at time zone 'Europe/London');
  v_end   := ((date_trunc('month', (now() at time zone 'Europe/London'))
                + interval '1 month') at time zone 'Europe/London');

  -- Fast exit: both thresholds already claimed for this org and the platform.
  select count(*) filter (where m.scope = 'org'),
         count(*) filter (where m.scope = 'platform')
    into v_org_marks, v_plat_marks
    from public.ai_spend_alert_marks m
   where m.month_start = v_month
     and (m.scope = 'platform' or m.org_id = p_org_id);

  -- ── ORG CEILING (same effective ceiling as ai_reserve_invocation) ─────────
  if p_org_id is not null and v_org_marks < 2 then
    select least(coalesce(
             (select c.ceiling_pence from public.ai_org_budget_ceilings c where c.org_id = p_org_id),
             p_default_ceiling_pence), 50000)
      into v_ceiling;

    if v_ceiling is not null and v_ceiling > 0 then
      select coalesce(sum(i.estimated_cost_pence), 0)::bigint
        into v_spent
        from public.ai_invocations i
       where i.org_id = p_org_id
         and i.created_at >= v_start
         and i.created_at <  v_end;

      return query
      with ins as (
        insert into public.ai_spend_alert_marks as m
          (month_start, scope, org_id, threshold, spent_pence, ceiling_pence)
        select v_month, 'org', p_org_id, t.th, v_spent, v_ceiling
          from (values (80::smallint), (100::smallint)) as t(th)
         where (v_spent >= v_ceiling or p_refused = 'org')
            or (t.th = 80 and v_spent * 100 >= v_ceiling::bigint * 80)
        on conflict do nothing
        returning m.scope, m.org_id, m.threshold, m.spent_pence, m.ceiling_pence, m.month_start
      )
      select * from ins;
    end if;
  end if;

  -- ── CREWFLOW-WIDE CEILING (same read as ai_reserve_invocation) ───────────
  if v_plat_marks < 2 then
    select least(coalesce(
             (select b.ceiling_pence from public.ai_platform_budget b where b.id),
             50000), 1000000)
      into v_ceiling;

    if v_ceiling is not null and v_ceiling > 0 then
      select coalesce(sum(i.estimated_cost_pence), 0)::bigint
        into v_spent
        from public.ai_invocations i
       where i.created_at >= v_start
         and i.created_at <  v_end;

      return query
      with ins as (
        insert into public.ai_spend_alert_marks as m
          (month_start, scope, org_id, threshold, spent_pence, ceiling_pence)
        select v_month, 'platform', null, t.th, v_spent, v_ceiling
          from (values (80::smallint), (100::smallint)) as t(th)
         where (v_spent >= v_ceiling or p_refused = 'platform')
            or (t.th = 80 and v_spent * 100 >= v_ceiling::bigint * 80)
        on conflict do nothing
        returning m.scope, m.org_id, m.threshold, m.spent_pence, m.ceiling_pence, m.month_start
      )
      select * from ins;
    end if;
  end if;
end $function$;

revoke all on function public.ai_claim_spend_alerts(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.ai_claim_spend_alerts(uuid, integer, text) to service_role;

commit;
