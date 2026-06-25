-- CrewFlow HQ — The Approval Engine (CEO Directive 010, Phase 2).
--
-- Phase 1 registered Outreach AI as the first employee whose work is meant to
-- reach a customer, pinned to the V1 safety contract: Draft → Human Review →
-- Approval → Send, with NO autonomous customer communication. Phase 2 builds the
-- engine that makes the middle two arrows real — and builds it as SHARED WORKFORCE
-- INFRASTRUCTURE, not Outreach-specific code. Every future AI employee inherits
-- this exact engine: Sales AI, Customer Success AI, Finance AI, Business Coach AI,
-- Voice AI. So nothing here names Outreach; the table is `hq_approvals`, generic
-- over a (subject_type, subject_id, action) triple.
--
-- The objective is NOT sending, NOT generation, NOT automation. It is the approval
-- engine only: states, review queue, reviewer permissions, editing, rejection,
-- audit trail, escalation, recovery, observability. Sending an approved artifact
-- is a separate, later phase that reads `approved` rows; this migration wires
-- nothing to any send channel.
--
-- ───────────────────────────────────────────────────────────────────────────
-- The Phase-2 reuse audit (Engineering Rule 1: reuse before build)
-- ───────────────────────────────────────────────────────────────────────────
-- The immutable audit trail ALREADY EXISTS: the HQ Event Spine (hq_events) is an
-- append-only, partitioned log whose UPDATE/DELETE are rejected even under
-- service-role (20260720000000). Its `approval.*` verb group — approval.requested
-- / granted / rejected / edited / expired / escalated — was RESERVED in the frozen
-- registry (lib/events/registry.ts) and has had no producer until now. This engine
-- brings that reserved vocabulary to life, exactly as Research AI claimed reserved
-- hq_sales_* tables and Outreach AI claimed the reserved `generate_email` task
-- type. So this migration mints NO new event vocabulary and builds NO second audit
-- store — every state transition emits one canonical spine event, in-transaction.
--
-- Reviewer permissions ALREADY EXIST: HQ access is the super-admin allowlist
-- (server/auth/hq.ts → isSuperAdminEmail), enforced in the request path because it
-- is an ENV allowlist, not a DB role. The engine's reviewer gate reuses it (in the
-- service layer); this migration adds no role, no policy, no GRant.
--
-- So the audit leaves exactly ONE thing that genuinely does not exist: a place to
-- hold the LIVE STATE of a pending approval — the review queue. The append-only
-- spine is the history; you cannot list "what is awaiting review" from it, nor
-- mutate a pending item toward a decision. That is this migration's one new object:
--
--   hq_approvals — the current-state projection + review queue. One row per
--                  proposed action awaiting human judgement. It MUTATES through
--                  its lifecycle (pending → … → approved/rejected/expired) and is
--                  then FROZEN. The immutable per-transition narrative lives in the
--                  spine; this row is the live state the queue reads. Two layers,
--                  each doing one job (Bible Ch.03 CQRS: write-model vs read-state).
--
-- It is RLS:hq (RLS enabled, ZERO policies → service-role only; every JWT client —
-- anon/authenticated — is denied). No tenant table is touched (provably additive).
--
-- ───────────────────────────────────────────────────────────────────────────
-- Why the state machine is enforced in the DATABASE (architecture, not convention)
-- ───────────────────────────────────────────────────────────────────────────
-- The CEO success criteria are absolute: deterministic, immutable history,
-- security boundaries that CANNOT be bypassed. Service code reaches this table
-- through the service-role admin client, which BYPASSES RLS — so a guard that
-- lived only in TypeScript could be bypassed by any future buggy or malicious
-- caller (the same lesson expense-drafts learned: gate in the path the admin
-- client still travels). Therefore the legal transitions, the decision invariants,
-- the write-once proposal fields and the terminal-immutability rule are all
-- enforced by a BEFORE trigger that NO caller can bypass, and the audit event is
-- emitted by an AFTER trigger in the SAME transaction as the state change — so
-- state and narrative are inseparable (P1): if the transition commits, its event
-- commits; if it rolls back, so does the event. There is no half-state.
--
-- The deterministic state machine:
--   ACTIVE:   pending, escalated          (awaiting human judgement)
--   TERMINAL: approved, rejected, expired  (frozen — immutable forever)
--   request  : (insert)              → pending      emits approval.requested  (ai_employee)
--   edit     : pending|escalated     (no state move) emits approval.edited     (human)
--   escalate : pending               → escalated    emits approval.escalated  (human/system)
--   approve  : pending|escalated     → approved     emits approval.granted    (human, reviewer required)
--   reject   : pending|escalated     → rejected     emits approval.rejected   (human, reviewer + reason required)
--   expire   : pending|escalated     → expired      emits approval.expired    (system)
-- Recovery is NOT a transition out of a terminal state (those are immutable). To
-- recover a rejected/expired item, a NEW pending row is inserted that `supersedes`
-- the old one (supersedes_id) — the prior decision stays in the permanent record.
-- These six actions are the EXACT six reserved approval.* verbs — no more, no less.
--
-- The pure transition map is mirrored in lib/approvals/state.ts (the single source
-- the service and UI read); this migration is the ENFORCER, that module is the
-- mirror, and __tests__/security/approvals-invariants.test.ts pins that they agree.

-- ===========================================================================
-- 1. hq_approvals — the live state of every proposed action awaiting review.
-- ===========================================================================
create table if not exists public.hq_approvals (
  id               uuid        primary key default gen_random_uuid(),

  -- WHO proposed it (the AI employee). Write-once. RESTRICT: an employee with
  -- live approvals in the queue cannot be deleted out from under them.
  ai_employee_id   uuid        not null references public.ai_employees(id) on delete restrict,

  -- WHAT is being approved — generic over any future employee. subject_type/id
  -- mirror the spine's object addressing (e.g. 'outreach_email' + a draft id);
  -- action is the proposed act (e.g. 'send'). All write-once: you can never
  -- retroactively change what was proposed, only decide it. proposed_payload is
  -- the employee's proposal (a draft's subject+body, a figure, etc.).
  subject_type     text        not null,
  subject_id       text        not null,
  action           text        not null,
  proposed_payload jsonb       not null default '{}'::jsonb,

  -- The reviewer's edit of the proposal, if any (the editing workflow). NULL until
  -- a human edits. The proposal above is preserved untouched so the diff is always
  -- reconstructable (proposed_payload vs edited_payload).
  edited_payload   jsonb,

  -- The deterministic state. Starts 'pending'; the trigger enforces every move.
  state            text        not null default 'pending'
                     check (state in ('pending','escalated','approved','rejected','expired')),

  -- The decision. reason is REQUIRED on reject (enforced by the trigger).
  decision_reason  text,
  -- The human who last acted on this item (edited/escalated/decided). SET NULL on
  -- user delete keeps the row's history intact; reviewer_email denormalises the
  -- identity so the audit survives the account.
  reviewer_id      uuid        references public.users(id) on delete set null,
  reviewer_email   text,

  -- Threads this approval's whole lifecycle into one spine trace. Write-once;
  -- a caller may supply it to weave the approval into a larger intent (e.g. the
  -- draft run that produced it), else a fresh trace begins.
  correlation_id   uuid        not null default gen_random_uuid(),

  -- Recovery: when this row was created to replace a terminal one. SET NULL on the
  -- (never-happening, terminal-immutable) delete of the prior, defensively.
  supersedes_id    uuid        references public.hq_approvals(id) on delete set null,

  -- Lifecycle timestamps. The trigger auto-stamps decided_at/escalated_at so they
  -- can never be forgotten or faked by a caller. expires_at is an OPTIONAL deadline
  -- the (separately-invoked, never auto-wired here) expiry sweep reads.
  requested_at     timestamptz not null default now(),
  decided_at       timestamptz,
  escalated_at     timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Review-queue + observability indexes.
--   queue:        active items oldest-first (the reviewer works the backlog).
--   per-employee: one employee's queue / history.
--   per-subject:  every approval ever raised for a given thing (the subject's story).
--   expiry sweep: only the active, dated rows the sweep must scan.
--   trace:        all rows in one correlation (recovery chains, multi-step intents).
--   recovery:     follow supersession links.
create index if not exists hq_approvals_queue_idx
  on public.hq_approvals (state, requested_at)
  where state in ('pending','escalated');
create index if not exists hq_approvals_employee_idx
  on public.hq_approvals (ai_employee_id, state, requested_at desc);
create index if not exists hq_approvals_subject_idx
  on public.hq_approvals (subject_type, subject_id, requested_at desc);
create index if not exists hq_approvals_expiry_idx
  on public.hq_approvals (expires_at)
  where state in ('pending','escalated') and expires_at is not null;
create index if not exists hq_approvals_correlation_idx
  on public.hq_approvals (correlation_id);
create index if not exists hq_approvals_supersedes_idx
  on public.hq_approvals (supersedes_id)
  where supersedes_id is not null;

-- RLS:hq — enable, NO policies. service_role (BYPASSRLS) reaches it; every JWT
-- client is denied. The engine is HQ infrastructure; tenants never see it.
alter table public.hq_approvals enable row level security;

-- ===========================================================================
-- 2. The transition guard — the deterministic state machine, enforced.
--
-- A BEFORE INSERT/UPDATE trigger that NO caller (not even the service-role admin
-- client) can bypass. It is the load-bearing security boundary: it makes illegal
-- transitions, retroactive edits to the proposal, decisions without a reviewer,
-- rejections without a reason, and ANY mutation of a terminal row structurally
-- impossible. It also auto-stamps the lifecycle timestamps so they are reliable
-- regardless of what a caller passes.
-- ===========================================================================
create or replace function public.hq_approvals_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- An approval is always BORN pending. You cannot insert straight into an
    -- escalated or terminal state — every item enters the queue for review.
    if new.state <> 'pending' then
      raise exception 'hq_approvals: a new approval must start in state pending, got %', new.state
        using errcode = 'check_violation';
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- tg_op = 'UPDATE' from here.

  -- (a) Terminal states are immutable. Once approved/rejected/expired, the row is
  --     frozen forever — the permanent record of the decision. This is the
  --     "approval history is immutable" guarantee at the row level (the spine
  --     guarantees it at the event level).
  if old.state in ('approved','rejected','expired') then
    raise exception 'hq_approvals %: state % is terminal and immutable', old.id, old.state
      using errcode = 'restrict_violation';
  end if;

  -- (b) The proposal is write-once. What was proposed, by whom, about what, and
  --     the trace it belongs to can never be rewritten — only decided.
  if new.ai_employee_id  is distinct from old.ai_employee_id
     or new.subject_type is distinct from old.subject_type
     or new.subject_id   is distinct from old.subject_id
     or new.action       is distinct from old.action
     or new.proposed_payload is distinct from old.proposed_payload
     or new.correlation_id   is distinct from old.correlation_id
     or new.supersedes_id    is distinct from old.supersedes_id
     or new.requested_at     is distinct from old.requested_at then
    raise exception 'hq_approvals %: the proposal fields are write-once', old.id
      using errcode = 'restrict_violation';
  end if;

  -- (c) Legal transitions only. old.state is active here (pending|escalated).
  --     Same-state (edit) is allowed; pending may escalate; either active state
  --     may move to a terminal decision. Everything else (e.g. de-escalation
  --     escalated→pending) is rejected.
  if not (
       (old.state = new.state)
    or (old.state = 'pending'   and new.state in ('escalated','approved','rejected','expired'))
    or (old.state = 'escalated' and new.state in ('approved','rejected','expired'))
  ) then
    raise exception 'hq_approvals %: illegal transition % -> %', old.id, old.state, new.state
      using errcode = 'check_violation';
  end if;

  -- (d) Decision invariants. A grant or a rejection is a human act: it requires a
  --     reviewer. A rejection additionally requires a reason (so a recovered item
  --     always carries why it was turned down). Expiry is a system act — no
  --     reviewer, no reason.
  if new.state in ('approved','rejected') and new.reviewer_id is null then
    raise exception 'hq_approvals %: % requires a reviewer', old.id, new.state
      using errcode = 'check_violation';
  end if;
  if new.state = 'rejected' and (new.decision_reason is null or btrim(new.decision_reason) = '') then
    raise exception 'hq_approvals %: a rejection requires a reason', old.id
      using errcode = 'check_violation';
  end if;

  -- (e) Auto-stamp the lifecycle so timestamps are deterministic, not caller-trust.
  new.updated_at := now();
  if new.state in ('approved','rejected','expired') and new.decided_at is null then
    new.decided_at := now();
  end if;
  if new.state = 'escalated' and old.state <> 'escalated' and new.escalated_at is null then
    new.escalated_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists hq_approvals_guard_ins on public.hq_approvals;
create trigger hq_approvals_guard_ins
  before insert on public.hq_approvals
  for each row execute function public.hq_approvals_guard();

drop trigger if exists hq_approvals_guard_upd on public.hq_approvals;
create trigger hq_approvals_guard_upd
  before update on public.hq_approvals
  for each row execute function public.hq_approvals_guard();

-- ===========================================================================
-- 3. The audit emitter — every transition becomes one canonical spine event.
--
-- An AFTER INSERT/UPDATE trigger that emits through hq_emit_event() — the single
-- validated spine write primitive — IN THE SAME TRANSACTION as the state change
-- (transactional outbox; the same idiom hq_emit_from_activity uses for domain
-- producers). This is the entire audit trail + observability surface: it brings
-- the reserved approval.* verbs to life and mints no new event vocabulary.
--
-- SECURITY DEFINER with a pinned empty search_path, like every spine function, so
-- it can write through hq_emit_event regardless of the acting role; fully schema-
-- qualified throughout. Payloads are small and NON-PII (Ch.04): identifiers,
-- state, and the operator-authored rejection reason — never the proposed prose
-- itself (which may carry customer-facing content), which stays in the RLS:hq row.
--
-- Edits are ALWAYS recorded: if edited_payload changed, an approval.edited fires —
-- even when batched with the approving update — so "edits are tracked" holds
-- structurally, not by caller discipline. When an edit and a state move land in one
-- update, the state event is CAUSED BY the edit event (causation_id), so the audit
-- graph is exact.
-- ===========================================================================
create or replace function public.hq_approvals_emit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_edit_id     bigint;
  v_cause       bigint;
  v_verb        text;
  v_actor_type  text;
  v_actor_id    text;
  v_severity    text;
  v_edited      boolean := false;
begin
  -- INSERT: the employee proposed it.
  if tg_op = 'INSERT' then
    perform public.hq_emit_event(
      p_actor_type     => 'ai_employee',
      p_actor_id       => new.ai_employee_id::text,
      p_verb           => 'approval.requested',
      p_object_type    => 'approval',
      p_object_id      => new.id::text,
      p_target_type    => new.subject_type,
      p_target_id      => new.subject_id,
      p_correlation_id => new.correlation_id,
      p_severity       => 'info',
      p_payload        => jsonb_build_object(
                            'action', new.action,
                            'state', new.state,
                            'employee_id', new.ai_employee_id,
                            'supersedes', new.supersedes_id
                          )
    );
    return new;
  end if;

  -- UPDATE: an edit and/or a state transition. Record the edit first so a batched
  -- approve-with-edit yields both events in causal order.
  if new.edited_payload is distinct from old.edited_payload then
    v_edited := true;
    v_edit_id := public.hq_emit_event(
      p_actor_type     => 'human',
      p_actor_id       => new.reviewer_id::text,
      p_verb           => 'approval.edited',
      p_object_type    => 'approval',
      p_object_id      => new.id::text,
      p_target_type    => new.subject_type,
      p_target_id      => new.subject_id,
      p_correlation_id => new.correlation_id,
      p_severity       => 'info',
      p_payload        => jsonb_build_object(
                            'action', new.action,
                            'state', new.state,
                            'reviewer_id', new.reviewer_id
                          )
    );
  end if;

  -- No state move → the edit (if any) was the whole story.
  if new.state = old.state then
    return new;
  end if;

  -- Map the state transition to its reserved verb + honest actor + severity.
  if new.state = 'escalated' then
    v_verb := 'approval.escalated';
    v_severity := 'warn';
    if new.reviewer_id is not null then
      v_actor_type := 'human'; v_actor_id := new.reviewer_id::text;
    else
      v_actor_type := 'system'; v_actor_id := 'system';
    end if;
  elsif new.state = 'approved' then
    v_verb := 'approval.granted';  v_severity := 'success';
    v_actor_type := 'human';       v_actor_id := new.reviewer_id::text;
  elsif new.state = 'rejected' then
    v_verb := 'approval.rejected'; v_severity := 'warn';
    v_actor_type := 'human';       v_actor_id := new.reviewer_id::text;
  elsif new.state = 'expired' then
    v_verb := 'approval.expired';  v_severity := 'warn';
    v_actor_type := 'system';      v_actor_id := 'system';
  else
    return new;
  end if;

  v_cause := case when v_edited then v_edit_id else null end;

  perform public.hq_emit_event(
    p_actor_type     => v_actor_type,
    p_actor_id       => v_actor_id,
    p_verb           => v_verb,
    p_object_type    => 'approval',
    p_object_id      => new.id::text,
    p_target_type    => new.subject_type,
    p_target_id      => new.subject_id,
    p_correlation_id => new.correlation_id,
    p_causation_id   => v_cause,
    p_severity       => v_severity,
    p_payload        => jsonb_build_object(
                          'action', new.action,
                          'state', new.state,
                          'employee_id', new.ai_employee_id,
                          'reviewer_id', new.reviewer_id,
                          'edited', (new.edited_payload is not null),
                          'reason', case when new.state = 'rejected'
                                         then left(coalesce(new.decision_reason, ''), 500)
                                         else null end,
                          'supersedes', new.supersedes_id
                        )
  );

  return new;
end;
$$;

revoke all on function public.hq_approvals_emit() from public, anon, authenticated;
grant execute on function public.hq_approvals_emit() to service_role;

drop trigger if exists hq_approvals_emit_ins on public.hq_approvals;
create trigger hq_approvals_emit_ins
  after insert on public.hq_approvals
  for each row execute function public.hq_approvals_emit();

drop trigger if exists hq_approvals_emit_upd on public.hq_approvals;
create trigger hq_approvals_emit_upd
  after update on public.hq_approvals
  for each row execute function public.hq_approvals_emit();
