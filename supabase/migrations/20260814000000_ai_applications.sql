-- Directive #016 (Live Executor Rollout, D-06) — R3: the durable application store.
--
-- R1 composed the executor shadow into the runner's autonomous branch (default-off);
-- R2 gave the shadow observation a first-class durable home
-- (`hq_ai_executor_shadow_observations`, `kind = 'executor_shadow'`) — an OBSERVER, no
-- applied effect recorded. R3 turns the autonomous branch into a controlled LIVE apply:
-- behind a default-off kill-switch the runtime crosses the executor boundary and records
-- what it APPLIED. This migration is that record's durable home — the "applied" marker
-- ADR 0009 (increment C3) authored as a pure contract (`server/sdk/application.ts`) and
-- ADR 0011 Decision 4 promoted to a real table beside `hq_approvals`.
--
-- THE THREE-WAY DISTINCTION THE ROLLOUT PRESERVES — planned · shadow-observed · applied.
-- `planned` is the executor's pure plan; `shadow-observed` is the R2 shadow row
-- (`planned` / `refused` / `error`); `applied` is THIS record — an `applied` / `failed`
-- fact, written ONLY by a real apply that crossed the boundary. The two stores are kept
-- structurally apart:
--
--   THE SHADOW ISOLATION RULE (Kernel Contract Map §2, the thirty-first standard).
--   "Shadow-execution data must remain structurally isolated from real application data
--   and must never be query-compatible with it, unless a reviewed rollout phase
--   explicitly converts a shadow record into an applied one." This table is the real side
--   of that isolation: a SEPARATE table from `hq_ai_executor_shadow_observations`, keyed
--   differently (by the deterministic idempotency key, not a synthetic id), and drawing
--   its `status` from a DISJOINT vocabulary (`applied` / `failed`, never
--   `planned` / `refused` / `error`). No query can silently read a shadow row as an
--   applied one or vice-versa — the shapes do not overlap.
--
-- THE APPLICATION ATOMICITY RULE (Kernel Contract Map §2) — a failure NEVER records as
-- applied. Enforced three independent ways: (1) a `status` CHECK drawn from the two
-- literals only; (2) a shape CHECK that makes an `applied` row carry no `error`/`escalated`
-- and a `failed` row carry no `result`; (3) an APPLIED-TERMINAL guard trigger — once a row
-- is `applied` it is immutable (a later apply attempt can only progress a `failed` row),
-- and no row is ever deleted, so the idempotency ground truth can never be rewritten to
-- imply a side effect that did not occur, nor un-recorded to permit a double apply.
--
-- THE EXECUTOR IDEMPOTENCY RULE (Kernel Contract Map §2; ADR 0009 Decision 6) — one row
-- per deterministic idempotency key (`idempotency_key` PRIMARY KEY). `applyOnce`
-- (`server/sdk/application.ts`) consults `hq_get_application` BEFORE crossing the boundary
-- and files the outcome under `hq_put_application` after — so a retry re-applies nothing.
--
-- Provably additive (P2): a brand-new table + two functions, no tenant table touched, no
-- producer wired by this migration (the runner wires the store behind the default-off
-- `CREWFLOW_EXECUTOR_LIVE` kill-switch in TypeScript). Hardening mirrors the HQ Event
-- Spine and the R2 shadow store: RLS:hq (enabled, zero policies), SECURITY DEFINER write
-- primitives with `set search_path = ''`, EXECUTE revoked from anon/authenticated and
-- granted only to service_role.

-- ---------------------------------------------------------------------------
-- 1. hq_ai_applications — the "applied" marker, beside hq_approvals. RLS:hq.
--    One row per idempotency key (the Executor Idempotency Rule). `status` is the
--    application's OWN vocabulary (`applied` / `failed`) — DISJOINT from the shadow
--    store's (`planned` / `refused` / `error`), so a shadow row and an applied row are
--    never query-compatible (the Shadow Isolation Rule). The discriminated shape is
--    pinned by CHECKs so a `failed` row can never masquerade as `applied` (the
--    Application Atomicity Rule).
-- ---------------------------------------------------------------------------
create table if not exists public.hq_ai_applications (
  -- The deterministic idempotency key (`deriveIdempotencyKey`) — the primary key, so
  -- there is exactly ONE application record per execution identity.
  idempotency_key text        primary key,
  -- The application's own vocabulary — NEVER an approval state, NEVER a shadow outcome.
  status          text        not null check (status in ('applied','failed')),
  -- The execution identity the key derived from (the discriminated `ExecutionIdentity`),
  -- carried whole for audit and a future out-of-band sweep's queries. `source` is one of
  -- the two apply paths; R3 writes `autonomous` only, but the store serves both.
  identity        jsonb       not null
                              check (identity->>'source' in ('autonomous','approval')),
  -- The registered tool's label that was applied (from the ExecutionOutcome).
  label           text        not null,
  -- How many times application has been ATTEMPTED, including the attempt this row captures.
  attempts        integer     not null check (attempts >= 1),
  -- The human approver attributed (approval path), or null (autonomous/system path).
  approver        jsonb,
  -- The implementation's result (`applied` only), else null.
  result          jsonb,
  -- The captured failure message (`failed` only), else null.
  error           text,
  -- true once `attempts` reached the retry ceiling — escalated, not silently dropped
  -- (`failed` only), else null.
  escalated       boolean,
  -- When the row was first recorded, and when it was last upserted (a failed→failed /
  -- failed→applied retry). Assigned by the store, not the pure record builder.
  recorded_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- The discriminated shape, in DDL: an `applied` row carries a result and NO failure
  -- fields; a `failed` row carries error+escalated and NO result. A failure can therefore
  -- never be stored in the shape of an applied effect (the Application Atomicity Rule).
  constraint hq_ai_applications_shape check (
    (status = 'applied' and error is null and escalated is null)
    or
    (status = 'failed'  and error is not null and escalated is not null and result is null)
  )
);

-- The identity's threading fields, indexed for a future cut-over / out-of-band sweep that
-- reconciles applied rows against the run and task they belong to.
create index if not exists hq_ai_applications_correlation_idx
  on public.hq_ai_applications ((identity->>'correlationId'));
create index if not exists hq_ai_applications_task_idx
  on public.hq_ai_applications ((identity->>'taskId'));

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) writes; every JWT client
-- (anon/authenticated) is denied. No table grant can open it — RLS denies the rows.
alter table public.hq_ai_applications enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Applied-terminal guard — an `applied` row is the idempotency ground truth: terminal
--    and immutable. A retry may only progress a `failed` row (failed→failed with more
--    attempts, or failed→applied on success); an `applied` row can never be updated, and
--    NO row is ever deleted. This is the Application Atomicity Rule made defence-in-depth:
--    a recorded apply can never be rewritten to un-happen, nor a failure be mutated to
--    resemble an apply. Mirrors the R2 shadow store's append-only guard, relaxed only to
--    permit a failed row's bounded retry.
-- ---------------------------------------------------------------------------
create or replace function public.hq_ai_applications_guard_terminal()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'hq_ai_applications is the idempotency ground truth; DELETE of % is not permitted',
      old.idempotency_key
      using errcode = 'restrict_violation';
  end if;
  -- UPDATE: an APPLIED row is terminal and immutable. Only a FAILED row may be progressed.
  if old.status = 'applied' then
    raise exception
      'hq_ai_applications: % is already applied (terminal, immutable); UPDATE rejected',
      old.idempotency_key
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists hq_ai_applications_no_delete on public.hq_ai_applications;
create trigger hq_ai_applications_no_delete
  before delete on public.hq_ai_applications
  for each row execute function public.hq_ai_applications_guard_terminal();

drop trigger if exists hq_ai_applications_applied_terminal on public.hq_ai_applications;
create trigger hq_ai_applications_applied_terminal
  before update on public.hq_ai_applications
  for each row execute function public.hq_ai_applications_guard_terminal();

-- ---------------------------------------------------------------------------
-- 3. hq_get_application — the record filed under a key, or null. SECURITY DEFINER,
--    service_role-only. Returns the row as jsonb (or null when absent) — the no-op-success
--    lookup `applyOnce` consults BEFORE crossing the boundary.
-- ---------------------------------------------------------------------------
create or replace function public.hq_get_application(p_key text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select to_jsonb(a) from public.hq_ai_applications a where a.idempotency_key = p_key;
$$;

-- ---------------------------------------------------------------------------
-- 4. hq_put_application — insert-or-progress one application record. SECURITY DEFINER,
--    service_role-only. Inserts a new record, or upserts under an existing key; the
--    applied-terminal guard (§2) rejects any upsert onto an already-applied row, so a
--    double apply can never overwrite the ground truth. Returns the key on success (a
--    non-null value the service layer checks for).
-- ---------------------------------------------------------------------------
create or replace function public.hq_put_application(
  p_key       text,
  p_status    text,
  p_identity  jsonb,
  p_label     text,
  p_attempts  integer,
  p_approver  jsonb    default null,
  p_result    jsonb    default null,
  p_error     text     default null,
  p_escalated boolean  default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.hq_ai_applications (
    idempotency_key, status, identity, label, attempts, approver, result, error, escalated
  ) values (
    p_key, p_status, p_identity, p_label, p_attempts, p_approver, p_result, p_error, p_escalated
  )
  on conflict (idempotency_key) do update set
    status     = excluded.status,
    identity   = excluded.identity,
    label      = excluded.label,
    attempts   = excluded.attempts,
    approver   = excluded.approver,
    result     = excluded.result,
    error      = excluded.error,
    escalated  = excluded.escalated,
    updated_at = now();
  return p_key;
end;
$$;

revoke all on function public.hq_get_application(text)
  from public, anon, authenticated;
grant execute on function public.hq_get_application(text)
  to service_role;

revoke all on function public.hq_put_application(
  text, text, jsonb, text, integer, jsonb, jsonb, text, boolean
) from public, anon, authenticated;
grant execute on function public.hq_put_application(
  text, text, jsonb, text, integer, jsonb, jsonb, text, boolean
) to service_role;
