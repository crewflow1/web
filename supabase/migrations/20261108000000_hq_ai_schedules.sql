-- CrewFlow HQ — the operating-model CADENCE CLOCK (OS Vol XIV / census O1).
--
-- THE PROBLEM THIS MODELS
-- -----------------------
-- The HQ operating system runs ~25 hand-rolled cron cadences (minute→year),
-- one ad-hoc `app/api/cron/*` route each, every schedule buried in vercel.json
-- and re-derived by reading route files. There is no single registry of "what
-- cadences the company runs, on what clock, and whether each is on". The census
-- O1 finding named this: the cadence layer is data-less. This migration adds the
-- SCHEDULE REGISTRY — one modelled clock — as a DETERMINISTIC SUBSTRATE.
--
-- WHAT THIS IS, AND WHAT IT IS NOT
-- --------------------------------
-- It is an ADDITIVE MODELLING LAYER, not a rip-and-replace. Every existing cron
-- keeps its own vercel.json entry and keeps firing UNCHANGED. A registry row is
-- DARK by default (enabled=false): it fires nothing until a super-admin opts a
-- cadence in. When enabled, the deterministic tick (/api/cron/hq-cadence-tick)
-- fires the cadence's due occurrences by ROUTING TO THE EXISTING HQ AUTHORITY
-- for that cadence (the same drain the ad-hoc route calls) — never a new side
-- effect. Because every routed drain is a safety-net drain that CLAIMS its work
-- idempotently, an enabled registry row and its legacy cron can both run without
-- double-doing anything.
--
-- HQ-GLOBAL — #456
-- ----------------
-- A cadence is company infrastructure, not tenant data: these tables carry NO
-- org_id and never blend tenant orgs (#456 — HQ-global admin data only). They
-- follow the freshest hq_* convention (hq_workflow_sagas 20261104000000):
--
--   RLS:hq — RLS ENABLED, ZERO policies. service_role (BYPASSRLS) reaches the
--   tables; every JWT client (anon/authenticated) is denied. HQ infrastructure is
--   never tenant-visible; the request-path super-admin gate (server/auth/hq.ts) is
--   the only door, because "super-admin" is an ENV allowlist, not a DB role — it
--   cannot be expressed as an RLS policy.
--
-- DETERMINISM
-- -----------
-- cron_expr is a standard 5-field expression interpreted in UTC and evaluated by
-- the ONE shared evaluator (lib/automation/cron.ts computeNextRun) — no BST/GMT
-- ambiguity, and two ticks on two machines always agree on the next occurrence,
-- which is exactly what the drain's optimistic next_run_at claim relies on to be
-- single-fire under concurrency.
--
-- Additive + idempotent throughout (create-if-not-exists / drop-create / seed on
-- conflict do nothing). Reversible:
--   drop table public.hq_ai_schedule_runs;
--   drop table public.hq_ai_schedules;

-- ===========================================================================
-- 1. hq_ai_schedules — the registry: one row per modelled HQ cadence.
-- ===========================================================================
create table if not exists public.hq_ai_schedules (
  id           uuid        primary key default gen_random_uuid(),

  -- The stable identity of this cadence. Maps to a code catalogue entry
  -- (lib/hq/cadence/catalogue.ts) that binds the cadence to its EXISTING HQ
  -- authority; free text validated in the service layer, exactly as
  -- automation_schedules.rule_key is (the catalogue evolves with code, so a CHECK
  -- enumerating keys would force a migration on every catalogue change). One row
  -- per cadence.
  cadence_key  text        not null unique check (length(btrim(cadence_key)) > 0),

  -- Standard 5-field cron expression (minute hour day-of-month month day-of-week),
  -- interpreted in UTC. Parsed + validated by lib/automation/cron.ts before any
  -- write; the tick advances next_run_at with the SAME evaluator.
  cron_expr    text        not null check (length(btrim(cron_expr)) > 0),

  -- DARK BY DEFAULT. A cadence fires nothing until a super-admin opts it in; the
  -- legacy cron keeps working regardless. This is what makes the whole layer safe
  -- to ship additively.
  enabled      boolean     not null default false,

  -- The next UTC instant this cadence is due. NULL while dark — set from cron_expr
  -- deterministically the moment a cadence is enabled, and advanced by the tick.
  next_run_at  timestamptz,

  -- The last instant the tick actually dispatched this cadence. NULL until first
  -- fire.
  last_run_at  timestamptz,

  -- Human-readable description of what the cadence does (for the admin surface).
  description  text,

  -- Provenance. created_by is nullable so the row survives a user delete;
  -- write-once after insert (the guard below enforces it).
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The tick's hot path: "every enabled cadence whose next_run_at has passed".
-- Partial on enabled so the scan ignores dark cadences entirely.
create index if not exists hq_ai_schedules_due_idx
  on public.hq_ai_schedules (next_run_at)
  where enabled;

-- RLS:hq — enable, NO policies. service_role (BYPASSRLS) reaches it; every JWT
-- client is denied. Cadences are HQ infrastructure; tenants never see them.
alter table public.hq_ai_schedules enable row level security;

-- Provenance write-once + deterministic updated_at. A BEFORE guard no caller can
-- bypass — not even the service-role admin client that BYPASSES RLS — the same
-- lesson hq_workflow_sagas learned.
create or replace function public.hq_ai_schedules_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.updated_at := now();
    return new;
  end if;
  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.cadence_key is distinct from old.cadence_key then
    raise exception 'hq_ai_schedules %: cadence_key / created_by / created_at are write-once', old.id
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists hq_ai_schedules_guard_ins on public.hq_ai_schedules;
create trigger hq_ai_schedules_guard_ins
  before insert on public.hq_ai_schedules
  for each row execute function public.hq_ai_schedules_guard();

drop trigger if exists hq_ai_schedules_guard_upd on public.hq_ai_schedules;
create trigger hq_ai_schedules_guard_upd
  before update on public.hq_ai_schedules
  for each row execute function public.hq_ai_schedules_guard();

-- ===========================================================================
-- 2. hq_ai_schedule_runs — the immutable, append-only tick run-log.
--
-- One row per fired occurrence: which cadence, which occurrence instant, the
-- outcome of routing to the existing authority. Stored forever — block-mutation
-- triggers reject UPDATE and DELETE even under service-role, exactly as
-- hq_saga_events guards its history. The registry row carries the LIVE clock;
-- this child is the permanent record of what actually fired when. It makes the
-- dark substrate observable without touching any existing cron's telemetry.
-- ===========================================================================
create table if not exists public.hq_ai_schedule_runs (
  id           uuid        primary key default gen_random_uuid(),
  schedule_id  uuid        not null references public.hq_ai_schedules(id) on delete cascade,
  -- Denormalised so the log reads standalone even if the registry row is renamed
  -- in a future life (it cannot today — cadence_key is write-once).
  cadence_key  text        not null,
  -- The occurrence instant this run fired (the pre-advance next_run_at). Together
  -- with schedule_id this identifies exactly one occurrence.
  occurrence   timestamptz not null,
  fired_at     timestamptz not null default now(),
  -- The outcome of routing to the existing HQ authority.
  outcome      text        not null default 'dispatched'
                 check (outcome in ('dispatched','dispatch_failed','no_dispatch')),
  detail       jsonb       not null default '{}'::jsonb
);

create index if not exists hq_ai_schedule_runs_schedule_idx
  on public.hq_ai_schedule_runs (schedule_id, fired_at desc);

alter table public.hq_ai_schedule_runs enable row level security;

-- Append-only: reject UPDATE/DELETE even under service-role.
create or replace function public.hq_ai_schedule_runs_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'hq_ai_schedule_runs is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists hq_ai_schedule_runs_no_update on public.hq_ai_schedule_runs;
create trigger hq_ai_schedule_runs_no_update
  before update on public.hq_ai_schedule_runs
  for each row execute function public.hq_ai_schedule_runs_block_mutation();

drop trigger if exists hq_ai_schedule_runs_no_delete on public.hq_ai_schedule_runs;
create trigger hq_ai_schedule_runs_no_delete
  before delete on public.hq_ai_schedule_runs
  for each row execute function public.hq_ai_schedule_runs_block_mutation();

-- ===========================================================================
-- 3. Seed the registry with the existing HQ cadences — DARK.
--
-- The initial cadences are the HQ / AI-employee safety-net drains: the
-- minute→quarter-hour clocks that keep the internal AI operating system draining
-- its work queues. cron_expr matches the live vercel.json entry for each, so an
-- enabled cadence fires on the SAME clock the legacy cron already runs on. Every
-- row is enabled=false with next_run_at NULL — the whole layer is inert until a
-- super-admin opts a cadence in. Idempotent: on conflict (cadence_key) do
-- nothing, so re-applying never disturbs an operator's live state.
-- ===========================================================================
insert into public.hq_ai_schedules (cadence_key, cron_expr, enabled, description)
values
  ('research-drain',              '*/5 * * * *',  false, 'HQ Research AI — drain enqueued-but-unkicked research tasks through the Task Engine.'),
  ('qualification-drain',         '*/5 * * * *',  false, 'HQ Lead Qualification AI — drain enqueued-but-unkicked qualification tasks.'),
  ('outreach-drain',              '*/5 * * * *',  false, 'HQ Outreach AI — drain enqueued-but-unkicked outreach drafts (execution stays locked).'),
  ('notifications-drain',         '*/15 * * * *', false, 'Notification email drain — dispatch queued notification emails and prune old rows.'),
  ('automation-schedules-drain',  '* * * * *',    false, 'Automation OS — fire every due org-scoped automation schedule through the dispatcher.')
on conflict (cadence_key) do nothing;

comment on table public.hq_ai_schedules is
  'CrewFlow HQ operating-model cadence clock (OS Vol XIV / census O1) — the schedule registry that unifies the hand-rolled HQ cron cadences into one data-driven clock. RLS:hq, service-role only, HQ-global (no tenant column). DARK by default (enabled=false); the deterministic tick (/api/cron/hq-cadence-tick) routes an enabled cadence to its EXISTING HQ authority. Additive: legacy crons keep firing unchanged.';
comment on table public.hq_ai_schedule_runs is
  'Append-only run-log for the HQ cadence clock — one immutable row per fired occurrence. UPDATE/DELETE rejected even under service-role.';
