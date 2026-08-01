-- CrewFlow HQ — The Decision Centre (Master-Plan Phase 16 + the HQ Layer-5 gap).
--
-- The Approval Engine (20260730000000) answers a NARROW question: "may this one
-- proposed AI action be sent?" — approve / reject / escalate over a (subject, action)
-- triple. The Decision Centre answers a WIDER one: "which of these strategic moves
-- should the business make, and how?" — a rich, human-authored PROPOSAL (problem,
-- business & revenue impact, demand, engineering cost, risk, timeline, recommendation,
-- and a slot for a future AI-employee debate) that a super-admin resolves with the
-- FOUR outcomes the audit found missing from Layer 5:
--
--     approve · reject · DELAY (revisit after a date) · DELEGATE (assign an owner)
--
-- The engine NEVER executes anything. Approving records that the decision was made;
-- acting on it is a human's job (or a later, deliberately-wired phase). There is no
-- autonomous execution here, by design.
--
-- ───────────────────────────────────────────────────────────────────────────
-- What this migration reuses, and the ONE thing it builds
-- ───────────────────────────────────────────────────────────────────────────
-- It reuses the hq_approvals ARCHITECTURE wholesale — the pattern the shipped
-- approval engine proved:
--   • RLS:hq — RLS ENABLED, ZERO policies. service_role (BYPASSRLS) reaches the
--     tables; every JWT client (anon/authenticated) is denied. HQ infrastructure is
--     never tenant-visible; the request-path super-admin gate (server/auth/hq.ts) is
--     the only door, because "super-admin" is an ENV allowlist, not a DB role.
--   • The state machine + all invariants live in a BEFORE trigger that NO caller can
--     bypass — not even the service-role admin client that BYPASSES RLS — so an
--     illegal transition, a decision without a decider, a rejection/delay/delegate
--     without its required inputs, and ANY mutation of a decided row are structurally
--     impossible (the lesson expense-drafts and hq_approvals both learned: gate in
--     the path the admin client still travels).
--   • The audit trail is APPEND-ONLY and IMMUTABLE, enforced by block-mutation
--     triggers — the exact mechanism the HQ Event Spine (hq_events) uses for its own
--     append-only log (20260720000000 §3).
--
-- Where hq_approvals emits its per-transition narrative into the SHARED spine (it
-- had six RESERVED approval.* verbs waiting for a producer), the Decision Centre has
-- NO reserved verb vocabulary, and the verb registry (lib/events/registry.ts) is a
-- frozen, count-locked contract whose growth is an ADR-gated event. So rather than
-- widen that contract from a migration, the immutable decision history lives in a
-- dedicated append-only child table — `hq_decision_events` — built with the SAME
-- immutability mechanism as the spine itself. One migration, zero blast radius on the
-- shared registry, and the "stored forever, never hard-deleted, append-only" contract
-- fully met. The service ALSO records to admin_activity_log for each human decision,
-- exactly as hq_approvals does.
--
-- The deterministic state machine:
--   ACTIVE:   proposed                                   (awaiting human judgement)
--   TERMINAL: approved, rejected, delayed, delegated      (decided — immutable forever)
--   propose  : (insert)          → proposed    appends a 'proposed' history row
--   approve  : proposed → approved              decider required
--   reject   : proposed → rejected              decider + reason required
--   delay    : proposed → delayed               decider + delay_until + reason required
--   delegate : proposed → delegated             decider + delegate_to + reason required
-- A decided decision is FROZEN — it can never be re-decided (the row-level analogue
-- of the spine's event-level immutability). To revisit a delayed/rejected item, a
-- NEW proposal is created; the prior decision stays in the permanent record.
--
-- Additive + idempotent throughout (create-if-not-exists, guarded triggers): applying
-- this migration touches no tenant table and changes no existing behaviour.

-- ===========================================================================
-- 1. hq_decisions — the live state of every strategic decision proposal.
-- ===========================================================================
create table if not exists public.hq_decisions (
  id               uuid        primary key default gen_random_uuid(),

  -- The proposal. `title` is the only required field; the rest are the rich context
  -- a decision-maker weighs. All are human-authored prose today (an AI tier fills
  -- ai_debate later — see below).
  title            text        not null,
  problem          text,
  business_impact  text,
  revenue_impact   text,
  demand           text,
  engineering_cost text,
  risk             text,
  timeline         text,

  -- The AI-employee debate. A slot for the AI tier to fill once a model tier is
  -- bound (each entry: who argued, their position, their reasoning). Empty is valid
  -- and expected now — the UI shows an explicit empty state.
  ai_debate        jsonb       not null default '[]'::jsonb,

  -- The proposer's recommended outcome, in prose (advisory; the human decides).
  recommendation   text,

  -- The deterministic state. Born 'proposed'; the trigger enforces every move.
  status           text        not null default 'proposed'
                     check (status in ('proposed','approved','rejected','delayed','delegated')),

  -- The decision. `decided_by` is REQUIRED for every terminal outcome;
  -- `decision_reason` is REQUIRED on reject / delay / delegate. `delay_until` is
  -- REQUIRED on delay; `delegate_to` is REQUIRED on delegate (all trigger-enforced).
  decided_by       uuid        references public.users(id) on delete set null,
  decided_at       timestamptz,
  delegate_to      uuid        references public.users(id) on delete set null,
  delay_until      date,
  decision_reason  text,

  -- Provenance. created_by is the super-admin who raised the proposal (nullable so
  -- the row survives a user delete); write-once after insert.
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- List + observability indexes.
--   queue:   the proposal list, newest first, filtered by status.
--   active:  the "awaiting a decision" backlog (proposed only).
--   decided: the decided archive by decision time.
create index if not exists hq_decisions_status_idx
  on public.hq_decisions (status, created_at desc);
create index if not exists hq_decisions_active_idx
  on public.hq_decisions (created_at desc)
  where status = 'proposed';
create index if not exists hq_decisions_decided_idx
  on public.hq_decisions (decided_at desc)
  where status in ('approved','rejected','delayed','delegated');

-- RLS:hq — enable, NO policies. service_role (BYPASSRLS) reaches it; every JWT
-- client is denied. The Decision Centre is HQ infrastructure; tenants never see it.
alter table public.hq_decisions enable row level security;

-- ===========================================================================
-- 2. hq_decision_events — the immutable, append-only decision history.
--
-- One row per transition (the 'proposed' birth + each decision). Stored forever:
-- block-mutation triggers reject UPDATE and DELETE even under service-role, exactly
-- as hq_events guards the spine (20260720000000 §3). This is the permanent record
-- the audit trail reads; the parent row is the live state.
-- ===========================================================================
create table if not exists public.hq_decision_events (
  id            uuid        primary key default gen_random_uuid(),
  decision_id   uuid        not null references public.hq_decisions(id) on delete restrict,

  -- The transition this row records: 'proposed' (birth) or the terminal outcome
  -- (approved/rejected/delayed/delegated). from_status is null at birth.
  event_type    text        not null
                  check (event_type in ('proposed','approved','rejected','delayed','delegated')),
  from_status   text,
  to_status     text        not null,

  -- WHO acted (the super-admin decider, or the proposer at birth) — denormalised so
  -- the history survives the account. reason/delegate_to/delay_until snapshot the
  -- decision inputs at the moment they were made.
  actor_id      uuid,
  actor_email   text,
  reason        text,
  delegate_to   uuid,
  delay_until   date,

  created_at    timestamptz not null default now()
);

create index if not exists hq_decision_events_decision_idx
  on public.hq_decision_events (decision_id, created_at);

alter table public.hq_decision_events enable row level security;

-- Append-only: reject UPDATE/DELETE even under service-role.
create or replace function public.hq_decision_events_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'hq_decision_events is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists hq_decision_events_no_update on public.hq_decision_events;
create trigger hq_decision_events_no_update
  before update on public.hq_decision_events
  for each row execute function public.hq_decision_events_block_mutation();

drop trigger if exists hq_decision_events_no_delete on public.hq_decision_events;
create trigger hq_decision_events_no_delete
  before delete on public.hq_decision_events
  for each row execute function public.hq_decision_events_block_mutation();

-- ===========================================================================
-- 3. The transition guard — the deterministic state machine, DB-enforced.
--
-- A BEFORE INSERT/UPDATE trigger no caller can bypass. It makes illegal transitions,
-- re-deciding a terminal decision, a decision without a decider, and a
-- reject/delay/delegate missing its required inputs structurally impossible, and
-- auto-stamps decided_at so the timestamp can never be forgotten or faked.
-- ===========================================================================
create or replace function public.hq_decisions_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- A decision is always BORN proposed — you cannot insert straight into a decided
    -- state; every proposal enters the queue for judgement.
    if new.status <> 'proposed' then
      raise exception 'hq_decisions: a new decision must start proposed, got %', new.status
        using errcode = 'check_violation';
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- tg_op = 'UPDATE' from here.

  -- (a) Decided states are immutable. Once approved/rejected/delayed/delegated the
  --     row is frozen forever — the permanent record of the decision. A terminal
  --     decision can never be re-decided or edited.
  --     THE ONE EXCEPTION: the FK `on delete set null` path. When a referenced user
  --     (decided_by / delegate_to) is deleted — e.g. GDPR right-to-erasure — Postgres
  --     nulls that column, firing a BEFORE UPDATE on the (terminal) row. We permit
  --     EXACTLY that: status unchanged, one or both FK columns transitioning to NULL,
  --     and every other column byte-identical (proven via a whole-row jsonb compare).
  --     This keeps erasure possible without letting a terminal decision be edited.
  if old.status in ('approved','rejected','delayed','delegated') then
    if (new.decided_by is null or new.decided_by is not distinct from old.decided_by)
       and (new.delegate_to is null or new.delegate_to is not distinct from old.delegate_to)
       and (new.decided_by is distinct from old.decided_by
            or new.delegate_to is distinct from old.delegate_to)
       and (to_jsonb(new) - 'decided_by' - 'delegate_to' - 'updated_at')
           = (to_jsonb(old) - 'decided_by' - 'delegate_to' - 'updated_at')
    then
      new.updated_at := now();
      return new;
    end if;
    raise exception 'hq_decisions %: status % is terminal and immutable', old.id, old.status
      using errcode = 'restrict_violation';
  end if;

  -- (b) Provenance is write-once — who raised it and when can never be rewritten.
  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'hq_decisions %: created_by / created_at are write-once', old.id
      using errcode = 'restrict_violation';
  end if;

  -- (c) Legal transitions only. old.status is active here ('proposed'). Same-status
  --     (a proposal edit while still under review) is allowed; a move must go to one
  --     of the four terminal outcomes. Nothing else is legal.
  if not (
       (old.status = new.status)
    or (old.status = 'proposed' and new.status in ('approved','rejected','delayed','delegated'))
  ) then
    raise exception 'hq_decisions %: illegal transition % -> %', old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- (d) Decision invariants — a decision is a HUMAN act with the inputs its outcome
  --     demands.
  if new.status in ('approved','rejected','delayed','delegated') and new.decided_by is null then
    raise exception 'hq_decisions %: a % decision requires a decider', old.id, new.status
      using errcode = 'check_violation';
  end if;
  if new.status in ('rejected','delayed','delegated')
     and (new.decision_reason is null or btrim(new.decision_reason) = '') then
    raise exception 'hq_decisions %: a % decision requires a reason', old.id, new.status
      using errcode = 'check_violation';
  end if;
  if new.status = 'delayed' and new.delay_until is null then
    raise exception 'hq_decisions %: a delay requires delay_until', old.id
      using errcode = 'check_violation';
  end if;
  if new.status = 'delegated' and new.delegate_to is null then
    raise exception 'hq_decisions %: a delegation requires delegate_to', old.id
      using errcode = 'check_violation';
  end if;

  -- (e) Auto-stamp the lifecycle so timestamps are deterministic, not caller-trust.
  new.updated_at := now();
  if new.status in ('approved','rejected','delayed','delegated') and new.decided_at is null then
    new.decided_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists hq_decisions_guard_ins on public.hq_decisions;
create trigger hq_decisions_guard_ins
  before insert on public.hq_decisions
  for each row execute function public.hq_decisions_guard();

drop trigger if exists hq_decisions_guard_upd on public.hq_decisions;
create trigger hq_decisions_guard_upd
  before update on public.hq_decisions
  for each row execute function public.hq_decisions_guard();

-- ===========================================================================
-- 4. The history emitter — every transition appends one immutable event.
--
-- An AFTER INSERT/UPDATE trigger that writes into the append-only child table in the
-- SAME transaction as the state change (transactional outbox — the same idiom
-- hq_approvals_emit uses). SECURITY DEFINER with a pinned empty search_path so it can
-- write through regardless of the acting role; fully schema-qualified throughout.
-- ===========================================================================
create or replace function public.hq_decisions_emit()
returns trigger
security definer
set search_path = ''
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.hq_decision_events (
      decision_id, event_type, from_status, to_status,
      actor_id, actor_email, reason, delegate_to, delay_until
    ) values (
      new.id, 'proposed', null, 'proposed',
      new.created_by, null, null, null, null
    );
    return new;
  end if;

  -- UPDATE: append only when the status actually moved (a same-status proposal edit
  -- is not a decision and writes no history row).
  if new.status is distinct from old.status then
    insert into public.hq_decision_events (
      decision_id, event_type, from_status, to_status,
      actor_id, actor_email, reason, delegate_to, delay_until
    ) values (
      new.id, new.status, old.status, new.status,
      new.decided_by,
      (select u.email from public.users u where u.id = new.decided_by),
      new.decision_reason, new.delegate_to, new.delay_until
    );
  end if;

  return new;
end;
$$;

revoke all on function public.hq_decisions_emit() from public, anon, authenticated;
grant execute on function public.hq_decisions_emit() to service_role;

drop trigger if exists hq_decisions_emit_ins on public.hq_decisions;
create trigger hq_decisions_emit_ins
  after insert on public.hq_decisions
  for each row execute function public.hq_decisions_emit();

drop trigger if exists hq_decisions_emit_upd on public.hq_decisions;
create trigger hq_decisions_emit_upd
  after update on public.hq_decisions
  for each row execute function public.hq_decisions_emit();
