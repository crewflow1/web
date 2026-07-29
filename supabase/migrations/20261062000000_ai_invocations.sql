-- AI Cost Governor — the invocation ledger.
--
-- WHY THIS EXISTS BEFORE ANY GENERATIVE FEATURE IS LIVE.
-- CrewFlow's subscription is ~£500/month/org and the AI budget carries a HARD
-- CEILING of £100/month/org. That ceiling is a SAFETY LIMIT, not a target: it
-- is the number that stands between a runaway loop and a month where the AI
-- spend eats the margin of the customer it was meant to serve. A ceiling that
-- exists only in a spreadsheet is not a control — so the measurement substrate
-- lands BEFORE the first real provider call, not after the first surprise bill.
-- Every future AI call passes through lib/ai/governor.ts, and every call that
-- actually reaches a provider lands here. Nothing generative is live today
-- (every tier maps to NO model — see lib/ai/governor/registry.ts), so on a
-- fresh production database this table is correct and EMPTY. That is the
-- expected state, and it is the point: the seam is built dark.
--
-- WHAT THIS TABLE IS NOT.
-- It is not a billing ledger and it is not money the business owes or is owed.
-- It is TELEMETRY — an operational record of what CrewFlow spent on inference.
-- Nothing here posts to `finances`, nothing invoices a customer from it, and no
-- commercial figure is derived from it. See `estimated_cost_pence` below for
-- why that distinction decides the column's type.
--
-- Additive, idempotent, reversible. To roll back:
--   drop function if exists public.ai_invocations_month_totals(uuid, date);
--   drop trigger if exists ai_invocations_immutable on public.ai_invocations;
--   drop function if exists public.tg_ai_invocations_immutable();
--   drop table if exists public.ai_invocations;

create table if not exists public.ai_invocations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,

  -- NULLABLE ON PURPOSE. A system job (a cron sweep, a webhook-driven inbound
  -- turn, a scheduled digest) has an org but no human behind it. Forcing a
  -- user_id here would mean either refusing to record those invocations — the
  -- exact ones most likely to run away unattended — or attributing them to a
  -- fabricated actor. `on delete set null` because a departed employee's
  -- deletion must not erase the org's spend history.
  user_id     uuid references public.users(id) on delete set null,

  -- The capability that spent the money, e.g. 'expense.receipt_extraction'.
  -- TEXT, not an enum: the authority is the TypeScript registry
  -- (lib/ai/governor/registry.ts), so adding a governed capability is a code
  -- change plus a test, never a migration. The CHECK bounds the value without
  -- pretending to know the closed set.
  feature     text not null check (length(trim(feature)) between 1 and 120),

  -- The routing class the governor resolved (see lib/ai/governor/registry.ts).
  -- 'deterministic' is DELIBERATELY ABSENT from this CHECK: a deterministic
  -- task reaches no model by definition, so a row claiming deterministic spend
  -- is a contradiction. The TypeScript wrapper refuses it loudly; this
  -- constraint makes the same claim STRUCTURALLY UNREPRESENTABLE, for every
  -- role including service_role. Two independent statements of one rule.
  task_class  text not null check (task_class in ('classification', 'drafting', 'complex')),

  provider    text not null check (length(trim(provider)) between 1 and 60),
  model       text not null check (length(trim(model)) between 1 and 120),

  input_tokens  integer not null default 0 check (input_tokens  >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),

  -- INTEGER PENCE — and the reason is the opposite of the usual one.
  --
  -- Elsewhere in CrewFlow, money is `numeric(12,2)` because it is COMMERCIAL
  -- money: an invoice total, a CIS deduction, a supplier payment. Those must
  -- reconcile to the penny against a bank statement and a tax return, so their
  -- type is chosen to make rounding a visible decision.
  --
  -- This column is not that. It is an ESTIMATE of inference cost, derived by
  -- multiplying a token count by a published per-million-token rate that the
  -- vendor may change without telling us. Its true precision is "roughly, in
  -- pence". Storing it as numeric would advertise a precision the number does
  -- not have and invite someone to sum it into a financial report. An integer
  -- count of pence is honest about the granularity, sums exactly (no float
  -- drift across a million rows), and is obviously not a commercial figure.
  -- Sub-penny invocations round UP to 1 penny when non-zero, so a million cheap
  -- classifications can never aggregate to £0 — see lib/ai/governor/policy.ts.
  estimated_cost_pence integer not null default 0 check (estimated_cost_pence >= 0),

  latency_ms  integer not null check (latency_ms >= 0),

  -- The honest outcome. A FAILED call still cost latency, still consumed the
  -- rate limit, and (for most vendors) still billed the input tokens — so a
  -- failure is recorded, never dropped. A ledger that only holds successes
  -- under-reports exactly when something is going wrong.
  success     boolean not null,
  error_code  text check (error_code is null or length(trim(error_code)) between 1 and 120),

  -- SHA-256 of (feature, task_class, request content), hex. Feeds the recent-
  -- duplicate check in lib/ai/governor.ts: re-asking a model the identical
  -- question minutes apart is pure waste, and the cheapest place to catch it is
  -- before the call. Nullable because a caller that cannot cheaply hash its
  -- input still gets full accounting — it simply forgoes dedupe. The content
  -- ITSELF is never stored: this is a fingerprint, not the prompt.
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),

  created_at  timestamp with time zone not null default now(),

  -- A success has nothing to explain; a failure without a code is unactionable.
  constraint ai_invocations_outcome_check
    check ((success and error_code is null) or (not success and error_code is not null))
);

-- ── indexes ──────────────────────────────────────────────────────────────────
-- (org_id, created_at) — THE budget read. Every checkBudget() call scans one
-- org's current month, so this is the index the ceiling itself depends on.
create index if not exists ai_invocations_org_created_idx
  on public.ai_invocations (org_id, created_at desc);
-- (feature, …) — the HQ "cost by feature" view and any per-capability
-- investigation. created_at rides along so the month filter is index-served
-- rather than a filter over the whole feature's history.
create index if not exists ai_invocations_feature_idx
  on public.ai_invocations (feature, created_at desc);
-- The dedupe probe: most recent identical request for this org+feature.
create index if not exists ai_invocations_dedupe_idx
  on public.ai_invocations (org_id, feature, content_hash, created_at desc)
  where content_hash is not null;

-- ── immutability: telemetry is a fact, not a draft ───────────────────────────
-- A recorded invocation describes something that already happened. Rewriting
-- one is either a mistake or an attempt to hide spend, and both are worth
-- refusing.
--
-- TWO DELIBERATE HOLES, both of which are erasure paths rather than edits:
--
--   1. DELETE is not guarded at all, so `organizations … on delete cascade`
--      still works. A BEFORE DELETE guard here would abort tenant teardown and
--      GDPR erasure — the exact failure 20261052 was written to fix. No JWT
--      client can delete (there is no DELETE policy below), so deletion is
--      reachable only by the service role, which is what performs teardown.
--
--   2. `user_id → null` is permitted, because that is not an edit either: it is
--      the FK's own `on delete set null` firing when a departed employee is
--      removed. Postgres implements that as an UPDATE, so a blanket refusal
--      would make this ledger BLOCK USER DELETION outright — the same class of
--      failure as (1), and one that would leave personal data undeletable.
--      The hole is cut as narrowly as it can be: the update is allowed only
--      when user_id goes from something to null AND every other column is
--      byte-identical. An attempt to smuggle a cost change alongside the
--      anonymisation is still refused.
create or replace function public.tg_ai_invocations_immutable()
returns trigger language plpgsql as $$
declare
  v_anonymised public.ai_invocations%rowtype;
begin
  if old.user_id is not null and new.user_id is null then
    v_anonymised := old;
    v_anonymised.user_id := null;
    -- IS NOT DISTINCT FROM, never `=`: row equality involving a NULL field
    -- yields NULL rather than false, which an `if` would treat as "not equal"
    -- and which would therefore refuse every legitimate anonymisation of a row
    -- that happens to have a null error_code or content_hash.
    if new is not distinct from v_anonymised then
      return new;
    end if;
  end if;
  raise exception 'ai_invocations rows are immutable telemetry — record a new invocation instead'
    using errcode = 'check_violation';
end $$;

drop trigger if exists ai_invocations_immutable on public.ai_invocations;
create trigger ai_invocations_immutable before update on public.ai_invocations
  for each row execute function public.tg_ai_invocations_immutable();

-- ── RLS: ADMIN-READ-ONLY per org; writes are service-role only ───────────────
-- Usage data is sensitive. It reveals how heavily a firm leans on AI, which
-- capabilities its staff use, and — through timing and volume — how it works.
-- That is owner/admin information, not crew information, so SELECT is gated on
-- is_org_admin(org_id) rather than membership.
--
-- There is NO insert/update/delete policy at all. The governor writes through
-- the service-role client (which bypasses RLS); a tenant client therefore
-- cannot write a row under ANY circumstances. This is not defence in depth for
-- its own sake: if a user could insert, a user could fabricate spend to trip
-- their own org's ceiling (denial of service against a paid feature) or, worse,
-- write rows claiming zero cost while the real spend went unrecorded.
alter table public.ai_invocations enable row level security;

create policy ai_invocations_select on public.ai_invocations
  for select using (public.is_org_admin(org_id));

-- ── the monthly rollup ───────────────────────────────────────────────────────
-- Org-month totals: the aggregate the ceiling is enforced against and the HQ
-- cost view renders.
--
-- THE MONTH BOUNDARY IS EUROPE/LONDON, not UTC. CrewFlow is a UK business
-- (lib/time/format.ts: "All timestamps are stored in UTC. The business operates
-- in the UK"), and a £100 monthly ceiling is a calendar-month promise made to a
-- UK operator. Under BST the two definitions disagree for the first hour of
-- every month, so an invocation at 00:30 on 1 August BST belongs to August's
-- budget even though its UTC timestamp still reads 31 July. Reading the naive
-- `date_trunc('month', …)` as London wall-clock and converting to an instant is
-- the same inverse `lib/schedule/window.ts` performs for days; the TypeScript
-- side computes the identical window through `ukDayStartMs`.
--
-- SECURITY INVOKER (the default — note the absence of `security definer`).
-- This function holds NO privilege of its own: the SELECT below is checked
-- against the CALLER's policies. An org admin therefore sees their own org and
-- nothing else even when passing another org's id; a member sees nothing; the
-- service role sees everything. A SECURITY DEFINER rollup would have been a
-- cross-tenant read primitive — precisely the defect class 20261031–37 was
-- written to eliminate — and no aggregate is worth reintroducing it.
--
-- `p_org_id` NULL means "every org the caller may see, grouped" — one row per
-- org with spend. That is how HQ (service role) renders cost by org, and it
-- leaks nothing to anyone else, because RLS has already decided what is visible.
create or replace function public.ai_invocations_month_totals(
  p_org_id uuid default null,
  p_month  date default current_date
)
returns table (
  org_id               uuid,
  month_start          date,
  invocations          bigint,
  successes            bigint,
  failures             bigint,
  input_tokens         bigint,
  output_tokens        bigint,
  total_cost_pence     bigint
)
language sql
stable
set search_path = ''
as $$
  with bounds as (
    select
      date_trunc('month', p_month::timestamp)                       as naive_start,
      date_trunc('month', p_month::timestamp) + interval '1 month'  as naive_end
  )
  select
    i.org_id,
    (select naive_start from bounds)::date                           as month_start,
    count(*)                                                         as invocations,
    count(*) filter (where i.success)                                as successes,
    count(*) filter (where not i.success)                            as failures,
    coalesce(sum(i.input_tokens), 0)::bigint                         as input_tokens,
    coalesce(sum(i.output_tokens), 0)::bigint                        as output_tokens,
    coalesce(sum(i.estimated_cost_pence), 0)::bigint                 as total_cost_pence
  from public.ai_invocations i, bounds b
  where (p_org_id is null or i.org_id = p_org_id)
    and i.created_at >= (b.naive_start at time zone 'Europe/London')
    and i.created_at <  (b.naive_end   at time zone 'Europe/London')
  group by i.org_id;
$$;

-- Safe for tenant callers precisely BECAUSE it is invoker-rights: granting
-- EXECUTE grants no read the caller did not already have.
revoke all on function public.ai_invocations_month_totals(uuid, date) from public;
grant execute on function public.ai_invocations_month_totals(uuid, date)
  to anon, authenticated, service_role;

-- ── the per-feature rollup ───────────────────────────────────────────────────
-- "Which capability is spending the money?" — the second question HQ asks, and
-- the one that turns a scary total into an actionable one.
--
-- A sibling of the function above rather than an aggregation in TypeScript, for
-- a reason that only shows up after activation: at even a penny per call the
-- £100 ceiling permits ~10,000 invocations per org per month, so a fleet of
-- tenants makes "select the month's rows and group them in the application" a
-- multi-million-row transfer. Postgres groups it in place.
--
-- Same invoker-rights, same UK month window, same absence of `security definer`
-- — an org admin sees only their own org's features, and HQ (service role) sees
-- the estate.
create or replace function public.ai_invocations_month_by_feature(
  p_month  date default current_date,
  p_org_id uuid default null
)
returns table (
  feature              text,
  invocations          bigint,
  successes            bigint,
  failures             bigint,
  total_cost_pence     bigint
)
language sql
stable
set search_path = ''
as $$
  with bounds as (
    select
      date_trunc('month', p_month::timestamp)                       as naive_start,
      date_trunc('month', p_month::timestamp) + interval '1 month'  as naive_end
  )
  select
    i.feature,
    count(*)                                          as invocations,
    count(*) filter (where i.success)                 as successes,
    count(*) filter (where not i.success)             as failures,
    coalesce(sum(i.estimated_cost_pence), 0)::bigint  as total_cost_pence
  from public.ai_invocations i, bounds b
  where (p_org_id is null or i.org_id = p_org_id)
    and i.created_at >= (b.naive_start at time zone 'Europe/London')
    and i.created_at <  (b.naive_end   at time zone 'Europe/London')
  group by i.feature;
$$;

revoke all on function public.ai_invocations_month_by_feature(date, uuid) from public;
grant execute on function public.ai_invocations_month_by_feature(date, uuid)
  to anon, authenticated, service_role;

comment on table public.ai_invocations is
  'AI Cost Governor ledger. Telemetry, not commercial money. Admin-read-only per org; service-role write only; UPDATE-immutable; DELETE left open so org teardown cascades.';
