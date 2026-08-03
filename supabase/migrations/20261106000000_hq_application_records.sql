-- CrewFlow HQ — the durable apply-on-approval record store
-- (CEO Directive #014 / D-04, Phase C, increment C3 rollout; ADR 0009 Decisions 4, 5, 6, 9;
-- Directive #016 apply-on-approval runtime; the Executor Idempotency Rule — Kernel Contract Map §2).
--
-- The executor contract (server/sdk/executor.ts) APPLIES a cleared action; the application
-- contract (server/sdk/application.ts) makes that apply happen EXACTLY ONCE and records that it
-- was applied, idempotently, under a deterministic key. That contract has shipped as a typed seam
-- with an in-memory reference (`createInMemoryApplicationStore`) — deliberately with NO physical
-- table (the executor rollout was out of C3's scope). This migration gives the "applied" marker its
-- FIRST-CLASS durable home, exactly as 20260813000000 gave the executor SHADOW a durable home —
-- so that turning apply-on-approval live becomes a CONFIG FLIP, not an engineering change.
--
-- WHAT IT IS, AND IS NOT.
--   • It IS the append-only audit of what the apply-on-approval sweep applied: which approved
--     decision/approval, the deterministic idempotency key it filed under, the outcome (applied /
--     failed), the attempt count, the escalation flag, and the human approver attributed.
--   • It is NOT a sixth approval state (ADR 0009 Decision 5). "Applied" sits BESIDE hq_approvals /
--     hq_decisions, keyed by the idempotency key, never inside their frozen state machines.
--   • It is NOT the authority to apply. This table records that an apply happened; the AUTHORITY to
--     cross into real tenant data stays a CEO gate (ADR 0009). Even with the runtime's kill-switch
--     ON, the sweep applies only through an existing sanctioned authority (the executor's
--     SECURITY DEFINER boundary / the task engine) whose live binding is the CEO cut-over — never a
--     bare write from this layer.
--
-- IDEMPOTENT BY A DETERMINISTIC KEY (the Executor Idempotency Rule; ADR 0009 Decision 6). The
-- natural key is `key` (server/sdk/application.ts `deriveIdempotencyKey`): same execution identity →
-- same key, always. The store is APPEND-ONLY (each attempt writes a new row; UPDATE/DELETE are
-- blocked even under service-role), so the audit is complete; the LIVE state for the apply-once
-- guard is the LATEST row under a key (`get(key)` reads it, id-desc). A prior `applied` row makes a
-- re-run a no-op success; a prior `escalated` failure stops the auto-retry. Two rows can therefore
-- share a `key` — that is the attempt history, not a violation — so there is deliberately NO unique
-- constraint on `key`.
--
-- HQ-GLOBAL SCOPING, consistent with every other hq_* table. HQ has no tenant org: this is HQ
-- infrastructure, not tenant data, so there is no org_id to pin (the #456 org/HQ-pinned rule is
-- satisfied by being HQ-global with RLS:hq, exactly as hq_approvals / hq_decisions /
-- hq_ai_executor_shadow_observations are). RLS ENABLED, ZERO policies: service_role (BYPASSRLS)
-- writes through the SECURITY DEFINER function; every JWT client (anon/authenticated) is denied.
--
-- Provably additive (P2): a brand-new table + function, no tenant table touched, no producer wired
-- by this migration (the runtime wires the store behind the default-off kill-switch in TypeScript).
-- Hardening mirrors 20260813000000 (the executor-shadow store) and the HQ Event Spine: RLS:hq, a
-- SECURITY DEFINER write primitive with EXECUTE revoked from anon/authenticated and granted only to
-- service_role, and an append-only guard.

-- ---------------------------------------------------------------------------
-- 1. hq_application_records — append-only "applied" markers. RLS:hq.
--    A discriminated applied/failed marker (server/sdk/application.ts ApplicationRecord), filed
--    under the deterministic idempotency `key`. `status` is CHECKed to the application vocabulary
--    ('applied','failed') — never a shadow outcome, so this table is structurally distinct from the
--    shadow store and cannot be confused with it.
-- ---------------------------------------------------------------------------
create table if not exists public.hq_application_records (
  id              bigint      generated always as identity primary key,

  -- The deterministic idempotency key this record is filed under (deriveIdempotencyKey). The
  -- apply-once guard reads the LATEST row under this key; the attempt history keeps the rest.
  key             text        not null,

  -- The application outcome — the application's OWN vocabulary, never a shadow outcome.
  status          text        not null check (status in ('applied','failed')),

  -- The execution identity the key derived from (ExecutionIdentity), carried for audit + the
  -- sweep's queries. `source` is the apply path; the out-of-band apply-on-approval sweep is
  -- 'approval'. 'autonomous' is admitted for the inline path so the two never need separate stores.
  source          text        not null check (source in ('autonomous','approval')),
  correlation_id  text        not null,
  -- The originating task id (autonomous path) OR null; the approved item id (approval path).
  task_id         text,
  approval_id     text,
  tool_label      text        not null,
  action_id       text        not null,

  -- How many times application has been ATTEMPTED, including the attempt this row captures.
  attempts        integer     not null default 1 check (attempts >= 1),
  -- `true` on a failed row once the retry ceiling was reached — escalated, not silently dropped.
  escalated       boolean     not null default false,

  -- The human approver attributed (approval path), else null (autonomous/system path).
  approver_id     text,
  approver_email  text,

  -- The applied result (status='applied' only) / the failure message (status='failed' only).
  result          jsonb,
  error           text,

  -- Assigned by the store, not the pure record builder (mirrors the shadow store's observed_at and
  -- appliedRecord carrying no timestamp).
  applied_at      timestamptz not null default now(),

  -- Vocabulary integrity: an applied row carries no error; a failed row carries an error and cannot
  -- be silently marked escalated without being failed. (result is optional — an apply may return
  -- nothing.)
  constraint hq_application_records_status_shape check (
    (status = 'applied' and error is null)
    or (status = 'failed' and error is not null)
  )
);

-- The apply-once lookup: the LATEST row under a key (id desc). Also the attempt history per key.
create index if not exists hq_application_records_key_idx
  on public.hq_application_records (key, id desc);
-- Observability: the apply-on-approval audit for one approved item / one run.
create index if not exists hq_application_records_approval_idx
  on public.hq_application_records (approval_id)
  where approval_id is not null;
create index if not exists hq_application_records_corr_idx
  on public.hq_application_records (correlation_id);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) writes; every JWT client
-- (anon/authenticated) is denied. No table grant can open it — RLS denies the rows.
alter table public.hq_application_records enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — an application record is a fact about one apply attempt, never updated or
--    deleted (the store is APPEND-ONLY; a re-attempt writes a NEW row under the same key). Reject
--    UPDATE/DELETE even under service-role, so a recorded apply marker can never be mutated to
--    resemble something it is not (the audit is permanent). Mirrors the shadow store + spine guards.
-- ---------------------------------------------------------------------------
create or replace function public.hq_application_records_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'hq_application_records is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists hq_application_records_no_update on public.hq_application_records;
create trigger hq_application_records_no_update
  before update on public.hq_application_records
  for each row execute function public.hq_application_records_block_mutation();

drop trigger if exists hq_application_records_no_delete on public.hq_application_records;
create trigger hq_application_records_no_delete
  before delete on public.hq_application_records
  for each row execute function public.hq_application_records_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. hq_record_application — the single validated write entry point.
--    SECURITY DEFINER, service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated).
--    The status/source CHECKs above are the second, independent guarantee that a row here is a
--    well-formed application marker. Returns the new id.
-- ---------------------------------------------------------------------------
create or replace function public.hq_record_application(
  p_key            text,
  p_status         text,
  p_source         text,
  p_correlation_id text,
  p_tool_label     text,
  p_action_id      text,
  p_task_id        text    default null,
  p_approval_id    text    default null,
  p_attempts       integer default 1,
  p_escalated      boolean default false,
  p_approver_id    text    default null,
  p_approver_email text    default null,
  p_result         jsonb   default null,
  p_error          text    default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.hq_application_records (
    key, status, source, correlation_id, task_id, approval_id, tool_label, action_id,
    attempts, escalated, approver_id, approver_email, result, error
  ) values (
    p_key, p_status, p_source, p_correlation_id, p_task_id, p_approval_id, p_tool_label, p_action_id,
    coalesce(p_attempts, 1), coalesce(p_escalated, false), p_approver_id, p_approver_email,
    p_result, p_error
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.hq_record_application(
  text, text, text, text, text, text, text, text, integer, boolean, text, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.hq_record_application(
  text, text, text, text, text, text, text, text, integer, boolean, text, text, jsonb, text
) to service_role;
