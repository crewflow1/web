-- CrewFlow HQ — The Communication Layer (CEO Directive 010, Phase 4).
--
-- Phase 2 built the Approval Engine (GATE a proposed action behind a human
-- decision). Phase 3 built the Draft Engine (PRODUCE the thing decided on). Phase 4
-- builds the layer that DELIVERS an approved draft through a replaceable provider —
-- and, like both engines before it, builds it as SHARED WORKFORCE INFRASTRUCTURE,
-- not Outreach-specific code. Every future AI employee inherits this exact layer:
-- Sales AI, Customer Success AI, Finance AI, Business Coach AI, Voice AI. So nothing
-- here names Outreach; the table is `hq_communications`, generic over a
-- (subject_type, subject_id) pair — the same shape as hq_approvals and hq_drafts.
--
-- The objective is communication INFRASTRUCTURE: provider abstraction, delivery
-- tracking, bounce handling, suppression, retry, audit, observability. It is NOT
-- automation, NOT autonomous outreach, NOT campaign management. NOTHING in this
-- migration sends on a timer: there is no cron, no scheduler, no queue-drainer. A
-- delivery row only ever comes into being when the service is explicitly invoked for
-- an APPROVED action — and that gate is enforced here, in the database.
--
-- ───────────────────────────────────────────────────────────────────────────
-- The Phase-4 reuse audit (Engineering Rule 1: reuse before build)
-- ───────────────────────────────────────────────────────────────────────────
-- The immutable audit trail ALREADY EXISTS: the HQ Event Spine (hq_events) is an
-- append-only, partitioned log. This migration adds a NEW domain group to the frozen
-- registry — comm.* (sent / delivered / bounced / complained / failed / suppressed) —
-- exactly as hq_approvals brought approval.* alive and hq_drafts narrated through
-- ai.*. It is a new DOMAIN, not a duplicate vocabulary; every delivery transition
-- emits ONE canonical spine event, in-transaction, and builds NO second audit store.
--
-- The transport ALREADY EXISTS: lib/email/send.ts (the Resend wrapper) is wrapped by
-- the provider seam (lib/comms), not replaced. The per-attempt COST LEDGER pattern
-- ALREADY EXISTS (hq_embedding_runs, hq_drafts); this table carries the same columns
-- inline (one attempt = one ledger row). The state-machine + trigger pattern ALREADY
-- EXISTS (hq_approvals); this table reuses its exact shape.
--
-- So Phase 4 leaves two things that genuinely do not exist: a place to record each
-- DELIVERY ATTEMPT as a first-class, immutable, approval-gated, cost-accounted row,
-- and the do-not-contact list that stops repeat contact. Those are this migration's
-- two new objects:
--
--   hq_communications     — one row per delivery ATTEMPT. Born sent|failed|suppressed;
--                           a live `sent` row settles to delivered|bounced|complained
--                           when the provider reports back, then FREEZES. Retry is a
--                           NEW row that supersedes (the prior attempt stays in the
--                           permanent record). It carries the routing, the provider's
--                           message id, the status, and the cost ledger.
--   hq_comms_suppressions — the do-not-contact list, keyed by normalised address. A
--                           bounce or complaint adds to it; the layer refuses any send
--                           to a suppressed address.
--
-- Both are RLS:hq (RLS enabled, ZERO policies → service-role only; every JWT client is
-- denied). The recipient address and the draft prose NEVER leave these RLS-locked
-- rows: the spine event carries identifiers + metadata only. No tenant table is touched.
--
-- ───────────────────────────────────────────────────────────────────────────
-- Why the approval gate is enforced in the DATABASE (architecture, not convention)
-- ───────────────────────────────────────────────────────────────────────────
-- The CEO constraint is absolute: "Every outbound communication still requires the
-- Approval Engine." Service code reaches this table through the service-role admin
-- client, which BYPASSES RLS — so a gate that lived only in TypeScript could be
-- bypassed by any future caller. Therefore the gate is a BEFORE INSERT trigger that
-- NO caller can bypass: a delivery row — even a suppressed or failed attempt — may
-- only be inserted when its referenced hq_approvals row is in state 'approved'. A
-- CHECK constraint cannot subquery; a trigger can. This is the load-bearing security
-- boundary, and __tests__/security/comms-invariants.test.ts proves the database
-- refuses an ungated send against real Postgres.
--
-- The deterministic delivery state machine (mirrored in lib/comms/state.ts):
--   ACTIVE:   sent                                  (awaiting a provider outcome)
--   TERMINAL: delivered, bounced, complained, failed, suppressed (frozen forever)
--   send      : (insert)          → sent        emits comm.sent       (ai_employee)
--   fail      : (insert)          → failed      emits comm.failed     (system)
--   suppress  : (insert)          → suppressed  emits comm.suppressed (system)
--   deliver   : sent             → delivered   emits comm.delivered  (system)
--   bounce    : sent             → bounced     emits comm.bounced    (system)
--   complain  : sent             → complained  emits comm.complained (system)
-- Retry is NOT a transition out of a terminal state (those are immutable). To retry a
-- failed attempt, a NEW row is inserted that `supersedes` the old one — the prior
-- attempt stays in the permanent record. These six actions are the EXACT six reserved
-- comm.* verbs — no more, no less. This migration is the ENFORCER; lib/comms/state.ts
-- is the mirror; the security suite pins that they agree.

-- ===========================================================================
-- 1. hq_communications — one immutable, approval-gated delivery attempt per row.
-- ===========================================================================
create table if not exists public.hq_communications (
  id                   uuid        primary key default gen_random_uuid(),

  -- WHO is delivering (the AI employee). Write-once. RESTRICT: an employee with
  -- deliveries on record cannot be deleted out from under its audit trail.
  ai_employee_id       uuid        not null references public.ai_employees(id) on delete restrict,

  -- WHAT approved draft is being delivered, and the APPROVAL that gates it. Both
  -- write-once, both RESTRICT: a delivery's draft and approval are its evidence and
  -- cannot be deleted out from under it. approval_id is NOT NULL — there is no such
  -- thing as an ungated delivery, and the BEFORE INSERT trigger proves the approval
  -- is actually 'approved'.
  draft_id             uuid        not null references public.hq_drafts(id) on delete restrict,
  approval_id          uuid        not null references public.hq_approvals(id) on delete restrict,

  -- WHAT it is about — generic over any future employee, same addressing as the spine.
  subject_type         text        not null,
  subject_id           text        not null,

  -- The channel + provider this attempt used. V1 ships email; the CHECK is the seam
  -- the SMS/voice channels widen later.
  channel              text        not null default 'email'
                         check (channel in ('email')),
  provider             text        not null,

  -- WHERE it went. PII — stays sealed in this RLS-locked row, NEVER on the spine.
  to_address           text        not null,

  -- The provider's message id — the correlation key a delivery webhook carries back.
  -- NULL on a born failed/suppressed attempt (it never reached a provider).
  provider_message_id  text,

  -- The deterministic delivery state. Born sent|failed|suppressed; the trigger
  -- enforces every move. Only a live `sent` row reaches delivered|bounced|complained.
  status               text        not null
                         check (status in ('sent','delivered','bounced','complained','failed','suppressed')),

  -- Why a failed/suppressed attempt ended where it did (no_provider / provider_error /
  -- suppressed / hard_bounce / complaint). NULL on a clean send. Observability, not control.
  failure_reason       text,

  -- Which attempt this is for its message (1 = first). Retry mints a NEW row with
  -- attempt = prior + 1 and supersedes_id back to it.
  attempt              integer     not null default 1 check (attempt >= 1),

  -- The cost ledger, inline (mirrors hq_drafts / hq_embedding_runs). cost_usd is NULL
  -- when the provider/channel is unpriced — cost is observability, never a gate.
  cost_usd             numeric,
  latency_ms           integer,

  -- Threads this delivery into one spine trace (the draft/approval's correlation, when
  -- the caller supplies it, else a fresh trace).
  correlation_id       uuid        not null default gen_random_uuid(),

  -- Retry: when this attempt supersedes a prior failed one. SET NULL defensively on
  -- the (never-happening, terminal-immutable) delete of the prior.
  supersedes_id        uuid        references public.hq_communications(id) on delete set null,

  -- Lifecycle timestamps. The trigger auto-stamps sent_at / settled_at so they can
  -- never be forgotten or faked by a caller.
  sent_at              timestamptz,
  settled_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Observability + lookup indexes.
--   per-employee: one employee's deliveries, newest first.
--   per-subject:  every delivery ever made for a given thing (the subject's story).
--   per-draft:    every attempt to deliver a given draft (the retry chain).
--   per-approval: the deliveries an approval gated.
--   webhook:      correlate a provider's delivery event back to its row (unique per msg).
--   active:       the `sent` rows still awaiting an outcome.
--   trace:        all rows in one correlation.
--   recovery:     follow supersession links.
create index if not exists hq_communications_employee_idx
  on public.hq_communications (ai_employee_id, created_at desc);
create index if not exists hq_communications_subject_idx
  on public.hq_communications (subject_type, subject_id, created_at desc);
create index if not exists hq_communications_draft_idx
  on public.hq_communications (draft_id, created_at desc);
create index if not exists hq_communications_approval_idx
  on public.hq_communications (approval_id);
create unique index if not exists hq_communications_provider_msg_idx
  on public.hq_communications (provider_message_id)
  where provider_message_id is not null;
create index if not exists hq_communications_active_idx
  on public.hq_communications (created_at)
  where status = 'sent';
create index if not exists hq_communications_correlation_idx
  on public.hq_communications (correlation_id);
create index if not exists hq_communications_supersedes_idx
  on public.hq_communications (supersedes_id)
  where supersedes_id is not null;

-- RLS:hq — enable, NO policies. service_role (BYPASSRLS) reaches it; every JWT client
-- is denied. Deliveries are HQ infrastructure; the recipient + prose stay sealed here.
alter table public.hq_communications enable row level security;

-- ===========================================================================
-- 2. hq_comms_suppressions — the do-not-contact list.
-- ===========================================================================
create table if not exists public.hq_comms_suppressions (
  id           uuid        primary key default gen_random_uuid(),

  -- The normalised (bare, lower-cased) address. UNIQUE — one standing entry per
  -- address; the unique index is the suppression-check lookup path.
  address      text        not null unique,
  channel      text        not null default 'email' check (channel in ('email')),

  -- WHY it is suppressed. A bounce/complaint is automatic; manual is the operator's.
  reason       text        not null check (reason in ('bounce','complaint','manual')),

  -- Provenance: the delivery that caused an automatic suppression, or NULL for a
  -- manual addition. SET NULL defensively if that row were ever removed.
  source_communication_id uuid references public.hq_communications(id) on delete set null,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists hq_comms_suppressions_created_idx
  on public.hq_comms_suppressions (created_at desc);

-- RLS:hq — enable, NO policies. The do-not-contact list is HQ infrastructure.
alter table public.hq_comms_suppressions enable row level security;

-- ===========================================================================
-- 3. The delivery guard — the approval gate + the state machine, enforced.
--
-- A BEFORE INSERT/UPDATE trigger that NO caller (not even the service-role admin
-- client) can bypass. On INSERT it enforces THE approval gate (the load-bearing
-- boundary: no delivery without an approved action) and that a row is born in a legal
-- state. On UPDATE it freezes terminal rows, keeps the routing write-once, and allows
-- only the provider-outcome transitions out of `sent`. It auto-stamps the lifecycle.
-- ===========================================================================
create or replace function public.hq_communications_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- (a) THE approval gate. A delivery — even a suppressed or failed attempt — may
    --     only exist for an action the Approval Engine moved to 'approved'. A CHECK
    --     cannot subquery; this trigger can. This is the boundary the CEO mandated:
    --     "every outbound communication still requires the Approval Engine," enforced
    --     in the database, unbypassable from the application layer.
    if (select state from public.hq_approvals where id = new.approval_id) is distinct from 'approved' then
      raise exception 'hq_communications: approval % is not approved — every delivery requires an approved action', new.approval_id
        using errcode = 'check_violation';
    end if;

    -- (b) Born in a definite state: sent (a provider accepted it), failed (the
    --     transport failed), or suppressed (policy blocked it). Never born
    --     delivered/bounced/complained — those are outcomes only a live `sent` reaches.
    if new.status not in ('sent','failed','suppressed') then
      raise exception 'hq_communications: a new delivery must be born sent, failed, or suppressed, got %', new.status
        using errcode = 'check_violation';
    end if;

    -- (c) A sent attempt carries the provider's message id (the correlation key); a
    --     failed/suppressed attempt never reached a provider, so it must not.
    if new.status = 'sent' and (new.provider_message_id is null or btrim(new.provider_message_id) = '') then
      raise exception 'hq_communications %: a sent delivery requires a provider_message_id', new.id
        using errcode = 'check_violation';
    end if;
    if new.status in ('failed','suppressed') and new.provider_message_id is not null then
      raise exception 'hq_communications %: a % delivery never reached a provider and must not carry a provider_message_id', new.id, new.status
        using errcode = 'check_violation';
    end if;

    -- (d) Auto-stamp the lifecycle so timestamps are deterministic, not caller-trust.
    new.updated_at := now();
    if new.status = 'sent' and new.sent_at is null then
      new.sent_at := now();
    end if;
    if new.status in ('failed','suppressed') and new.settled_at is null then
      new.settled_at := now(); -- born terminal
    end if;
    return new;
  end if;

  -- tg_op = 'UPDATE' from here.

  -- (a) Terminal states are immutable. Once delivered/bounced/complained/failed/
  --     suppressed, the row is frozen forever — the permanent record of the attempt.
  if old.status in ('delivered','bounced','complained','failed','suppressed') then
    raise exception 'hq_communications %: status % is terminal and immutable', old.id, old.status
      using errcode = 'restrict_violation';
  end if;

  -- (b) The routing + evidence is write-once. Who delivered what, to where, under
  --     which approval, via which provider message can never be rewritten — only settled.
  if new.ai_employee_id      is distinct from old.ai_employee_id
     or new.draft_id         is distinct from old.draft_id
     or new.approval_id      is distinct from old.approval_id
     or new.subject_type     is distinct from old.subject_type
     or new.subject_id       is distinct from old.subject_id
     or new.channel          is distinct from old.channel
     or new.provider         is distinct from old.provider
     or new.to_address       is distinct from old.to_address
     or new.provider_message_id is distinct from old.provider_message_id
     or new.attempt          is distinct from old.attempt
     or new.correlation_id   is distinct from old.correlation_id
     or new.supersedes_id    is distinct from old.supersedes_id
     or new.sent_at          is distinct from old.sent_at then
    raise exception 'hq_communications %: the delivery fields are write-once', old.id
      using errcode = 'restrict_violation';
  end if;

  -- (c) Legal transitions only. old.status is 'sent' here (the only active state); it
  --     may move only to a provider outcome. Everything else is rejected.
  if not (old.status = 'sent' and new.status in ('delivered','bounced','complained')) then
    raise exception 'hq_communications %: illegal transition % -> %', old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- (d) Auto-stamp the settlement.
  new.updated_at := now();
  if new.settled_at is null then
    new.settled_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists hq_communications_guard_ins on public.hq_communications;
create trigger hq_communications_guard_ins
  before insert on public.hq_communications
  for each row execute function public.hq_communications_guard();

drop trigger if exists hq_communications_guard_upd on public.hq_communications;
create trigger hq_communications_guard_upd
  before update on public.hq_communications
  for each row execute function public.hq_communications_guard();

-- ===========================================================================
-- 4. The audit emitter — every delivery transition becomes one canonical spine event.
--
-- An AFTER INSERT/UPDATE trigger that emits through hq_emit_event() — the single
-- validated spine write primitive — IN THE SAME TRANSACTION as the state change
-- (transactional outbox; the same idiom hq_approvals_emit / hq_drafts_emit use). It
-- brings the new comm.* verbs to life. The AI employee performs exactly ONE deliberate
-- act — `send`; every other state is a fact reported back by the world (a transport
-- failure, a policy suppression, a provider-reported outcome), so the system is the
-- honest actor, mirroring how the Approval Engine attributes `expire` to the system.
--
-- SECURITY DEFINER with a pinned empty search_path, like every spine function; fully
-- schema-qualified throughout. The payload is small and NON-PII (Ch.04): identifiers,
-- routing metadata, and the cost ledger — NEVER the recipient address and NEVER the
-- draft prose, which stay sealed in the RLS:hq row.
-- ===========================================================================
create or replace function public.hq_communications_emit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verb       text;
  v_actor_type text;
  v_actor_id   text;
  v_severity   text;
begin
  -- Map the (born or transitioned-into) state to its reserved verb + honest actor +
  -- severity. The send is the employee's one deliberate act; the rest are the world
  -- reporting back, so they are attributed to the system.
  if new.status = 'sent' then
    v_verb := 'comm.sent';        v_severity := 'info';
    v_actor_type := 'ai_employee'; v_actor_id := new.ai_employee_id::text;
  elsif new.status = 'delivered' then
    v_verb := 'comm.delivered';   v_severity := 'success';
    v_actor_type := 'system';     v_actor_id := 'system';
  elsif new.status = 'bounced' then
    v_verb := 'comm.bounced';     v_severity := 'warn';
    v_actor_type := 'system';     v_actor_id := 'system';
  elsif new.status = 'complained' then
    v_verb := 'comm.complained';  v_severity := 'warn';
    v_actor_type := 'system';     v_actor_id := 'system';
  elsif new.status = 'failed' then
    v_verb := 'comm.failed';      v_severity := 'warn';
    v_actor_type := 'system';     v_actor_id := 'system';
  elsif new.status = 'suppressed' then
    v_verb := 'comm.suppressed';  v_severity := 'info';
    v_actor_type := 'system';     v_actor_id := 'system';
  else
    return new;
  end if;

  perform public.hq_emit_event(
    p_actor_type     => v_actor_type,
    p_actor_id       => v_actor_id,
    p_verb           => v_verb,
    p_object_type    => 'communication',
    p_object_id      => new.id::text,
    p_target_type    => new.subject_type,
    p_target_id      => new.subject_id,
    p_correlation_id => new.correlation_id,
    p_severity       => v_severity,
    p_payload        => jsonb_build_object(
                          'channel', new.channel,
                          'provider', new.provider,
                          'provider_message_id', new.provider_message_id,
                          'status', new.status,
                          'draft_id', new.draft_id,
                          'approval_id', new.approval_id,
                          'employee_id', new.ai_employee_id,
                          'attempt', new.attempt,
                          'cost_usd', new.cost_usd,
                          'latency_ms', new.latency_ms,
                          'failure_reason', new.failure_reason,
                          'supersedes', new.supersedes_id
                        )
  );

  return new;
end;
$$;

revoke all on function public.hq_communications_emit() from public, anon, authenticated;
grant execute on function public.hq_communications_emit() to service_role;

drop trigger if exists hq_communications_emit_ins on public.hq_communications;
create trigger hq_communications_emit_ins
  after insert on public.hq_communications
  for each row execute function public.hq_communications_emit();

drop trigger if exists hq_communications_emit_upd on public.hq_communications;
create trigger hq_communications_emit_upd
  after update on public.hq_communications
  for each row execute function public.hq_communications_emit();
