-- CrewFlow HQ — The Workflow-Saga foundation (the cross-department task GRAPH).
--
-- The one genuinely-missing mechanism in the internal AI operating system. The Task
-- Engine (hq_ai_tasks, 20260802000000) runs ONE unit of work through an execution
-- lifecycle. The Decision Centre (hq_decisions, 20261091000000) records ONE strategic
-- judgement. Neither models the shape a real directive takes: a SAGA — an ordered,
-- dependency-linked GRAPH of steps that fans out across departments, where each step
-- maps to (or creates) a single hq_ai_tasks row. A saga sits ABOVE tasks; it is the
-- decomposition of a directive into work, and the durable record of how that work is
-- progressing.
--
-- ───────────────────────────────────────────────────────────────────────────
-- What this migration reuses, and the ONE thing it adds
-- ───────────────────────────────────────────────────────────────────────────
-- It reuses the hq_decisions / hq_ai_task_pipeline child-table idiom wholesale:
--   • RLS:hq — RLS ENABLED, ZERO policies. service_role (BYPASSRLS) reaches the tables;
--     every JWT client (anon/authenticated) is denied. HQ infrastructure is never
--     tenant-visible; the request-path super-admin gate (server/auth/hq.ts) is the only
--     door, because "super-admin" is an ENV allowlist, not a DB role (#456: HQ-global
--     admin data only — a saga carries NO org_id and never blends tenant orgs).
--   • Provenance is write-once and the lifecycle timestamps are auto-stamped by a BEFORE
--     guard no caller can bypass — not even the service-role admin client that BYPASSES
--     RLS — the same lesson hq_decisions and the Task Engine both learned.
--   • The saga/step history is APPEND-ONLY and IMMUTABLE, enforced by block-mutation
--     triggers that reject UPDATE and DELETE even under service-role — the exact
--     mechanism hq_decision_events (20261091000000 §2) and hq_ai_task_stage_events
--     (20261094000000 §2) use, and hq_events before them.
--   • Every status transition appends exactly one immutable row via an AFTER trigger in
--     the SAME transaction as the change (transactional outbox — mirrors
--     hq_decisions_emit / hq_ai_task_stage_emit).
--
-- The saga → step → task relationship:
--   • a saga OPTIONALLY links a hq_decisions row (the directive it decomposes);
--   • a step OPTIONALLY links a hq_ai_tasks row (the unit of work it maps to) — the link
--     is set when the step is ADVANCED through the sanctioned Task-Engine entry point
--     (hq_ai_task_create), never by a bare insert into hq_ai_tasks (the Task-Engine spine
--     security test forbids that, and this migration adds no new hq_ai_tasks write path);
--   • a step OPTIONALLY depends on ONE earlier step in the same saga, by ordinal — the
--     graph edge. Cross-step acyclicity of the whole graph is a property of the
--     deterministic templates (lib/hq/workflow) and is validated in the pure model; the
--     DB pins the local invariants a CHECK can express (no self-dependency, unique
--     ordinal per saga).
--
-- Additive + idempotent throughout (create-if-not-exists, guarded triggers): applying
-- this migration touches no tenant table and changes no existing behaviour.

-- ===========================================================================
-- 1. hq_workflow_sagas — the live state of every decomposed directive.
-- ===========================================================================
create table if not exists public.hq_workflow_sagas (
  id            uuid        primary key default gen_random_uuid(),

  -- The directive this saga decomposes, if any. ON DELETE SET NULL so a saga
  -- survives the erasure of its source decision (the same GDPR-safe posture the
  -- Decision Centre takes with its user FKs).
  decision_id   uuid        references public.hq_decisions(id) on delete set null,

  title         text        not null,

  -- The deterministic decomposition template that produced this saga's step
  -- graph, for provenance (which shape was applied). Nullable: an AI-decomposed
  -- saga, once that seam is armed, carries no template.
  template_key  text,

  -- The deterministic state. Born 'planned'; the guard enforces the CHECK.
  status        text        not null default 'planned'
                  check (status in ('planned','running','blocked','done','abandoned')),

  -- Provenance. created_by is the super-admin who raised the saga (nullable so the
  -- row survives a user delete); write-once after insert.
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists hq_workflow_sagas_status_idx
  on public.hq_workflow_sagas (status, created_at desc);
create index if not exists hq_workflow_sagas_decision_idx
  on public.hq_workflow_sagas (decision_id)
  where decision_id is not null;

-- RLS:hq — enable, NO policies. service_role (BYPASSRLS) reaches it; every JWT
-- client is denied. Sagas are HQ infrastructure; tenants never see them.
alter table public.hq_workflow_sagas enable row level security;

-- ===========================================================================
-- 2. hq_saga_steps — the ordered, dependency-linked steps of a saga.
-- ===========================================================================
create table if not exists public.hq_saga_steps (
  id             uuid        primary key default gen_random_uuid(),
  saga_id        uuid        not null references public.hq_workflow_sagas(id) on delete cascade,

  -- Position in the saga, 1-based. Unique per saga (see the constraint below).
  ordinal        integer     not null check (ordinal >= 1),

  title          text        not null,

  -- The cross-department axis: which department/role owns this step. Free text
  -- rather than an enum — the roster (lib/hq) evolves faster than a migration.
  department     text,
  role           text,

  -- The graph edge: this step depends on ONE earlier step in the SAME saga, by
  -- its ordinal. Null ⇒ a root step. A step can never depend on itself; a full
  -- acyclicity guarantee across the graph is enforced in the pure model, since a
  -- CHECK cannot express reachability.
  depends_on_ordinal integer check (depends_on_ordinal is null or depends_on_ordinal >= 1),

  -- The unit of work this step maps to, once advanced. Set ONLY via the service's
  -- Task-Engine call (hq_ai_task_create); ON DELETE SET NULL so a reaped task does
  -- not orphan the step. Null ⇒ the step has not been dispatched yet.
  hq_ai_task_id  uuid        references public.hq_ai_tasks(id) on delete set null,

  -- The deterministic step state. Reflects the REAL task state once linked; the
  -- service never fabricates progress. Born 'pending'.
  status         text        not null default 'pending'
                   check (status in ('pending','running','blocked','done','skipped','failed')),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- One step per ordinal per saga, and no self-dependency.
  constraint hq_saga_steps_unique_ordinal unique (saga_id, ordinal),
  constraint hq_saga_steps_no_self_dep check (depends_on_ordinal is distinct from ordinal)
);

create index if not exists hq_saga_steps_saga_idx
  on public.hq_saga_steps (saga_id, ordinal);
create index if not exists hq_saga_steps_task_idx
  on public.hq_saga_steps (hq_ai_task_id)
  where hq_ai_task_id is not null;

alter table public.hq_saga_steps enable row level security;

-- ===========================================================================
-- 3. hq_saga_events — the immutable, append-only saga/step history.
--
-- One row per transition: a saga born, a step born, a saga status change, a step
-- status change, a step linked to a task. Stored forever: block-mutation triggers
-- reject UPDATE and DELETE even under service-role, exactly as hq_decision_events
-- and hq_ai_task_stage_events guard their logs. The parent rows carry the LIVE
-- state; this child is the permanent record of how they got there.
-- ===========================================================================
create table if not exists public.hq_saga_events (
  id           uuid        primary key default gen_random_uuid(),
  saga_id      uuid        not null references public.hq_workflow_sagas(id) on delete restrict,
  -- Null for saga-level events; set for step-level events. No FK to the step (a
  -- step is ON DELETE CASCADE from its saga, and this log outlives the step) —
  -- the id is denormalised so the history reads standalone.
  step_id      uuid,

  -- The transition this row records.
  event_type   text        not null
                 check (event_type in (
                   'saga_created','saga_status','step_created','step_status','step_linked'
                 )),
  from_status  text,
  to_status    text,

  -- WHO acted (the super-admin), denormalised so the history survives the account.
  actor_id     uuid,
  actor_email  text,
  -- Optional structured context (e.g. the linked task id, the template key).
  detail       jsonb       not null default '{}'::jsonb,

  created_at   timestamptz not null default now()
);

create index if not exists hq_saga_events_saga_idx
  on public.hq_saga_events (saga_id, created_at);

alter table public.hq_saga_events enable row level security;

-- Append-only: reject UPDATE/DELETE even under service-role.
create or replace function public.hq_saga_events_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'hq_saga_events is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists hq_saga_events_no_update on public.hq_saga_events;
create trigger hq_saga_events_no_update
  before update on public.hq_saga_events
  for each row execute function public.hq_saga_events_block_mutation();

drop trigger if exists hq_saga_events_no_delete on public.hq_saga_events;
create trigger hq_saga_events_no_delete
  before delete on public.hq_saga_events
  for each row execute function public.hq_saga_events_block_mutation();

-- ===========================================================================
-- 4. The guards — write-once provenance + deterministic timestamps.
--
-- BEFORE INSERT/UPDATE triggers no caller can bypass. They make provenance
-- write-once and auto-stamp updated_at so the timestamp can never be forgotten
-- or faked. Legal transitions are left to the service's deterministic state
-- machine (lib/hq/workflow) — the CHECK constraints already bound the status
-- vocabulary, and a saga, unlike a decision, is a re-plannable working object
-- rather than a frozen-on-decide record.
-- ===========================================================================
create or replace function public.hq_workflow_sagas_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.updated_at := now();
    return new;
  end if;
  -- Provenance is write-once — who raised it and when can never be rewritten.
  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'hq_workflow_sagas %: created_by / created_at are write-once', old.id
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists hq_workflow_sagas_guard_ins on public.hq_workflow_sagas;
create trigger hq_workflow_sagas_guard_ins
  before insert on public.hq_workflow_sagas
  for each row execute function public.hq_workflow_sagas_guard();

drop trigger if exists hq_workflow_sagas_guard_upd on public.hq_workflow_sagas;
create trigger hq_workflow_sagas_guard_upd
  before update on public.hq_workflow_sagas
  for each row execute function public.hq_workflow_sagas_guard();

create or replace function public.hq_saga_steps_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.updated_at := now();
    return new;
  end if;
  -- The step's identity within its saga is write-once — saga_id and ordinal
  -- pin its place in the graph and can never move under it.
  if new.saga_id is distinct from old.saga_id
     or new.ordinal is distinct from old.ordinal
     or new.created_at is distinct from old.created_at then
    raise exception 'hq_saga_steps %: saga_id / ordinal / created_at are write-once', old.id
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists hq_saga_steps_guard_ins on public.hq_saga_steps;
create trigger hq_saga_steps_guard_ins
  before insert on public.hq_saga_steps
  for each row execute function public.hq_saga_steps_guard();

drop trigger if exists hq_saga_steps_guard_upd on public.hq_saga_steps;
create trigger hq_saga_steps_guard_upd
  before update on public.hq_saga_steps
  for each row execute function public.hq_saga_steps_guard();

-- ===========================================================================
-- 5. The history emitters — every transition appends one immutable event.
--
-- AFTER INSERT/UPDATE triggers that write into the append-only child in the SAME
-- transaction as the change (transactional outbox — mirrors hq_decisions_emit).
-- SECURITY DEFINER with a pinned empty search_path so they write through
-- regardless of the acting role; fully schema-qualified throughout. Each fires
-- only on a REAL change, so a no-op update writes no history row.
-- ===========================================================================
create or replace function public.hq_workflow_sagas_emit()
returns trigger
security definer
set search_path = ''
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.hq_saga_events (saga_id, step_id, event_type, from_status, to_status, actor_id, detail)
    values (new.id, null, 'saga_created', null, new.status, new.created_by,
            jsonb_build_object('title', new.title, 'template_key', new.template_key));
    return new;
  end if;
  if new.status is distinct from old.status then
    insert into public.hq_saga_events (saga_id, step_id, event_type, from_status, to_status, actor_id)
    values (new.id, null, 'saga_status', old.status, new.status, new.created_by);
  end if;
  return new;
end;
$$;

revoke all on function public.hq_workflow_sagas_emit() from public, anon, authenticated;
grant execute on function public.hq_workflow_sagas_emit() to service_role;

drop trigger if exists hq_workflow_sagas_emit_ins on public.hq_workflow_sagas;
create trigger hq_workflow_sagas_emit_ins
  after insert on public.hq_workflow_sagas
  for each row execute function public.hq_workflow_sagas_emit();

drop trigger if exists hq_workflow_sagas_emit_upd on public.hq_workflow_sagas;
create trigger hq_workflow_sagas_emit_upd
  after update on public.hq_workflow_sagas
  for each row execute function public.hq_workflow_sagas_emit();

create or replace function public.hq_saga_steps_emit()
returns trigger
security definer
set search_path = ''
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.hq_saga_events (saga_id, step_id, event_type, from_status, to_status, detail)
    values (new.saga_id, new.id, 'step_created', null, new.status,
            jsonb_build_object('ordinal', new.ordinal, 'title', new.title,
                               'department', new.department, 'role', new.role));
    return new;
  end if;
  -- A step being linked to a task (its dispatch) and a step status change are
  -- both worth recording; emit one row for each that actually happened.
  if new.hq_ai_task_id is distinct from old.hq_ai_task_id and new.hq_ai_task_id is not null then
    insert into public.hq_saga_events (saga_id, step_id, event_type, to_status, detail)
    values (new.saga_id, new.id, 'step_linked', new.status,
            jsonb_build_object('hq_ai_task_id', new.hq_ai_task_id));
  end if;
  if new.status is distinct from old.status then
    insert into public.hq_saga_events (saga_id, step_id, event_type, from_status, to_status)
    values (new.saga_id, new.id, 'step_status', old.status, new.status);
  end if;
  return new;
end;
$$;

revoke all on function public.hq_saga_steps_emit() from public, anon, authenticated;
grant execute on function public.hq_saga_steps_emit() to service_role;

drop trigger if exists hq_saga_steps_emit_ins on public.hq_saga_steps;
create trigger hq_saga_steps_emit_ins
  after insert on public.hq_saga_steps
  for each row execute function public.hq_saga_steps_emit();

drop trigger if exists hq_saga_steps_emit_upd on public.hq_saga_steps;
create trigger hq_saga_steps_emit_upd
  after update on public.hq_saga_steps
  for each row execute function public.hq_saga_steps_emit();

comment on table public.hq_workflow_sagas is
  'CrewFlow HQ Workflow-Saga foundation — a directive decomposed into a cross-department task GRAPH. RLS:hq, service-role only, HQ-global (no tenant column, never blends orgs). A saga sits ABOVE hq_ai_tasks; each hq_saga_steps row maps to at most one hq_ai_tasks row, dispatched only through the Task-Engine entry points.';
