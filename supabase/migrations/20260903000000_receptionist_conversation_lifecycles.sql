-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation LIFECYCLE ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R34:
--  CONVERSATION LIFECYCLE ENGINE).
--
-- R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
-- eligibility; R29 DETERMINES whether that decided execution requires APPROVAL; R30 PERFORMS the approved internal
-- business operation (booking fulfilment) and records it; R31 VERIFIES that performed operation — reconciling the
-- decision against the record and recording an INTEGRITY verdict (consistent / missing / inconsistent); R32 DETERMINES
-- the RECOVERY that verdict warrants (none / reinstate / reconcile) and records it; R33 DETERMINES the RESOLUTION that
-- recovery implies — classifying the conversation into a TERMINAL, RECOVERABLE or UNRESOLVED completion state — and
-- records it. R34 is the NEXT layer — and, in this stack, the FOURTH that does not perform: the Lifecycle Engine takes
-- a DETERMINED resolution and GOVERNS its disposition into the CONVERSATION-LIFECYCLE transition it undergoes and the
-- lifecycle state it comes to rest in, recording an auditable LIFECYCLE here. This migration is that lifecycle's
-- durable, append-only, IDEMPOTENT home. Resolution-lifecycle governance is the FIRST lifecycle type; the record
-- captures WHAT lifecycle was governed (`lifecycle_type` + `lifecycle_outcome`), the TRANSITION the conversation
-- undergoes (`lifecycle_transition`), the STATE it comes to rest in (`lifecycle_state`), WHETHER the conversation is
-- CLOSED (`closed`), WHETHER it remains ONGOING (`ongoing`), the SOURCE resolution state it governed
-- (`resolution_state`), the EXPECTED booking payload (what the resolution concerns), the grant that authorised the
-- underlying operation (`approval_state = 'approved'`), and the anchors that thread it to the resolution it was
-- governed from (`resolution_id`, NOT NULL and UNIQUE — R34's load-bearing anchor AND idempotency key), to the recovery
-- that resolution was determined from (`recovery_id`), to the authorisation that recovery traced (`authorisation_id`),
-- to the verification that recovery classified (`verification_id`), to the fulfilment the verification reconciled
-- (`fulfilment_id`, NULL when the source resolution is RECOVERABLE/MISSING), to the held reply a human approved
-- (`review_audit_id`), to the reply that carried the human's approval (`sent_audit_id`), and to the human's resolution
-- itself in the EXISTING Human Review ledger (`review_resolution_id`).
--
-- IT GOVERNS THE LIFECYCLE FOR APPROVED WORK — AND IT CANNOT GOVERN A LIFECYCLE FOR UNAPPROVED WORK. The
-- `approval_state` column is CHECK-pinned to the single value 'approved' (inherited transitively from R33 → R32 → R31 →
-- R30, whose resolution, recovery, verification and fulfilment can exist ONLY for an approved authorisation): a
-- lifecycle row can exist ONLY for an operation a human GRANTED. The grant lives in the EXISTING Human Review ledger
-- (`receptionist_review_resolutions`, R14, a `sent` resolution) and is folded to 'approved' by R29's
-- `deriveAuthorisationState`; this ledger records the LIFECYCLE of the conversation that grant set in motion, threaded
-- to the lifecycle row (`review_resolution_id`) and the held reply (`review_audit_id`) so the whole chain — held reply
-- → human grant → performed booking → verified integrity → determined recovery → resolved completion → governed
-- lifecycle — joins. R34's law ("govern the lifecycle for approved, resolved work; never bypass Human Review") is made
-- storage: a row here can NEVER represent an un-approved, un-reviewed, or autonomous lifecycle governance.
--
-- IT GOVERNS THE LIFECYCLE — IT NEVER EXECUTES BUSINESS ACTIONS. Unlike R30 (whose row is a PERFORMED business
-- operation), a lifecycle row is a GOVERNANCE: it closes nothing, retains nothing, escalates nothing, re-books nothing,
-- retries nothing, reconciles nothing, schedules nothing, reaches no provider and pages no one. It records that a
-- lifecycle transition was governed (`lifecycle_outcome = 'conversation_lifecycle_governed'`) and the
-- {@link lifecycle_state} the conversation comes to rest in. It is the layer that turns R33's actionable RESOLUTION
-- disposition into an auditable, single-authority CONVERSATION-LIFECYCLE verdict — the transition a future,
-- explicitly-authorised operational capability reads to know what becomes of a conversation. Recovery execution,
-- automatic retries and automatic scheduling are EXPLICIT R34 non-goals; NOTHING in this ledger performs them.
--
-- A LIFECYCLE STATE IS A GOVERNANCE, NOT AN ABSTENTION — A ROW IS FILED FOR ALL THREE. `lifecycle_state` is
-- CHECK-pinned to the closed set (closed / retained / escalated). A lifecycle row is produced for EVERY determined
-- resolution: `closed` (the resolution was `terminal`; the operation completed correctly, so the conversation's
-- lifecycle is complete — but the governance "considered and found complete" is still filed), `retained` (the
-- resolution was `recoverable`; there is a clear recovery path, so the conversation is held open pending it) and
-- `escalated` (the resolution was `unresolved`; the record is ambiguous, so the conversation is raised for operational
-- attention). Governing `retained` and `escalated` is the WHOLE PURPOSE of the engine, so they are first-class states
-- on a filed row — never silent.
--
-- THE STATE IS COHERENT WITH ITS LIFECYCLE FLAGS — enforced by the database. Two CHECKs pin the coherent companions:
-- (`closed`) = (`lifecycle_state = 'closed'`) and (`ongoing`) = (`lifecycle_state <> 'closed'`). The conversation is
-- closed IFF the state is `closed`, and it remains ongoing IFF it is NOT. These are Directive #018 R34's two distinct
-- questions — "has the conversation's lifecycle closed?" and "does it remain ongoing?" — made first-class,
-- coherence-pinned columns. No writer — not even service_role with a direct insert — can file a lifecycle whose flags
-- contradict the state it governs.
--
-- THE STATE IS A DETERMINISTIC TWO-STAGE FOLD OF THE RESOLUTION — enforced by the database. Two CHECKs pin the exact
-- fold. STAGE 1 (the transition fold): the SOURCE resolution state folds to the transition — `terminal` ⇒ `close`,
-- `recoverable` ⇒ `retain`, `unresolved` ⇒ `escalate`. STAGE 2 (the state fold): the transition folds to the resting
-- state — `close` ⇒ `closed`, `retain` ⇒ `retained`, `escalate` ⇒ `escalated`. No writer can file a lifecycle whose
-- transition contradicts the resolution disposition it governs, or whose state contradicts its transition. Combined
-- with the fulfilment-presence coherence CHECK (inherited transitively from R33/R32/R31, `recoverable` iff no
-- `fulfilment_id`), the whole row is deterministic by construction.
--
-- THE FOLD IS ENFORCED BY THE DATABASE — the operation is DETERMINISTIC by construction. A CHECK pins
-- (`lifecycle_type`, `lifecycle_outcome`) to the exact fold (govern_resolution_lifecycle ⇒
-- conversation_lifecycle_governed), and `approval_state` to 'approved' and `status` to 'governed'. No writer can file a
-- lifecycle whose outcome contradicts its type, whose approval is anything but granted, or whose status claims anything
-- but governed.
--
-- IT IS IDEMPOTENT BY CONSTRUCTION — a determined resolution's lifecycle is governed AT MOST ONCE. `resolution_id` is
-- UNIQUE: one lifecycle per resolution. The write primitive inserts ON CONFLICT (resolution_id) DO NOTHING and returns
-- the EXISTING row's id on a repeat, so re-driving the same determined resolution (a retried review-send, a
-- double-fire) never materialises a second lifecycle. This is the storage-layer guarantee behind R34's deterministic
-- governance — distinct from RETRY (an explicit R34 non-goal): the ledger does not re-attempt anything, it makes a
-- repeat a no-op.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. A lifecycle is a fact about one determined resolution governed once,
-- exactly as a resolution (R33), a recovery (R32), a verification (R31), a fulfilment (R30), an authorisation (R29), an
-- execution (R28), an action (R27) and an outcome (R26) are. It gets the SAME first-class, append-only home — not a
-- mutable status column — so a lifecycle state can never be silently rewritten or erased. The confirmation the customer
-- received is STILL produced and audited by the UNCHANGED reply pipeline, the human's GRANT is STILL recorded by the
-- UNCHANGED Human Review architecture (R14), the operation is STILL performed and recorded by the UNCHANGED R30
-- fulfilment ledger, it is STILL verified by the UNCHANGED R31 verification ledger, its recovery is STILL determined by
-- the UNCHANGED R32 recovery ledger, and its resolution is STILL determined by the UNCHANGED R33 resolution ledger;
-- this ledger records the LIFECYCLE state ALONGSIDE them, threaded to the SAME `correlation_id`, so an auditor can join
-- the lifecycle to the resolution it was governed from, the recovery that resolution was determined from, the
-- verification that recovery classified, the fulfilment that verification reconciled, the authorisation it traces, the
-- reply that announced it, and the human who approved it.
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the
-- `receptionist_conversation_resolutions` ledger:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
--     writers/readers; every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role.
--   • A single validated SECURITY DEFINER write entry point, plus a single service-role-only SECURITY DEFINER
--     LIFECYCLE-CONTEXT READER that resolves the RECORDED resolution disposition behind a held reply (the R33
--     resolution the runtime governs into a lifecycle) — both with EXECUTE revoked from PUBLIC / anon /
--     authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + two functions + triggers. No tenant table is touched, no existing
-- column is altered, and no producer is wired by this migration (the server runtime wires the store in
-- TypeScript). References to organisation / conversation / enquiry / customer / action / execution / authorisation
-- / verification / fulfilment / recovery / resolution / held reply / sent reply / review resolution are carried as
-- DENORMALISED, un-FK'd facts (the append-only rule: a lifecycle must outlive the rows it describes, so no
-- `on delete cascade` can ever erase lifecycle history).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_lifecycles — one append-only record per GOVERNED lifecycle. RLS:hq. Captures WHAT
--    lifecycle was governed (`lifecycle_type` + `lifecycle_outcome`), the TRANSITION the conversation undergoes
--    (`lifecycle_transition`), the STATE it comes to rest in (`lifecycle_state`), WHETHER the conversation is CLOSED
--    (`closed`), WHETHER it remains ONGOING (`ongoing`), the SOURCE `resolution_state`, the EXPECTED booking payload,
--    the grant that authorised the underlying operation (`approval_state`), its `status`, and the anchors that thread
--    it to the organisation, conversation, enquiry, customer, prepared action, decided execution and — the load-bearing
--    ones — the resolution it was governed from (`resolution_id`, NOT NULL, UNIQUE), the recovery that resolution was
--    determined from (`recovery_id`), the authorisation that recovery traced (`authorisation_id`), the verification
--    that recovery classified (`verification_id`), the fulfilment that verification reconciled (`fulfilment_id`, NULL
--    when recoverable/MISSING), the held reply a human approved (`review_audit_id`), the reply that carried the
--    approval (`sent_audit_id`) and the human's resolution (`review_resolution_id`).
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_lifecycles (
  id             uuid        primary key default gen_random_uuid(),
  -- WHO / WHERE — durable, un-FK'd facts (survive deletion of the referenced rows).
  org_id         uuid        not null,                 -- the organisation
  conversation_id uuid,                                 -- the conversation (receptionist_conversations.id)
  enquiry_id     uuid,                                  -- the originating inbound_enquiries.id, if known
  lead_id        uuid,                                  -- the customer (leads.id), if a lead exists
  customer_ref   text,                                  -- the caller identifier (phone / handle / email)
  correlation_id uuid        not null,                 -- the end-to-end trace id (shared with the reply audit)
  action_id      uuid,                                  -- the R27 action row, if filed
  execution_id   uuid,                                  -- the R28 execution row, if filed
  -- THE RESOLUTION THIS LIFECYCLE WAS GOVERNED FROM — the R33 `receptionist_conversation_resolutions` row, a soft
  -- (un-FK'd) reference. NOT NULL: a lifecycle is ALWAYS governed from a specific recorded resolution disposition (R34
  -- reads R33's RECORDED disposition and governs it; there is no lifecycle without a resolution to govern). UNIQUE: one
  -- lifecycle per resolution (the idempotency anchor). This is R34's load-bearing anchor — the storage proof that "the
  -- Resolution Engine remains authoritative".
  resolution_id  uuid        not null,
  -- THE RECOVERY THE RESOLUTION WAS DETERMINED FROM — the R32 `receptionist_conversation_recoveries` row, a soft
  -- (un-FK'd) reference. NOT NULL: a lifecycle always traces to the specific recovery its resolution was determined
  -- from.
  recovery_id    uuid        not null,
  -- THE AUTHORISATION THE RECOVERY TRACED — the R29 `receptionist_conversation_authorisations` row, a soft (un-FK'd)
  -- reference. NOT NULL: a lifecycle always traces to the specific approved authorisation its recovery traced.
  authorisation_id uuid      not null,
  -- THE VERIFICATION THE RECOVERY CLASSIFIED — the R31 `receptionist_conversation_verifications` row, a soft (un-FK'd)
  -- reference. NOT NULL: a lifecycle always traces to the specific verification its recovery classified.
  verification_id uuid       not null,
  -- THE FULFILMENT THE VERIFICATION RECONCILED — the R30 `receptionist_conversation_fulfilments` row, a soft (un-FK'd)
  -- reference. NULLABLE: it is NULL exactly when the source resolution is RECOVERABLE (the operation is MISSING), and
  -- NOT NULL for a closed or escalated lifecycle — a coherence CHECK below binds the two (inherited transitively from
  -- R33/R32/R31).
  fulfilment_id  uuid,
  -- THE HUMAN REVIEW CHAIN — the held reply a human approved (`review_audit_id`, the `ai_reply_audits` row the
  -- R14 inbox surfaced), the reply that CARRIED the human's approval to the customer (`sent_audit_id`, the new
  -- `ai_reply_audits` row the send produced) and the human's resolution itself (`review_resolution_id`, the
  -- `receptionist_review_resolutions` row — the grant). All NOT NULL: a lifecycle is governed ONLY downstream of a
  -- human's `sent` resolution, so the full provenance always exists. This is how "never bypass Human Review" is
  -- threaded structurally.
  review_audit_id     uuid   not null,
  sent_audit_id       uuid   not null,
  review_resolution_id uuid  not null,
  -- WHAT lifecycle was governed.
  lifecycle_type       text  not null
                             check (lifecycle_type in ('govern_resolution_lifecycle')),
  -- The GOVERNED result of running the lifecycle — CHECK-pinned to the closed set; folded from the lifecycle type
  -- below. This is the operation R34 performs (a lifecycle transition was governed); the TRANSITION and STATE of that
  -- governance are `lifecycle_transition` + `lifecycle_state`, not this.
  lifecycle_outcome    text  not null
                             check (lifecycle_outcome in ('conversation_lifecycle_governed')),
  -- THE LIFECYCLE TRANSITION — CHECK-pinned to the closed set. The "verb" the conversation undergoes as it moves into
  -- its resting state: `close` (from a `terminal` resolution), `retain` (from a `recoverable` resolution), `escalate`
  -- (from an `unresolved` resolution). This is the operative disposition future operational capabilities read to know
  -- what lifecycle transition a conversation has undergone. R34 records the transition; it carries none of it out.
  lifecycle_transition text  not null
                             check (lifecycle_transition in ('close', 'retain', 'escalate')),
  -- THE LIFECYCLE STATE — CHECK-pinned to the closed set. A row is filed for ALL three: `closed` (the resolution was
  -- `terminal`; the lifecycle is complete, no further attention), `retained` (the resolution was `recoverable`; a clear
  -- recovery path exists, held open pending it), `escalated` (the resolution was `unresolved`; the record is ambiguous,
  -- raised for operational attention). This is the auditable state future operational capabilities read to determine
  -- where a conversation's lifecycle has come to rest (and, if not closed, why).
  lifecycle_state      text  not null
                             check (lifecycle_state in ('closed', 'retained', 'escalated')),
  -- WHETHER THE CONVERSATION IS CLOSED — the coherent companion of the state (true IFF the state is `closed`). Bound to
  -- the state by the closed-coherence CHECK below so it can never drift. This answers Directive #018 R34's question
  -- "has the conversation's lifecycle closed?".
  closed         boolean     not null,
  -- WHETHER THE CONVERSATION REMAINS ONGOING — the coherent companion of the state (true IFF the state is NOT
  -- `closed`). Bound to the state by the ongoing-coherence CHECK below so it can never drift. This answers Directive
  -- #018 R34's question "does the conversation remain ongoing?".
  ongoing        boolean     not null,
  -- THE SOURCE RESOLUTION STATE — the R33 disposition this lifecycle governed, CHECK-pinned to the closed set. Carried
  -- for audit + coherence: the transition fold CHECK binds it to `lifecycle_transition`, and the fulfilment-presence
  -- coherence CHECK (inherited transitively) binds it to the presence of the fulfilment.
  resolution_state text       not null
                             check (resolution_state in ('terminal', 'recoverable', 'unresolved')),
  -- THE GRANT THAT AUTHORISED THE UNDERLYING OPERATION — CHECK-pinned to the single value 'approved', inherited
  -- transitively from R33 → R32 → R31 → R30 (a resolution, and therefore a lifecycle governed from one, can ONLY exist
  -- for an approved authorisation). A pending, rejected or foreclosed authorisation is structurally un-governable. The
  -- grant lives in the EXISTING Human Review ledger; this column records that a grant authorised the operation this
  -- row's resolution concerns.
  approval_state text        not null
                             check (approval_state = 'approved'),
  -- The EXPECTED booking payload — the trade, the place and the number to ring the DECISION concerns (carried through
  -- from the R33 resolution decision, which carried it from R32, which carried it from R31, which carried it from R30).
  -- Each bounded in DDL to its R20 shape so the ledger can never store a malformed expectation. Nullable at the column
  -- level (future lifecycle types may not carry these); the write primitive REQUIRES all three for a
  -- `govern_resolution_lifecycle` lifecycle, regardless of the state (the expectation always exists).
  job_type       text,
  postcode       text        check (postcode is null or postcode ~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'),
  phone_number   text        check (phone_number is null or phone_number ~ '^\+\d{10,15}$'),
  -- GOVERNED BY CONSTRUCTION: a lifecycle transition is GOVERNED, and the row records exactly that. Pinned to the
  -- single value 'governed' so the ledger can never claim a partial, pending or executed lifecycle. (Whether the
  -- conversation is closed, and along which path if not, is `closed` + `lifecycle_state`; a `retained` / `escalated`
  -- state is still a fully `governed` lifecycle — governed, never EXECUTED.)
  status         text        not null default 'governed'
                             check (status = 'governed'),
  -- Lifecycle metadata — the governing path, the strategy/goal it derived from, etc.
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now(),
  -- IDEMPOTENCY — one lifecycle per resolution. Combined with the primitive's ON CONFLICT DO NOTHING, a determined
  -- resolution's lifecycle is governed AT MOST ONCE.
  constraint receptionist_conversation_lifecycles_resolution_unique unique (resolution_id),
  -- THE FOLD, ENFORCED. (`lifecycle_type`, `lifecycle_outcome`) is the exact fold: govern_resolution_lifecycle ⇒
  -- conversation_lifecycle_governed. No row can contradict its own type, so the governed result is deterministic.
  constraint receptionist_conversation_lifecycles_outcome_fold check (
    lifecycle_type = 'govern_resolution_lifecycle' and lifecycle_outcome = 'conversation_lifecycle_governed'
  ),
  -- THE KEYSTONE — STAGE 1: TRANSITION FOLD, ENFORCED. The transition is the exact, deterministic fold of the SOURCE
  -- resolution state: `terminal` ⇒ `close`, `recoverable` ⇒ `retain`, `unresolved` ⇒ `escalate`. No row can contradict
  -- the resolution disposition it governs. This is the R34 analogue of R33's state fold — the first half of the novel
  -- two-stage fold at the heart of this engine.
  constraint receptionist_conversation_lifecycles_transition_fold check (
    (resolution_state = 'terminal' and lifecycle_transition = 'close')
    or (resolution_state = 'recoverable' and lifecycle_transition = 'retain')
    or (resolution_state = 'unresolved' and lifecycle_transition = 'escalate')
  ),
  -- THE KEYSTONE — STAGE 2: STATE FOLD, ENFORCED. The resting lifecycle state is the exact, deterministic fold of the
  -- transition: `close` ⇒ `closed`, `retain` ⇒ `retained`, `escalate` ⇒ `escalated`. The transition and the state are
  -- 1:1 by construction. No row can contradict the transition it undergoes. This is the second half of the two-stage
  -- fold — together with the transition fold, the whole `resolution_state → transition → state` chain is enforced.
  constraint receptionist_conversation_lifecycles_state_fold check (
    (lifecycle_transition = 'close' and lifecycle_state = 'closed')
    or (lifecycle_transition = 'retain' and lifecycle_state = 'retained')
    or (lifecycle_transition = 'escalate' and lifecycle_state = 'escalated')
  ),
  -- CLOSED COHERENCE, ENFORCED. `closed` is TRUE IFF the state is `closed`. The equivalence binds the flag to the
  -- state, so the ledger can never claim the conversation is closed over a `retained`/`escalated` state, or not closed
  -- over a `closed` one. This answers Directive #018 R34's question #1, made storage.
  constraint receptionist_conversation_lifecycles_closed_coherence check (
    closed = (lifecycle_state = 'closed')
  ),
  -- ONGOING COHERENCE, ENFORCED. `ongoing` is TRUE IFF the state is NOT `closed`. The equivalence binds the flag to the
  -- state, so the ledger can never claim the conversation is ongoing over a `closed` state, or not ongoing over a
  -- `retained`/`escalated` one. This answers Directive #018 R34's question #2, made storage.
  constraint receptionist_conversation_lifecycles_ongoing_coherence check (
    ongoing = (lifecycle_state <> 'closed')
  ),
  -- FULFILMENT-PRESENCE COHERENCE, ENFORCED (inherited transitively from R33/R32/R31). A `recoverable` source
  -- resolution means — and can ONLY mean — that no fulfilment was recorded (`fulfilment_id` NULL, the operation is
  -- MISSING); any other resolution state (`terminal` / `unresolved`) means a fulfilment WAS recorded (`fulfilment_id`
  -- NOT NULL). The equivalence binds the source state to the presence of the record, so the ledger can never claim
  -- `recoverable` over a present record or `terminal`/`unresolved` over an absent one.
  constraint receptionist_conversation_lifecycles_fulfilment_coherence check (
    (fulfilment_id is null) = (resolution_state = 'recoverable')
  )
);

create index if not exists receptionist_conversation_lifecycles_org_created_idx
  on public.receptionist_conversation_lifecycles (org_id, created_at desc);
create index if not exists receptionist_conversation_lifecycles_correlation_idx
  on public.receptionist_conversation_lifecycles (correlation_id);
create index if not exists receptionist_conversation_lifecycles_conversation_idx
  on public.receptionist_conversation_lifecycles (conversation_id)
  where conversation_id is not null;
create index if not exists receptionist_conversation_lifecycles_execution_idx
  on public.receptionist_conversation_lifecycles (execution_id)
  where execution_id is not null;
-- The JOIN back to the R33 resolution ledger — find the lifecycle governed from a resolution.
create index if not exists receptionist_conversation_lifecycles_resolution_idx
  on public.receptionist_conversation_lifecycles (resolution_id);
-- The JOIN back to the R32 recovery ledger — find the lifecycle for a determined recovery.
create index if not exists receptionist_conversation_lifecycles_recovery_idx
  on public.receptionist_conversation_lifecycles (recovery_id);
-- The JOIN back to the R31 verification ledger — find the lifecycle for a verified operation.
create index if not exists receptionist_conversation_lifecycles_verification_idx
  on public.receptionist_conversation_lifecycles (verification_id);
-- The JOIN back to the R30 fulfilment ledger — find the lifecycle for a performed fulfilment.
create index if not exists receptionist_conversation_lifecycles_fulfilment_idx
  on public.receptionist_conversation_lifecycles (fulfilment_id)
  where fulfilment_id is not null;
-- The JOIN back to the EXISTING Human Review inbox — find the lifecycle for a held reply a human resolved.
create index if not exists receptionist_conversation_lifecycles_review_audit_idx
  on public.receptionist_conversation_lifecycles (review_audit_id);
-- Lifecycle analytics — how many lifecycles of each type/outcome/transition/state were governed (the lifecycle signal
-- an operator and future operational capabilities watch to find conversations that are closed, retained or escalated).
create index if not exists receptionist_conversation_lifecycles_state_idx
  on public.receptionist_conversation_lifecycles (lifecycle_type, lifecycle_outcome, lifecycle_transition, lifecycle_state, closed, ongoing, status, created_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
-- paths in; every JWT client (anon / authenticated) is denied because an RLS-enabled table with no policies
-- defaults to deny.
alter table public.receptionist_conversation_lifecycles enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a lifecycle is a fact about one governance, never updated or deleted. Reject
--    UPDATE/DELETE even under service_role. Mirrors the R33 resolutions append-only guard.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_lifecycles_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_lifecycles is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_lifecycles_no_update
  on public.receptionist_conversation_lifecycles;
create trigger receptionist_conversation_lifecycles_no_update
  before update on public.receptionist_conversation_lifecycles
  for each row execute function public.receptionist_conversation_lifecycles_block_mutation();

drop trigger if exists receptionist_conversation_lifecycles_no_delete
  on public.receptionist_conversation_lifecycles;
create trigger receptionist_conversation_lifecycles_no_delete
  before delete on public.receptionist_conversation_lifecycles
  for each row execute function public.receptionist_conversation_lifecycles_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_lifecycle — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND ONLY
--    this to record a lifecycle state; the write is BEST-EFFORT there (a failure is logged and swallowed so a
--    durable, audited, human-approved confirmation reply is never undone by a lifecycle write), but the primitive
--    itself validates strictly: the lifecycle type, outcome, transition, state and source resolution state must be in
--    their vocabularies, the approval MUST be 'approved' (the storage-layer Human Review gate, inherited from R33 →
--    R32 → R31 → R30), `closed` MUST be COHERENT with the state (true iff `closed`), `ongoing` MUST be COHERENT with
--    the state (true iff not `closed`), the transition MUST be the deterministic fold of the resolution state, the
--    state MUST be the deterministic fold of the transition, the source resolution state MUST be COHERENT with the
--    presence of the fulfilment (`recoverable` iff no `fulfilment_id`, inherited transitively), a
--    `govern_resolution_lifecycle` MUST carry the expected job type plus a well-formed postcode and E.164 number and
--    the full resolution + Human Review provenance, and the fold CHECK guarantees (type, outcome) match. IDEMPOTENT:
--    ON CONFLICT (resolution_id) DO NOTHING returns the existing lifecycle's id, so a repeat governs nothing. Returns
--    the lifecycle id.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_lifecycle(
  p_org_id                  uuid,
  p_resolution_id           uuid,
  p_recovery_id             uuid,
  p_authorisation_id        uuid,
  p_verification_id         uuid,
  p_lifecycle_type          text,
  p_lifecycle_outcome       text,
  p_lifecycle_transition    text,
  p_lifecycle_state         text,
  p_closed                  boolean,
  p_ongoing                 boolean,
  p_resolution_state        text,
  p_approval_state          text,
  p_correlation_id          uuid,
  p_review_audit_id         uuid,
  p_sent_audit_id           uuid,
  p_review_resolution_id    uuid,
  p_fulfilment_id           uuid    default null,
  p_conversation_id         uuid    default null,
  p_enquiry_id              uuid    default null,
  p_lead_id                 uuid    default null,
  p_customer_ref            text    default null,
  p_action_id               uuid    default null,
  p_execution_id            uuid    default null,
  p_job_type                text    default null,
  p_postcode                text    default null,
  p_phone_number            text    default null,
  p_metadata                jsonb   default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_lifecycle_type not in ('govern_resolution_lifecycle') then
    raise exception 'receptionist lifecycle type must be one of govern_resolution_lifecycle, got %', p_lifecycle_type
      using errcode = 'check_violation';
  end if;

  if p_lifecycle_outcome not in ('conversation_lifecycle_governed') then
    raise exception 'receptionist lifecycle outcome must be one of conversation_lifecycle_governed, got %', p_lifecycle_outcome
      using errcode = 'check_violation';
  end if;

  if p_lifecycle_transition not in ('close', 'retain', 'escalate') then
    raise exception 'receptionist lifecycle transition must be one of close, retain, escalate, got %', p_lifecycle_transition
      using errcode = 'check_violation';
  end if;

  if p_lifecycle_state not in ('closed', 'retained', 'escalated') then
    raise exception 'receptionist lifecycle state must be one of closed, retained, escalated, got %', p_lifecycle_state
      using errcode = 'check_violation';
  end if;

  if p_resolution_state not in ('terminal', 'recoverable', 'unresolved') then
    raise exception 'receptionist lifecycle resolution state must be one of terminal, recoverable, unresolved, got %', p_resolution_state
      using errcode = 'check_violation';
  end if;

  -- THE HUMAN REVIEW GATE, AT THE STORAGE LAYER (inherited from R33 → R32 → R31 → R30). A lifecycle is governed ONLY
  -- for an APPROVED authorisation. The grant is the human's, recorded in the EXISTING Human Review ledger; this
  -- primitive can only ever file a lifecycle whose approval is 'approved'. There is no path to governing a lifecycle
  -- for un-approved work.
  if p_approval_state <> 'approved' then
    raise exception 'receptionist lifecycle requires an approved authorisation (Human Review may not be bypassed), got approval_state=%', p_approval_state
      using errcode = 'check_violation';
  end if;

  -- CLOSED COHERENCE. `closed` is TRUE iff the state is `closed`. Belt-and-braces with the table CHECK: a precise
  -- error for an incoherent call.
  if p_closed <> (p_lifecycle_state = 'closed') then
    raise exception 'receptionist lifecycle closed=% is incoherent with state=% (closed iff state = closed)',
      p_closed, p_lifecycle_state
      using errcode = 'check_violation';
  end if;

  -- ONGOING COHERENCE. `ongoing` is TRUE iff the state is NOT `closed`. Belt-and-braces with the table CHECK: a
  -- precise error for an incoherent call.
  if p_ongoing <> (p_lifecycle_state <> 'closed') then
    raise exception 'receptionist lifecycle ongoing=% is incoherent with state=% (ongoing iff state <> closed)',
      p_ongoing, p_lifecycle_state
      using errcode = 'check_violation';
  end if;

  -- THE TRANSITION FOLD (stage 1). The transition is the exact, deterministic fold of the source resolution state:
  -- terminal ⇒ close, recoverable ⇒ retain, unresolved ⇒ escalate. Belt-and-braces with the table CHECK: a precise
  -- error for a transition that contradicts the resolution it claims to have governed.
  if not (
    (p_resolution_state = 'terminal' and p_lifecycle_transition = 'close')
    or (p_resolution_state = 'recoverable' and p_lifecycle_transition = 'retain')
    or (p_resolution_state = 'unresolved' and p_lifecycle_transition = 'escalate')
  ) then
    raise exception 'receptionist lifecycle transition=% is not the deterministic fold of resolution state=%',
      p_lifecycle_transition, p_resolution_state
      using errcode = 'check_violation';
  end if;

  -- THE STATE FOLD (stage 2). The resting state is the exact, deterministic fold of the transition: close ⇒ closed,
  -- retain ⇒ retained, escalate ⇒ escalated. Belt-and-braces with the table CHECK: a precise error for a state that
  -- contradicts the transition it undergoes.
  if not (
    (p_lifecycle_transition = 'close' and p_lifecycle_state = 'closed')
    or (p_lifecycle_transition = 'retain' and p_lifecycle_state = 'retained')
    or (p_lifecycle_transition = 'escalate' and p_lifecycle_state = 'escalated')
  ) then
    raise exception 'receptionist lifecycle state=% is not the deterministic fold of transition=%',
      p_lifecycle_state, p_lifecycle_transition
      using errcode = 'check_violation';
  end if;

  -- FULFILMENT-PRESENCE COHERENCE (inherited transitively from R33/R32/R31). A `recoverable` source resolution means,
  -- and can ONLY mean, that no fulfilment was recorded (no `fulfilment_id`); any other resolution state means a
  -- fulfilment WAS recorded (`fulfilment_id` present). Belt-and-braces with the table CHECK: a precise error for an
  -- incoherent call.
  if (p_fulfilment_id is null) <> (p_resolution_state = 'recoverable') then
    raise exception 'receptionist lifecycle resolution state=% is incoherent with fulfilment_id=% (recoverable iff no fulfilment)',
      p_resolution_state, coalesce(p_fulfilment_id::text, 'null')
      using errcode = 'check_violation';
  end if;

  -- The resolution anchor, the recovery/authorisation/verification anchors and the full Human Review provenance are
  -- MANDATORY — a lifecycle is ALWAYS governed from a specific recorded resolution, tracing a specific recovery,
  -- authorisation and verification, downstream of a specific human `sent` resolution on a specific held reply.
  if p_resolution_id is null or p_recovery_id is null or p_authorisation_id is null or p_verification_id is null or p_review_audit_id is null or p_sent_audit_id is null or p_review_resolution_id is null then
    raise exception 'receptionist lifecycle requires resolution_id, recovery_id, authorisation_id, verification_id, review_audit_id, sent_audit_id and review_resolution_id (the resolution + Human Review provenance)'
      using errcode = 'check_violation';
  end if;

  -- A govern_resolution_lifecycle lifecycle MUST carry the three facts that identify the EXPECTED visit — the trade,
  -- the place and the number to ring — each well-formed. This is the decision's expectation, present for every
  -- state (including `closed`), so the lifecycle record is self-describing about what the resolution concerns.
  if p_lifecycle_type = 'govern_resolution_lifecycle'
     and (
       p_job_type is null or length(trim(p_job_type)) = 0
       or p_postcode is null or p_postcode !~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'
       or p_phone_number is null or p_phone_number !~ '^\+\d{10,15}$'
     ) then
    raise exception 'receptionist govern_resolution_lifecycle requires an expected job type, a well-formed postcode and a well-formed E.164 phone number, got job_type=%, postcode=%, phone=%',
      coalesce(p_job_type, 'null'), coalesce(p_postcode, 'null'), coalesce(p_phone_number, 'null')
      using errcode = 'check_violation';
  end if;

  -- The (type, outcome) MUST be the fold. Belt-and-braces with the table CHECK: a precise error for a mismatch.
  if not (p_lifecycle_type = 'govern_resolution_lifecycle' and p_lifecycle_outcome = 'conversation_lifecycle_governed') then
    raise exception 'receptionist lifecycle (type=%, outcome=%) does not match the deterministic fold',
      p_lifecycle_type, p_lifecycle_outcome
      using errcode = 'check_violation';
  end if;

  -- IDEMPOTENT INSERT — one lifecycle per resolution. A repeat governs nothing; we return the existing id.
  insert into public.receptionist_conversation_lifecycles (
    org_id, resolution_id, recovery_id, authorisation_id, verification_id, fulfilment_id, lifecycle_type,
    lifecycle_outcome, lifecycle_transition, lifecycle_state, closed, ongoing, resolution_state, approval_state,
    correlation_id, review_audit_id, sent_audit_id, review_resolution_id,
    conversation_id, enquiry_id, lead_id, customer_ref, action_id, execution_id,
    job_type, postcode, phone_number, metadata
  ) values (
    p_org_id, p_resolution_id, p_recovery_id, p_authorisation_id, p_verification_id, p_fulfilment_id, p_lifecycle_type,
    p_lifecycle_outcome, p_lifecycle_transition, p_lifecycle_state, p_closed, p_ongoing, p_resolution_state, p_approval_state,
    p_correlation_id, p_review_audit_id, p_sent_audit_id, p_review_resolution_id,
    p_conversation_id, p_enquiry_id, p_lead_id, p_customer_ref, p_action_id, p_execution_id,
    p_job_type, p_postcode, p_phone_number, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (resolution_id) do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row when the resolution's lifecycle was already governed — resolve the existing
  -- lifecycle's id so the caller always gets a stable id and the operation is a true no-op on repeat.
  if v_id is null then
    select id into v_id
      from public.receptionist_conversation_lifecycles
      where resolution_id = p_resolution_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_lifecycle(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, boolean, boolean, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_lifecycle(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, boolean, boolean, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. find_receptionist_lifecycle_context — the single service-role-only SECURITY DEFINER LIFECYCLE-CONTEXT READER the
--    runtime uses to resolve, in ONE read, the RECORDED resolution disposition behind a held reply a human just
--    approved: the DETERMINED `resolve_booking_recovery` resolution (from the R33
--    `receptionist_conversation_resolutions` ledger — R33's RECORDED disposition, so the runtime can reconstruct the
--    ResolveBookingRecoveryDecision verbatim and govern it through R34's own `resolveConversationLifecycle`). It reads
--    ONLY that ledger (no write), scoped by org and the held reply. The actual lifecycle governance stays in the pure
--    core (R34's `resolveConversationLifecycle`); this reader supplies the recorded resolution, it never governs. This
--    centring on R33's resolution ledger is the storage embodiment of "the Resolution Engine remains authoritative —
--    the Lifecycle Engine consumes its RECORDED decision, it never re-derives it". EXECUTE revoked from PUBLIC / anon /
--    authenticated, granted only to service_role.
-- ---------------------------------------------------------------------------
create or replace function public.find_receptionist_lifecycle_context(
  p_org_id          uuid,
  p_review_audit_id uuid
)
returns table (
  -- The RESOLUTION — the R33 row, so the runtime can reconstruct the ResolveBookingRecoveryDecision and govern it.
  -- Every field is the recorded resolution's own; the runtime reads them into the decision it governs.
  resolution_id         uuid,
  recovery_id           uuid,
  authorisation_id      uuid,
  verification_id       uuid,
  fulfilment_id         uuid,
  conversation_id       uuid,
  enquiry_id            uuid,
  lead_id               uuid,
  customer_ref          text,
  correlation_id        uuid,
  action_id             uuid,
  execution_id          uuid,
  review_audit_id       uuid,
  sent_audit_id         uuid,
  review_resolution_id  uuid,
  resolution_type       text,
  resolution_outcome    text,
  resolution_state      text,
  terminal              boolean,
  intervention_required boolean,
  recovery_classification text,
  approval_state        text,
  job_type              text,
  postcode              text,
  phone_number          text
)
language sql
security definer
set search_path = ''
as $$
  select
    r.id,
    r.recovery_id,
    r.authorisation_id,
    r.verification_id,
    r.fulfilment_id,
    r.conversation_id,
    r.enquiry_id,
    r.lead_id,
    r.customer_ref,
    r.correlation_id,
    r.action_id,
    r.execution_id,
    r.review_audit_id,
    r.sent_audit_id,
    r.review_resolution_id,
    r.resolution_type,
    r.resolution_outcome,
    r.resolution_state,
    r.terminal,
    r.intervention_required,
    r.recovery_classification,
    r.approval_state,
    r.job_type,
    r.postcode,
    r.phone_number
  from public.receptionist_conversation_resolutions r
  where r.org_id = p_org_id
    and r.review_audit_id = p_review_audit_id
    and r.status = 'determined'
  order by r.created_at desc
  limit 1;
$$;

revoke all on function public.find_receptionist_lifecycle_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.find_receptionist_lifecycle_context(uuid, uuid)
  to service_role;
