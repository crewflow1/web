-- CrewFlow HQ — The Product Pipeline stage, on the Generic Task Engine.
--
-- Closes an audited gap. `hq_ai_tasks.status` (20260802000000) is an EXECUTION
-- lifecycle — pending → running → completed | failed | cancelled — answering "how is
-- this worker doing?". It does NOT model the Master-Plan PRODUCT pipeline a piece of
-- work travels through: Idea → Research → Specification → Design → Engineering →
-- Testing → Documentation → Marketing → Sales → Deployment → Review. Those are two
-- ORTHOGONAL axes: a task can be status=running while pipeline_stage=engineering, then
-- status=completed with pipeline_stage unchanged. This migration adds the missing
-- product axis as an inert, additive column plus an append-only transition log — it
-- changes no existing behaviour and leaves every existing row valid.
--
-- ───────────────────────────────────────────────────────────────────────────
-- What this migration reuses, and the ONE thing it adds
-- ───────────────────────────────────────────────────────────────────────────
-- It reuses the hq_decisions (20261091000000) child-table idiom wholesale:
--   • RLS:hq — RLS ENABLED, ZERO policies. service_role (BYPASSRLS) reaches the child;
--     every JWT client (anon/authenticated) is denied. HQ infrastructure is never
--     tenant-visible.
--   • The stage history is APPEND-ONLY and IMMUTABLE, enforced by block-mutation
--     triggers that reject UPDATE and DELETE even under service-role — the exact
--     mechanism hq_decision_events uses (20261091000000 §2) and hq_events before it.
--   • Every stage transition appends exactly one immutable row via an AFTER trigger in
--     the SAME transaction as the change (transactional outbox — mirrors
--     hq_decisions_emit).
--
-- ───────────────────────────────────────────────────────────────────────────
-- Why the existing guard needs NO widening
-- ───────────────────────────────────────────────────────────────────────────
-- The engine's BEFORE guard (hq_ai_tasks_guard, 20260802000000 §2) enforces two
-- things on UPDATE: (b) a fixed set of IDENTITY columns are write-once (task_type,
-- subject_kind, subject_id, payload, parent_task_id, depends_on, correlation_id,
-- dedupe_key, origin, created_by, created_at), and (c) only legal status transitions —
-- and it explicitly ALLOWS a same-status update (the checkpoint/heartbeat move).
-- pipeline_stage is neither in the write-once set nor a status column, so setting it on
-- a non-terminal row is already a legal same-status update the guard passes untouched.
-- Terminal rows stay frozen (guard §a) — a completed task's product stage is part of
-- the permanent record. So the guard is NOT redefined here: widening it would enlarge
-- the blast radius for zero benefit. The sanctioned write path is a new SECURITY
-- DEFINER function (hq_ai_task_set_stage) below, in keeping with the engine's
-- function-entry-point design; raw .from('hq_ai_tasks').update() stays forbidden by the
-- task-engine-spine security test exactly as before.
--
-- Additive + idempotent throughout (add-column-if-not-exists, create-if-not-exists,
-- guarded triggers): applying this migration touches no tenant table, forces no
-- existing row to a stage, and changes no existing behaviour.

-- ===========================================================================
-- 1. hq_ai_tasks.pipeline_stage — the PRODUCT axis (nullable, additive).
--
-- NULLABLE and un-defaulted BY DESIGN: every existing row stays valid with a null
-- stage (a task that predates the pipeline, or was never staged). The CHECK admits
-- exactly the eleven Master-Plan stages, or null.
-- ===========================================================================
alter table public.hq_ai_tasks
  add column if not exists pipeline_stage text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'hq_ai_tasks_pipeline_stage_check'
  ) then
    alter table public.hq_ai_tasks
      add constraint hq_ai_tasks_pipeline_stage_check
      check (pipeline_stage is null or pipeline_stage in (
        'idea','research','specification','design','engineering','testing',
        'documentation','marketing','sales','deployment','review'
      ));
  end if;
end;
$$;

comment on column public.hq_ai_tasks.pipeline_stage is
  'The Master-Plan PRODUCT pipeline stage (idea…review) — orthogonal to the EXECUTION status. Nullable: an unstaged task is valid. Moved only via hq_ai_task_set_stage(); every change appends to hq_ai_task_stage_events.';

-- The boardroom reads active tasks by employee + stage; index the staged rows.
create index if not exists hq_ai_tasks_pipeline_stage_idx
  on public.hq_ai_tasks (pipeline_stage)
  where pipeline_stage is not null;

-- ===========================================================================
-- 2. hq_ai_task_stage_events — the immutable, append-only stage history.
--
-- One row per stage transition (the first stamp + each subsequent move). Stored
-- forever: block-mutation triggers reject UPDATE and DELETE even under service-role,
-- exactly as hq_decision_events guards the Decision Centre. The parent row carries the
-- LIVE stage; this child is the permanent record of how it got there.
-- ===========================================================================
create table if not exists public.hq_ai_task_stage_events (
  id           uuid        primary key default gen_random_uuid(),
  task_id      uuid        not null references public.hq_ai_tasks(id) on delete restrict,

  -- The transition: from_stage is null at the first stamp; to_stage is the stage the
  -- task moved INTO (never null — a stage is never "un-set", only advanced/changed).
  from_stage   text,
  to_stage     text        not null
                 check (to_stage in (
                   'idea','research','specification','design','engineering','testing',
                   'documentation','marketing','sales','deployment','review'
                 )),

  -- The EXECUTION status at the moment of the transition, and the task_type —
  -- denormalised so the stage history reads standalone without joining the live row.
  status       text        not null,
  task_type    text        not null,

  created_at   timestamptz not null default now()
);

create index if not exists hq_ai_task_stage_events_task_idx
  on public.hq_ai_task_stage_events (task_id, created_at);

-- RLS:hq — enable, NO policies. service_role (BYPASSRLS) reaches it; every JWT client
-- is denied. Stage history is HQ infrastructure; tenants never see it.
alter table public.hq_ai_task_stage_events enable row level security;

-- Append-only: reject UPDATE and DELETE even under service-role (mirrors
-- hq_decision_events_block_mutation).
create or replace function public.hq_ai_task_stage_events_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'hq_ai_task_stage_events is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists hq_ai_task_stage_events_no_update on public.hq_ai_task_stage_events;
create trigger hq_ai_task_stage_events_no_update
  before update on public.hq_ai_task_stage_events
  for each row execute function public.hq_ai_task_stage_events_block_mutation();

drop trigger if exists hq_ai_task_stage_events_no_delete on public.hq_ai_task_stage_events;
create trigger hq_ai_task_stage_events_no_delete
  before delete on public.hq_ai_task_stage_events
  for each row execute function public.hq_ai_task_stage_events_block_mutation();

-- ===========================================================================
-- 3. The history emitter — every stage change appends one immutable event.
--
-- An AFTER INSERT/UPDATE trigger that writes into the append-only child in the SAME
-- transaction as the change (transactional outbox — mirrors hq_decisions_emit). It
-- fires ONLY when pipeline_stage actually changes, so the existing create/claim/
-- complete/fail/reap paths (which never touch pipeline_stage) emit nothing and are
-- wholly unaffected. SECURITY DEFINER with a pinned empty search_path so it writes
-- through regardless of the acting role; fully schema-qualified throughout.
-- ===========================================================================
create or replace function public.hq_ai_task_stage_emit()
returns trigger
security definer
set search_path = ''
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- A task born already staged (rare — the entry points create it unstaged) records
    -- its first stamp. The common case (pipeline_stage null) writes nothing.
    if new.pipeline_stage is not null then
      insert into public.hq_ai_task_stage_events (task_id, from_stage, to_stage, status, task_type)
      values (new.id, null, new.pipeline_stage, new.status, new.task_type);
    end if;
    return new;
  end if;

  -- UPDATE: append only when the stage actually moved. A same-stage update (e.g. a
  -- checkpoint that leaves the stage put) writes no history row.
  if new.pipeline_stage is distinct from old.pipeline_stage and new.pipeline_stage is not null then
    insert into public.hq_ai_task_stage_events (task_id, from_stage, to_stage, status, task_type)
    values (new.id, old.pipeline_stage, new.pipeline_stage, new.status, new.task_type);
  end if;

  return new;
end;
$$;

revoke all on function public.hq_ai_task_stage_emit() from public, anon, authenticated;
grant execute on function public.hq_ai_task_stage_emit() to service_role;

drop trigger if exists hq_ai_task_stage_emit_ins on public.hq_ai_tasks;
create trigger hq_ai_task_stage_emit_ins
  after insert on public.hq_ai_tasks
  for each row execute function public.hq_ai_task_stage_emit();

drop trigger if exists hq_ai_task_stage_emit_upd on public.hq_ai_tasks;
create trigger hq_ai_task_stage_emit_upd
  after update on public.hq_ai_tasks
  for each row execute function public.hq_ai_task_stage_emit();

-- ===========================================================================
-- 4. hq_ai_task_set_stage — the sanctioned stage-mover (the ONE write path).
--
-- Mirrors the engine's function-entry-point design (Volume XII §11.1): the product
-- stage is moved ONLY through this SECURITY DEFINER function, never a raw UPDATE.
-- Non-lease-guarded — a stage move is an orchestration/operator act from OUTSIDE the
-- worker (like cancel), so it carries no lease. It refuses to touch a terminal task
-- (that would trip the guard anyway; the explicit check yields a clean envelope). The
-- AFTER trigger records the transition. Returns the house {ok} envelope.
-- ===========================================================================
create or replace function public.hq_ai_task_set_stage(
  p_task_id uuid,
  p_stage   text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.hq_ai_tasks;
begin
  if p_stage is null or p_stage not in (
    'idea','research','specification','design','engineering','testing',
    'documentation','marketing','sales','deployment','review'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_stage');
  end if;

  update public.hq_ai_tasks
  set pipeline_stage = p_stage
  where id = p_task_id
    and status in ('pending','running','blocked','claimed','waiting_approval','verifying')
  returning * into v_row;

  if not found then
    -- No such task, or it is terminal (completed/failed/cancelled) and frozen.
    return jsonb_build_object('ok', false, 'reason', 'not_updatable');
  end if;

  return jsonb_build_object('ok', true, 'task', to_jsonb(v_row));
end;
$$;

revoke all on function public.hq_ai_task_set_stage(uuid, text) from public, anon, authenticated;
grant execute on function public.hq_ai_task_set_stage(uuid, text) to service_role;

comment on table public.hq_ai_task_stage_events is
  'CrewFlow HQ Task Engine — append-only, immutable PRODUCT pipeline stage history. One row per stage transition. RLS:hq, service-role only. Written exclusively by the hq_ai_task_stage_emit AFTER trigger.';
