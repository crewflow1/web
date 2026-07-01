-- Directive #016 (Live Executor Rollout, D-06) — R2: the durable executor-shadow
-- observation store.
--
-- R1 composed the executor shadow into the runner's autonomous branch (default-off)
-- and recorded what it WOULD apply as an IN-BAND fragment on the `ai.action_permitted`
-- audit event — durable on the spine, but not a first-class, queryable record, and
-- (rightly) NO application record at all. R2 gives that observation a FIRST-CLASS
-- durable home: this table and its write primitive.
--
-- THE SHADOW TRUTHFULNESS RULE (Kernel Contract Map §2, the thirtieth standard).
-- "Shadow execution must never record state that implies a real side effect occurred.
-- Shadow mode may observe, classify, plan, compare, and audit. Shadow mode must not
-- write durable application records that would be indistinguishable from real
-- execution. A shadow record must be explicitly labelled as shadow if persisted in a
-- later phase." This migration is that rule made storage:
--
--   • A SEPARATE table from any application/apply-once store — a shadow write can
--     never land where a real apply reads, so it cannot poison the idempotency ground
--     truth a later real apply depends on.
--   • An UNCONDITIONAL `kind = 'executor_shadow'` label, pinned by a CHECK and
--     hardcoded in the ONLY write function, so a row here can NEVER be mistaken for an
--     applied effect. There is deliberately no `applied` / `failed` status column —
--     the shadow's vocabulary is its own (`planned` / `refused` / `error`).
--
-- This preserves the three-way distinction the rollout must keep — planned ·
-- shadow-observed · applied. `idempotency_key` is the key a REAL apply WOULD file
-- under (carried so a future cut-over can compare a shadow-observed row to the applied
-- record keyed identically) — computed, recorded, but NEVER an apply.
--
-- Provably additive (P2): a brand-new table + function, no tenant table touched, no
-- producer wired by this migration (the runner wires the store behind the default-off
-- kill-switch in TypeScript). Hardening mirrors the HQ Event Spine
-- (20260720000000_hq_event_spine_core.sql): RLS:hq, SECURITY DEFINER write primitive,
-- EXECUTE revoked from anon/authenticated and granted only to service_role,
-- append-only guard.

-- ---------------------------------------------------------------------------
-- 1. hq_ai_executor_shadow_observations — append-only shadow facts. RLS:hq.
--    NO `applied` / `failed` status, by construction: an `outcome` drawn from the
--    shadow's OWN vocabulary, and an unconditional `kind` label CHECKed to the single
--    literal so no row here is ever indistinguishable from a real application record.
-- ---------------------------------------------------------------------------
create table if not exists public.hq_ai_executor_shadow_observations (
  id              bigint      generated always as identity primary key,
  -- The unconditional shadow label. CHECK-pinned to the single literal so this table
  -- can hold NOTHING but shadow observations (the Shadow Truthfulness Rule, in DDL).
  kind            text        not null default 'executor_shadow'
                              check (kind = 'executor_shadow'),
  -- What the shadow OBSERVED — its own vocabulary, never an application status.
  outcome         text        not null check (outcome in ('planned','refused','error')),
  -- The apply path shadowed. R2: `autonomous` only (the approval path is not shadowed).
  source          text        not null check (source = 'autonomous'),
  -- The run's spine trace id — threads the observation to the originating run.
  correlation_id  uuid        not null,
  -- The originating task's id — the autonomous path is keyed by the task.
  task_id         text        not null,
  -- The action's stable identity within the run (`subjectType:subjectId:type`).
  action_id       text        not null,
  -- Populated for `planned` only (the resolved tool + the key a REAL apply WOULD use),
  -- null otherwise. The idempotency key is recorded for a future cut-over comparison —
  -- it is NEVER written to an application store here.
  tool_label      text,
  idempotency_key text,
  -- The executor's refusal reason (`refused` only), else null.
  reason          text,
  -- The refusal/error detail; empty string for `planned`.
  detail          text        not null default '',
  -- Assigned by the store, not the pure record builder (mirrors the spine's `ts`).
  observed_at     timestamptz not null default now()
);

create index if not exists hq_ai_executor_shadow_corr_idx
  on public.hq_ai_executor_shadow_observations (correlation_id);
create index if not exists hq_ai_executor_shadow_task_idx
  on public.hq_ai_executor_shadow_observations (task_id, observed_at desc);
-- The key a real apply WOULD file under — indexed so a future cut-over can find the
-- shadow-observed row that corresponds to an applied record keyed identically.
create index if not exists hq_ai_executor_shadow_idem_idx
  on public.hq_ai_executor_shadow_observations (idempotency_key)
  where idempotency_key is not null;

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) writes; every JWT client
-- (anon/authenticated) is denied. No table grant can open it — RLS denies the rows.
alter table public.hq_ai_executor_shadow_observations enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a shadow observation is a fact about one run, never
--    updated or deleted (the store is APPEND-ONLY). Reject UPDATE/DELETE even under
--    service-role, so a recorded shadow row can never be mutated to resemble
--    something it is not (defence-in-depth for the Shadow Truthfulness Rule). Mirrors
--    the spine's append-only guard.
-- ---------------------------------------------------------------------------
create or replace function public.hq_ai_executor_shadow_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'hq_ai_executor_shadow_observations is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists hq_ai_executor_shadow_no_update on public.hq_ai_executor_shadow_observations;
create trigger hq_ai_executor_shadow_no_update
  before update on public.hq_ai_executor_shadow_observations
  for each row execute function public.hq_ai_executor_shadow_block_mutation();

drop trigger if exists hq_ai_executor_shadow_no_delete on public.hq_ai_executor_shadow_observations;
create trigger hq_ai_executor_shadow_no_delete
  before delete on public.hq_ai_executor_shadow_observations
  for each row execute function public.hq_ai_executor_shadow_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. hq_record_executor_shadow — the single validated write entry point.
--    SECURITY DEFINER, service_role-only (EXECUTE revoked from PUBLIC, anon,
--    authenticated). The `kind` label is HARDCODED to 'executor_shadow' here — there
--    is no `p_kind` parameter, so this function can write NOTHING but a shadow row.
--    Together with the column CHECK that is two independent guarantees that a row in
--    this table is explicitly, unforgeably labelled as shadow. Returns the new id.
-- ---------------------------------------------------------------------------
create or replace function public.hq_record_executor_shadow(
  p_outcome         text,
  p_source          text,
  p_correlation_id  uuid,
  p_task_id         text,
  p_action_id       text,
  p_tool_label      text default null,
  p_idempotency_key text default null,
  p_reason          text default null,
  p_detail          text default ''
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.hq_ai_executor_shadow_observations (
    kind, outcome, source, correlation_id, task_id, action_id,
    tool_label, idempotency_key, reason, detail
  ) values (
    -- HARDCODED: the write path cannot emit any other kind (the Shadow Truthfulness Rule).
    'executor_shadow', p_outcome, p_source, p_correlation_id, p_task_id, p_action_id,
    p_tool_label, p_idempotency_key, p_reason, coalesce(p_detail, '')
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.hq_record_executor_shadow(
  text, text, uuid, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.hq_record_executor_shadow(
  text, text, uuid, text, text, text, text, text, text
) to service_role;
