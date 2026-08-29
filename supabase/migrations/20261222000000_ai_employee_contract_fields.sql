-- AI Employee contract completion — manager line, terminal retirement,
-- per-employee cost attribution, persisted KPIs (L10, roadmap/final-completion).
--
-- Four contract fields the AI-employee framework specified but never carried:
--
--   1. ai_employees.manager_slug — the management spine. The org chart is
--      seeded from docs/bible/workforce/relationships.md §2 (the canonical
--      management graph): CEO reports to the human board (NULL manager); the
--      execs (COO/CTO/CFO/Boardroom Orchestrator) report to the CEO; every
--      other employee reports up the documented line (see the mapping below).
--      Two roster identities exist OUTSIDE the 42-employee bible roster and so
--      have no documented line; they take the task's fallback rule ("execs
--      manage dept workers"):
--        design-ai         → cto-ai (Technology division owns the build line)
--        exec-assistant-ai → ceo-ai (the executive office's own assistant)
--      Seeding only fills NULLs — an operator edit is never clobbered.
--
--   2. ai_employees.retired_at + status 'retired' — retirement is TERMINAL.
--      Enforced by trigger, not convention: only disabled → retired is
--      admitted; a retired row refuses EVERY subsequent update and delete.
--      An identity that has been retired is a historical fact, exactly like
--      a ledger row.
--
--   3. ai_invocations.ai_employee_id — per-employee cost attribution.
--      Nullable and backfill-free: historical rows carry no employee, and a
--      call with no acting AI employee (a human-triggered feature) never will.
--      DELIBERATELY NOT A FOREIGN KEY: the ledger is immutable by trigger
--      (20261062), so `on delete set null` would throw at employee-delete time
--      (the FK's internal UPDATE trips the immutability trigger), and
--      `restrict`/`no action` would let telemetry veto roster management.
--      Telemetry references, it does not own. The settle RPC
--      (ai_settle_reservation) gains an optional p_ai_employee_id so the
--      governed reserve→settle path can attribute the ledger row it writes;
--      the direct recordInvocation path passes the column straight through.
--      Dark today (no tier is bound); the seam means attribution is live the
--      day the tiers bind, with zero further schema work.
--
--   4. ai_employee_kpis — persisted per-employee, per-period KPIs (tasks
--      completed/failed, approvals requested, attributed cost). HONEST derived
--      metrics only — rolled up from hq_ai_tasks + hq_approvals +
--      ai_invocations by the stats service (compute-on-read upsert; no cron).
--      RLS enabled with NO policies: service-role only, like every ai_employee*
--      table.
--
-- Additive and idempotent. Rollback:
--   drop table if exists public.ai_employee_kpis;
--   drop trigger if exists ai_employees_retirement on public.ai_employees;
--   drop function if exists public.tg_ai_employees_retirement();
--   alter table public.ai_invocations drop column if exists ai_employee_id;
--   alter table public.ai_employees drop column if exists manager_slug;
--   alter table public.ai_employees drop column if exists retired_at;
--   (and restore ai_employees_status_check / ai_settle_reservation from
--    20260712000000 / 20261070000000.)

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The management spine — manager_slug
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.ai_employees
  add column if not exists manager_slug text null;

-- FK-ish integrity: the manager must be a real roster slug (slug is UNIQUE, so
-- a true FK is available and used — SET NULL keeps a report standing if its
-- manager row were ever removed), and nobody manages themself.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_employees_manager_not_self'
      and conrelid = 'public.ai_employees'::regclass
  ) then
    alter table public.ai_employees
      add constraint ai_employees_manager_not_self
      check (manager_slug is null or manager_slug <> slug);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_employees_manager_slug_fkey'
      and conrelid = 'public.ai_employees'::regclass
  ) then
    alter table public.ai_employees
      add constraint ai_employees_manager_slug_fkey
      foreign key (manager_slug) references public.ai_employees(slug)
      on delete set null;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Terminal retirement — retired_at + status 'retired' + the trigger
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.ai_employees
  add column if not exists retired_at timestamptz null;

-- Widen the status CHECK to admit 'retired'.
alter table public.ai_employees
  drop constraint if exists ai_employees_status_check;
alter table public.ai_employees
  add constraint ai_employees_status_check
  check (status in (
    'idle', 'working', 'waiting_approval', 'blocked', 'error', 'disabled', 'retired'
  ));

-- retired_at ⇔ status = 'retired' — a retirement stamp cannot exist without the
-- status, and a retired row cannot lack its stamp.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_employees_retired_at_consistency'
      and conrelid = 'public.ai_employees'::regclass
  ) then
    alter table public.ai_employees
      add constraint ai_employees_retired_at_consistency
      check ((status = 'retired') = (retired_at is not null));
  end if;
end $$;

-- The lifecycle law, enforced where it cannot be argued with:
--   disabled → retired : the ONLY admitted entry (the trigger stamps retired_at)
--   retired  → anything: refused — a retired row is immutable, every column
--   delete of a retired row: refused — retirement is a permanent record
create or replace function public.tg_ai_employees_retirement()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'retired' then
      raise exception 'ai_employees: a retired employee is a permanent record and cannot be deleted (%).', old.slug
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  -- UPDATE paths.
  if old.status = 'retired' then
    raise exception 'ai_employees: % is retired — retirement is terminal; no update is admitted.', old.slug
      using errcode = 'check_violation';
  end if;

  if new.status = 'retired' then
    if old.status <> 'disabled' then
      raise exception 'ai_employees: % must be disabled before it can be retired (currently %).', old.slug, old.status
        using errcode = 'check_violation';
    end if;
    new.retired_at := coalesce(new.retired_at, now());
  else
    -- A non-retired row never carries a retirement stamp (belt to the CHECK's braces).
    new.retired_at := null;
  end if;

  return new;
end $$;

drop trigger if exists ai_employees_retirement on public.ai_employees;
create trigger ai_employees_retirement
  before update or delete on public.ai_employees
  for each row execute function public.tg_ai_employees_retirement();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Seed the org chart (docs/bible/workforce/relationships.md §2)
-- ═══════════════════════════════════════════════════════════════════════════
-- Fills NULLs only, and only where both employee and manager rows exist —
-- idempotent, and an operator's later edit is never overwritten by a re-run.
-- Rows seeded by LATER roster migrations (20261225000000) carry their manager
-- in their own insert.

update public.ai_employees e
   set manager_slug = v.manager
  from (values
    -- Executive office → CEO (the CEO itself reports to the human board: NULL).
    ('coo-ai',                 'ceo-ai'),
    ('cto-ai',                 'ceo-ai'),
    ('cfo-ai',                 'ceo-ai'),
    ('orchestrator-ai',        'ceo-ai'),
    ('exec-assistant-ai',      'ceo-ai'),          -- outside the 42-roster; exec office
    -- Technology + AI Platform → CTO.
    ('product-ai',             'cto-ai'),
    ('eng-manager-ai',         'cto-ai'),
    ('security-ai',            'cto-ai'),          -- independence from the delivery line
    ('memory-manager-ai',      'cto-ai'),
    ('workflow-ai',            'cto-ai'),
    ('notification-ai',        'cto-ai'),
    ('monitoring-incident-ai', 'cto-ai'),
    ('design-ai',              'cto-ai'),          -- outside the 42-roster; Technology
    -- Engineering delivery line → Engineering Manager.
    ('qa-ai',                  'eng-manager-ai'),
    ('devops-ai',              'eng-manager-ai'),
    ('documentation-ai',       'eng-manager-ai'),
    ('database-ai',            'eng-manager-ai'),
    ('api-ai',                 'eng-manager-ai'),
    -- COO's direct reports.
    ('sales-ai',               'coo-ai'),
    ('marketing-ai',           'coo-ai'),
    ('customer-success-ai',    'coo-ai'),
    ('operations-ai',          'coo-ai'),
    ('hr-ai',                  'coo-ai'),
    ('legal-compliance-ai',    'coo-ai'),
    -- Revenue funnel → Sales.
    ('research-ai',            'sales-ai'),
    ('lead-qualification',     'sales-ai'),
    ('outreach-ai',            'sales-ai'),
    -- Customer lifecycle → Customer Success; channels → Support.
    ('support-ai',             'customer-success-ai'),
    ('onboarding-ai',          'customer-success-ai'),
    ('voice-receptionist-ai',  'support-ai'),
    -- Money functions → CFO / Finance.
    ('finance-ai',             'cfo-ai'),
    ('analytics-ai',           'cfo-ai')
  ) as v(slug, manager)
 where e.slug = v.slug
   and e.manager_slug is null
   and exists (select 1 from public.ai_employees m where m.slug = v.manager);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Per-employee cost attribution — ai_invocations.ai_employee_id
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.ai_invocations
  add column if not exists ai_employee_id uuid null;

comment on column public.ai_invocations.ai_employee_id is
  'The acting AI employee (ai_employees.id), when one exists. Nullable and '
  'backfill-free; NOT a FK because the ledger is immutable by trigger (a '
  'set-null cascade would throw) and telemetry must never veto roster ops.';

-- The per-employee cost read: one employee''s attributed spend, newest first.
create index if not exists ai_invocations_employee_idx
  on public.ai_invocations (ai_employee_id, created_at desc)
  where ai_employee_id is not null;

-- Replace the settle RPC with an attribution-aware signature. DROP + CREATE
-- (never CREATE OR REPLACE with a new parameter): adding a defaulted parameter
-- via CREATE OR REPLACE would create an OVERLOAD, and PostgREST named-argument
-- calls that omit the new parameter would then be ambiguous between the two.
drop function if exists public.ai_settle_reservation(
  uuid, boolean, integer, text, text, integer, integer, integer, text);
-- Re-run safety: also drop the target signature if a prior partial apply left it.
drop function if exists public.ai_settle_reservation(
  uuid, boolean, integer, text, text, integer, integer, integer, text, uuid);

create function public.ai_settle_reservation(
  p_reservation_id uuid,
  p_success        boolean,
  p_cost_pence     integer,
  p_provider       text,
  p_model          text,
  p_input_tokens   integer default 0,
  p_output_tokens  integer default 0,
  p_latency_ms     integer default 0,
  p_error_code     text    default null,
  p_ai_employee_id uuid    default null
)
returns table (
  outcome       text,
  invocation_id uuid,
  cost_pence    integer
)
language plpgsql
set search_path = ''
as $$
declare
  v_res        public.ai_cost_reservations%rowtype;
  v_cost       integer;
  v_invocation uuid;
begin
  if p_reservation_id is null or p_success is null then
    raise exception 'reservation id and outcome are both required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- FOR UPDATE: two settlements of one claim serialise on the row itself, so
  -- the lifecycle trigger's "terminal is terminal" rule is reached by exactly
  -- one of them rather than raced by both.
  select * into v_res
    from public.ai_cost_reservations
   where id = p_reservation_id
     for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::integer;
    return;
  end if;
  if v_res.state <> 'reserved' then
    return query select 'already_settled'::text, v_res.invocation_id, v_res.cost_pence;
    return;
  end if;

  v_cost := greatest(0, coalesce(p_cost_pence, 0));

  -- The committed fact. Immutable from the moment it lands. The ledger's own
  -- CHECK requires an error code on failure and none on success, so the
  -- coalesce below is the same guarantee the TypeScript writer makes.
  -- ai_employee_id is attribution TELEMETRY handed by the governed caller —
  -- the reservation's budget arithmetic is untouched by it.
  insert into public.ai_invocations (
    org_id, user_id, feature, task_class, provider, model,
    input_tokens, output_tokens, estimated_cost_pence, latency_ms,
    success, error_code, content_hash, ai_employee_id
  ) values (
    v_res.org_id, v_res.user_id, v_res.feature, v_res.task_class,
    coalesce(nullif(trim(coalesce(p_provider, '')), ''), 'unknown'),
    coalesce(nullif(trim(coalesce(p_model, '')), ''), 'unknown'),
    greatest(0, coalesce(p_input_tokens, 0)),
    greatest(0, coalesce(p_output_tokens, 0)),
    v_cost,
    greatest(0, coalesce(p_latency_ms, 0)),
    p_success,
    case when p_success then null
         else coalesce(nullif(trim(coalesce(p_error_code, '')), ''), 'unknown_error') end,
    v_res.content_hash,
    p_ai_employee_id
  )
  returning id into v_invocation;

  update public.ai_cost_reservations
     set state = 'settled',
         success = p_success,
         cost_pence = v_cost,
         invocation_id = v_invocation,
         settled_at = now()
   where id = v_res.id;

  return query select 'settled'::text, v_invocation, v_cost;
end $$;

revoke all on function public.ai_settle_reservation(
  uuid, boolean, integer, text, text, integer, integer, integer, text, uuid) from public;
grant execute on function public.ai_settle_reservation(
  uuid, boolean, integer, text, text, integer, integer, integer, text, uuid)
  to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Persisted KPIs — ai_employee_kpis
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per (employee, period). period_start is the first day of the UK
-- budget month — the same window the AI cost governor buckets by, so cost and
-- outcomes describe the SAME period. Every figure is derived from real rows
-- (hq_ai_tasks, hq_approvals, ai_invocations); nothing here is invented.

create table if not exists public.ai_employee_kpis (
  id                  uuid primary key default gen_random_uuid(),
  employee_slug       text not null references public.ai_employees(slug) on delete cascade,
  period_start        date not null,
  tasks_completed     integer not null default 0 check (tasks_completed >= 0),
  tasks_failed        integer not null default 0 check (tasks_failed >= 0),
  approvals_requested integer not null default 0 check (approvals_requested >= 0),
  cost_pence          bigint  not null default 0 check (cost_pence >= 0),
  computed_at         timestamptz not null default now(),

  constraint ai_employee_kpis_period_key unique (employee_slug, period_start)
);

alter table public.ai_employee_kpis enable row level security;
-- NO policies → service-role only, exactly like the other ai_employee* tables.
-- The customer/staff JWT client can never see or touch these rows.

create index if not exists ai_employee_kpis_period_idx
  on public.ai_employee_kpis (period_start desc, employee_slug);
