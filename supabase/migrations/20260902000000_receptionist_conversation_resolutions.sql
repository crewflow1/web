-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation RESOLUTION ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R33:
--  CONVERSATION RESOLUTION ENGINE).
--
-- R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
-- eligibility; R29 DETERMINES whether that decided execution requires APPROVAL; R30 PERFORMS the approved internal
-- business operation (booking fulfilment) and records it; R31 VERIFIES that performed operation — reconciling the
-- decision against the record and recording an INTEGRITY verdict (consistent / missing / inconsistent); R32 DETERMINES
-- the RECOVERY that verdict warrants (none / reinstate / reconcile) and records it. R33 is the NEXT layer — and, in
-- this stack, the THIRD that does not perform: the Resolution Engine takes a DECIDED recovery and CLASSIFIES its
-- disposition into the CONVERSATION-COMPLETION state it implies, recording an auditable RESOLUTION here. This
-- migration is that resolution's durable, append-only, IDEMPOTENT home. Booking-recovery resolution is the FIRST
-- resolution type; the record captures WHAT resolution was determined (`resolution_type` + `resolution_outcome`), the
-- completion STATE it classified the recovery into (`resolution_state`), WHETHER the conversation is TERMINAL
-- (`terminal`), WHETHER further intervention is required (`intervention_required`), the SOURCE recovery classification
-- it resolved (`recovery_classification`), the EXPECTED booking payload (what the recovery concerns), the grant that
-- authorised the underlying operation (`approval_state = 'approved'`), and the anchors that thread it to the recovery
-- it was determined from (`recovery_id`, NOT NULL and UNIQUE — R33's load-bearing anchor AND idempotency key), to the
-- authorisation that recovery traced (`authorisation_id`), to the verification that recovery classified
-- (`verification_id`), to the fulfilment the verification reconciled (`fulfilment_id`, NULL when the operation is
-- MISSING/recoverable), to the held reply a human approved (`review_audit_id`), to the reply that carried the human's
-- approval (`sent_audit_id`), and to the human's resolution itself in the EXISTING Human Review ledger
-- (`review_resolution_id`).
--
-- IT DETERMINES COMPLETION FOR APPROVED WORK — AND IT CANNOT DETERMINE COMPLETION FOR UNAPPROVED WORK. The
-- `approval_state` column is CHECK-pinned to the single value 'approved' (inherited transitively from R32 → R31 → R30,
-- whose recovery, verification and fulfilment can exist ONLY for an approved authorisation): a resolution row can exist
-- ONLY for an operation a human GRANTED. The grant lives in the EXISTING Human Review ledger
-- (`receptionist_review_resolutions`, R14, a `sent` resolution) and is folded to 'approved' by R29's
-- `deriveAuthorisationState`; this ledger records the RESOLUTION of the conversation that grant set in motion, threaded
-- to the resolution row (`review_resolution_id`) and the held reply (`review_audit_id`) so the whole chain — held
-- reply → human grant → performed booking → verified integrity → determined recovery → resolved completion — joins.
-- R33's law ("determine completion for approved, recovered work; never bypass Human Review") is made storage: a row
-- here can NEVER represent an un-approved, un-reviewed, or autonomous resolution determination.
--
-- IT DETERMINES COMPLETION — IT NEVER EXECUTES RECOVERY OR BUSINESS ACTIONS. Unlike R30 (whose row is a PERFORMED
-- business operation), a resolution row is a DETERMINATION: it re-books nothing, retries nothing, reconciles nothing,
-- schedules nothing, reaches no provider and corrects no record. It records that a completion state was determined
-- (`resolution_outcome = 'conversation_resolution_determined'`) and the {@link resolution_state} the conversation is
-- in. It is the layer that turns R32's actionable RECOVERY disposition into an auditable, single-authority
-- CONVERSATION-COMPLETION verdict — the determination a future, explicitly-authorised operational capability reads to
-- know whether a conversation is done. Recovery execution, automatic retries and automatic scheduling are EXPLICIT R33
-- non-goals; NOTHING in this ledger performs them.
--
-- A COMPLETION STATE IS A DETERMINATION, NOT AN ABSTENTION — A ROW IS FILED FOR ALL THREE. `resolution_state` is
-- CHECK-pinned to the closed set (terminal / recoverable / unresolved). A resolution row is produced for EVERY decided
-- recovery: `terminal` (the recovery was `none`; the operation completed correctly, so the conversation is fully
-- resolved — but the determination "considered and found complete" is still filed), `recoverable` (the recovery was
-- `reinstate`; there is a clear recovery path, so the conversation is recoverable) and `unresolved` (the recovery was
-- `reconcile`; the record is ambiguous, so the conversation is unresolved). Classifying `recoverable` and `unresolved`
-- is the WHOLE PURPOSE of the engine, so they are first-class states on a filed row — never silent.
--
-- THE STATE IS COHERENT WITH ITS COMPLETION FLAGS — enforced by the database. Two CHECKs pin the coherent companions:
-- (`terminal`) = (`resolution_state = 'terminal'`) and (`intervention_required`) = (`resolution_state <> 'terminal'`).
-- The conversation is terminal IFF the state is `terminal`, and further intervention is required IFF it is NOT. These
-- are Directive #018 R33's two distinct questions — "is the conversation terminal?" and "is further intervention
-- required?" — made first-class, coherence-pinned columns. No writer — not even service_role with a direct insert —
-- can file a resolution whose completion flags contradict the state it classified.
--
-- THE STATE IS A DETERMINISTIC FOLD OF THE RECOVERY — enforced by the database. A CHECK pins the exact fold of the
-- SOURCE recovery classification to its state: `none` ⇒ `terminal`, `reinstate` ⇒ `recoverable`, `reconcile` ⇒
-- `unresolved`. No writer can file a resolution whose state contradicts the recovery disposition it claims to have
-- resolved. Combined with the fulfilment-presence coherence CHECK (inherited transitively from R32/R31, `reinstate`
-- iff no `fulfilment_id`), the whole row is deterministic by construction.
--
-- THE FOLD IS ENFORCED BY THE DATABASE — the operation is DETERMINISTIC by construction. A CHECK pins
-- (`resolution_type`, `resolution_outcome`) to the exact fold (resolve_booking_recovery ⇒
-- conversation_resolution_determined), and `approval_state` to 'approved' and `status` to 'determined'. No writer can
-- file a resolution whose outcome contradicts its type, whose approval is anything but granted, or whose status claims
-- anything but determined.
--
-- IT IS IDEMPOTENT BY CONSTRUCTION — a determined recovery's resolution is determined AT MOST ONCE. `recovery_id` is
-- UNIQUE: one resolution per recovery. The write primitive inserts ON CONFLICT (recovery_id) DO NOTHING and returns
-- the EXISTING row's id on a repeat, so re-driving the same determined recovery (a retried review-send, a double-fire)
-- never materialises a second resolution. This is the storage-layer guarantee behind R33's deterministic classification
-- — distinct from RETRY (an explicit R33 non-goal): the ledger does not re-attempt anything, it makes a repeat a no-op.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. A resolution is a fact about one determined recovery classified once,
-- exactly as a recovery (R32), a verification (R31), a fulfilment (R30), an authorisation (R29), an execution (R28), an
-- action (R27) and an outcome (R26) are. It gets the SAME first-class, append-only home — not a mutable status column
-- — so a resolution state can never be silently rewritten or erased. The confirmation the customer received is STILL
-- produced and audited by the UNCHANGED reply pipeline, the human's GRANT is STILL recorded by the UNCHANGED Human
-- Review architecture (R14), the operation is STILL performed and recorded by the UNCHANGED R30 fulfilment ledger, it
-- is STILL verified by the UNCHANGED R31 verification ledger, and its recovery is STILL determined by the UNCHANGED R32
-- recovery ledger; this ledger records the RESOLUTION state ALONGSIDE them, threaded to the SAME `correlation_id`, so
-- an auditor can join the resolution to the recovery it was determined from, the verification that recovery classified,
-- the fulfilment that verification reconciled, the authorisation it traces, the reply that announced it, and the human
-- who approved it.
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the
-- `receptionist_conversation_recoveries` ledger:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
--     writers/readers; every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role.
--   • A single validated SECURITY DEFINER write entry point, plus a single service-role-only SECURITY DEFINER
--     RESOLUTION-CONTEXT READER that resolves the RECORDED recovery disposition behind a held reply (the R32
--     recovery the runtime classifies into a resolution) — both with EXECUTE revoked from PUBLIC / anon /
--     authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + two functions + triggers. No tenant table is touched, no existing
-- column is altered, and no producer is wired by this migration (the server runtime wires the store in
-- TypeScript). References to organisation / conversation / enquiry / customer / action / execution / authorisation
-- / verification / fulfilment / recovery / held reply / sent reply / resolution are carried as DENORMALISED, un-FK'd
-- facts (the append-only rule: a resolution must outlive the rows it describes, so no `on delete cascade` can ever
-- erase resolution history).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_resolutions — one append-only record per DETERMINED resolution. RLS:hq. Captures WHAT
--    resolution was determined (`resolution_type` + `resolution_outcome`), the completion STATE it classified the
--    recovery into (`resolution_state`), WHETHER the conversation is TERMINAL (`terminal`), WHETHER further
--    intervention is required (`intervention_required`), the SOURCE `recovery_classification`, the EXPECTED booking
--    payload, the grant that authorised the underlying operation (`approval_state`), its `status`, and the anchors that
--    thread it to the organisation, conversation, enquiry, customer, prepared action, decided execution and — the
--    load-bearing ones — the recovery it was determined from (`recovery_id`, NOT NULL, UNIQUE), the authorisation that
--    recovery traced (`authorisation_id`), the verification that recovery classified (`verification_id`), the
--    fulfilment that verification reconciled (`fulfilment_id`, NULL when recoverable/MISSING), the held reply a human
--    approved (`review_audit_id`), the reply that carried the approval (`sent_audit_id`) and the human's resolution
--    (`review_resolution_id`).
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_resolutions (
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
  -- THE RECOVERY THIS RESOLUTION WAS DETERMINED FROM — the R32 `receptionist_conversation_recoveries` row, a soft
  -- (un-FK'd) reference. NOT NULL: a resolution is ALWAYS determined from a specific recorded recovery disposition (R33
  -- reads R32's RECORDED disposition and classifies it; there is no resolution without a recovery to classify). UNIQUE:
  -- one resolution per recovery (the idempotency anchor). This is R33's load-bearing anchor — the storage proof that
  -- "the Recovery Engine remains authoritative".
  recovery_id    uuid        not null,
  -- THE AUTHORISATION THE RECOVERY TRACED — the R29 `receptionist_conversation_authorisations` row, a soft (un-FK'd)
  -- reference. NOT NULL: a resolution always traces to the specific approved authorisation its recovery traced.
  authorisation_id uuid      not null,
  -- THE VERIFICATION THE RECOVERY CLASSIFIED — the R31 `receptionist_conversation_verifications` row, a soft (un-FK'd)
  -- reference. NOT NULL: a resolution always traces to the specific verification its recovery classified.
  verification_id uuid       not null,
  -- THE FULFILMENT THE VERIFICATION RECONCILED — the R30 `receptionist_conversation_fulfilments` row, a soft (un-FK'd)
  -- reference. NULLABLE: it is NULL exactly when the operation is MISSING (recoverable state), and NOT NULL for a
  -- terminal or unresolved state — a coherence CHECK below binds the two (inherited transitively from R32/R31).
  fulfilment_id  uuid,
  -- THE HUMAN REVIEW CHAIN — the held reply a human approved (`review_audit_id`, the `ai_reply_audits` row the
  -- R14 inbox surfaced), the reply that CARRIED the human's approval to the customer (`sent_audit_id`, the new
  -- `ai_reply_audits` row the send produced) and the human's resolution itself (`review_resolution_id`, the
  -- `receptionist_review_resolutions` row — the grant). All NOT NULL: a resolution is determined ONLY downstream of a
  -- human's `sent` resolution, so the full provenance always exists. This is how "never bypass Human Review" is
  -- threaded structurally.
  review_audit_id     uuid   not null,
  sent_audit_id       uuid   not null,
  review_resolution_id uuid  not null,
  -- WHAT resolution was determined.
  resolution_type      text  not null
                             check (resolution_type in ('resolve_booking_recovery')),
  -- The DETERMINED result of running the resolution — CHECK-pinned to the closed set; folded from the resolution type
  -- below. This is the operation R33 performs (a completion state was determined); the STATE of that determination is
  -- `resolution_state`, not this.
  resolution_outcome   text  not null
                             check (resolution_outcome in ('conversation_resolution_determined')),
  -- THE RESOLUTION STATE — CHECK-pinned to the closed set. A row is filed for ALL three: `terminal` (the recovery was
  -- `none`; the conversation is fully resolved, no further intervention), `recoverable` (the recovery was `reinstate`;
  -- a clear recovery path exists, further intervention required), `unresolved` (the recovery was `reconcile`; the
  -- record is ambiguous, further intervention required). This is the auditable state future operational capabilities
  -- read to determine whether a conversation is complete (and, if not, along which path).
  resolution_state     text  not null
                             check (resolution_state in ('terminal', 'recoverable', 'unresolved')),
  -- WHETHER THE CONVERSATION IS TERMINAL — the coherent companion of the state (true IFF the state is `terminal`).
  -- Bound to the state by the terminal-coherence CHECK below so it can never drift. This answers Directive #018 R33's
  -- question "has the conversation reached a terminal state?".
  terminal       boolean     not null,
  -- WHETHER FURTHER INTERVENTION IS REQUIRED — the coherent companion of the state (true IFF the state is NOT
  -- `terminal`). Bound to the state by the intervention-coherence CHECK below so it can never drift. This answers
  -- Directive #018 R33's question "is further intervention required?".
  intervention_required boolean not null,
  -- THE SOURCE RECOVERY CLASSIFICATION — the R32 disposition this resolution classified, CHECK-pinned to the closed
  -- set. Carried for audit + coherence: the state fold CHECK binds it to `resolution_state`, and the fulfilment-presence
  -- coherence CHECK (inherited transitively) binds it to the presence of the fulfilment.
  recovery_classification text not null
                             check (recovery_classification in ('none', 'reinstate', 'reconcile')),
  -- THE GRANT THAT AUTHORISED THE UNDERLYING OPERATION — CHECK-pinned to the single value 'approved', inherited
  -- transitively from R32 → R31 → R30 (a recovery, and therefore a resolution determined from one, can ONLY exist for
  -- an approved authorisation). A pending, rejected or foreclosed authorisation is structurally unresolvable. The grant
  -- lives in the EXISTING Human Review ledger; this column records that a grant authorised the operation this row's
  -- recovery concerns.
  approval_state text        not null
                             check (approval_state = 'approved'),
  -- The EXPECTED booking payload — the trade, the place and the number to ring the DECISION concerns (carried through
  -- from the R32 recovery decision, which carried it from R31, which carried it from R30). Each bounded in DDL to its
  -- R20 shape so the ledger can never store a malformed expectation. Nullable at the column level (future resolution
  -- types may not carry these); the write primitive REQUIRES all three for a `resolve_booking_recovery` resolution,
  -- regardless of the state (the expectation always exists).
  job_type       text,
  postcode       text        check (postcode is null or postcode ~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'),
  phone_number   text        check (phone_number is null or phone_number ~ '^\+\d{10,15}$'),
  -- DETERMINED BY CONSTRUCTION: a resolution state is DETERMINED, and the row records exactly that. Pinned to the
  -- single value 'determined' so the ledger can never claim a partial, pending or executed resolution. (Whether the
  -- conversation is terminal, and along which path if not, is `terminal` + `resolution_state`; a `recoverable` /
  -- `unresolved` state is still a fully `determined` resolution — determined, never EXECUTED.)
  status         text        not null default 'determined'
                             check (status = 'determined'),
  -- Resolution metadata — the resolving path, the strategy/goal it derived from, etc.
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now(),
  -- IDEMPOTENCY — one resolution per recovery. Combined with the primitive's ON CONFLICT DO NOTHING, a determined
  -- recovery's resolution is determined AT MOST ONCE.
  constraint receptionist_conversation_resolutions_recovery_unique unique (recovery_id),
  -- THE FOLD, ENFORCED. (`resolution_type`, `resolution_outcome`) is the exact fold: resolve_booking_recovery ⇒
  -- conversation_resolution_determined. No row can contradict its own type, so the determined result is deterministic.
  constraint receptionist_conversation_resolutions_outcome_fold check (
    resolution_type = 'resolve_booking_recovery' and resolution_outcome = 'conversation_resolution_determined'
  ),
  -- THE KEYSTONE: STATE FOLD, ENFORCED. The completion state is the exact, deterministic fold of the SOURCE recovery
  -- classification: `none` ⇒ `terminal`, `reinstate` ⇒ `recoverable`, `reconcile` ⇒ `unresolved`. No row can contradict
  -- the recovery disposition it classified. This is the R33 analogue of R32's classification fold — the novel fold at
  -- the heart of this engine.
  constraint receptionist_conversation_resolutions_state_fold check (
    (recovery_classification = 'none' and resolution_state = 'terminal')
    or (recovery_classification = 'reinstate' and resolution_state = 'recoverable')
    or (recovery_classification = 'reconcile' and resolution_state = 'unresolved')
  ),
  -- TERMINAL COHERENCE, ENFORCED. `terminal` is TRUE IFF the state is `terminal`. The equivalence binds the flag to the
  -- state, so the ledger can never claim the conversation is terminal over a `recoverable`/`unresolved` state, or
  -- non-terminal over a `terminal` one. This answers Directive #018 R33's question #2, made storage.
  constraint receptionist_conversation_resolutions_terminal_coherence check (
    terminal = (resolution_state = 'terminal')
  ),
  -- INTERVENTION COHERENCE, ENFORCED. `intervention_required` is TRUE IFF the state is NOT `terminal`. The equivalence
  -- binds the flag to the state, so the ledger can never claim intervention is required over a `terminal` state, or not
  -- required over a `recoverable`/`unresolved` one. This answers Directive #018 R33's question #3, made storage.
  constraint receptionist_conversation_resolutions_intervention_coherence check (
    intervention_required = (resolution_state <> 'terminal')
  ),
  -- FULFILMENT-PRESENCE COHERENCE, ENFORCED (inherited transitively from R32/R31). A `reinstate` classification means —
  -- and can ONLY mean — that no fulfilment was recorded (`fulfilment_id` NULL, the operation is MISSING/recoverable);
  -- any other classification (`none` / `reconcile`) means a fulfilment WAS recorded (`fulfilment_id` NOT NULL). The
  -- equivalence binds the classification to the presence of the record, so the ledger can never claim `reinstate` over
  -- a present record or `none`/`reconcile` over an absent one.
  constraint receptionist_conversation_resolutions_fulfilment_coherence check (
    (fulfilment_id is null) = (recovery_classification = 'reinstate')
  )
);

create index if not exists receptionist_conversation_resolutions_org_created_idx
  on public.receptionist_conversation_resolutions (org_id, created_at desc);
create index if not exists receptionist_conversation_resolutions_correlation_idx
  on public.receptionist_conversation_resolutions (correlation_id);
create index if not exists receptionist_conversation_resolutions_conversation_idx
  on public.receptionist_conversation_resolutions (conversation_id)
  where conversation_id is not null;
create index if not exists receptionist_conversation_resolutions_execution_idx
  on public.receptionist_conversation_resolutions (execution_id)
  where execution_id is not null;
-- The JOIN back to the R32 recovery ledger — find the resolution determined from a recovery.
create index if not exists receptionist_conversation_resolutions_recovery_idx
  on public.receptionist_conversation_resolutions (recovery_id);
-- The JOIN back to the R31 verification ledger — find the resolution for a verified operation.
create index if not exists receptionist_conversation_resolutions_verification_idx
  on public.receptionist_conversation_resolutions (verification_id);
-- The JOIN back to the R30 fulfilment ledger — find the resolution for a performed fulfilment.
create index if not exists receptionist_conversation_resolutions_fulfilment_idx
  on public.receptionist_conversation_resolutions (fulfilment_id)
  where fulfilment_id is not null;
-- The JOIN back to the EXISTING Human Review inbox — find the resolution for a held reply a human resolved.
create index if not exists receptionist_conversation_resolutions_review_audit_idx
  on public.receptionist_conversation_resolutions (review_audit_id);
-- Resolution analytics — how many resolutions of each type/outcome/state were determined (the completion signal an
-- operator and future operational capabilities watch to find conversations that are terminal, recoverable or
-- unresolved).
create index if not exists receptionist_conversation_resolutions_state_idx
  on public.receptionist_conversation_resolutions (resolution_type, resolution_outcome, resolution_state, terminal, intervention_required, status, created_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
-- paths in; every JWT client (anon / authenticated) is denied because an RLS-enabled table with no policies
-- defaults to deny.
alter table public.receptionist_conversation_resolutions enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a resolution is a fact about one determination, never updated or deleted. Reject
--    UPDATE/DELETE even under service_role. Mirrors the R32 recoveries append-only guard.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_resolutions_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_resolutions is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_resolutions_no_update
  on public.receptionist_conversation_resolutions;
create trigger receptionist_conversation_resolutions_no_update
  before update on public.receptionist_conversation_resolutions
  for each row execute function public.receptionist_conversation_resolutions_block_mutation();

drop trigger if exists receptionist_conversation_resolutions_no_delete
  on public.receptionist_conversation_resolutions;
create trigger receptionist_conversation_resolutions_no_delete
  before delete on public.receptionist_conversation_resolutions
  for each row execute function public.receptionist_conversation_resolutions_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_resolution — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND ONLY
--    this to record a resolution state; the write is BEST-EFFORT there (a failure is logged and swallowed so a
--    durable, audited, human-approved confirmation reply is never undone by a resolution write), but the primitive
--    itself validates strictly: the resolution type, outcome, state and source classification must be in their
--    vocabularies, the approval MUST be 'approved' (the storage-layer Human Review gate, inherited from R32 → R31 →
--    R30), `terminal` MUST be COHERENT with the state (true iff `terminal`), `intervention_required` MUST be COHERENT
--    with the state (true iff not `terminal`), the state MUST be the deterministic fold of the recovery classification,
--    the classification MUST be COHERENT with the presence of the fulfilment (`reinstate` iff no `fulfilment_id`,
--    inherited transitively), a `resolve_booking_recovery` MUST carry the expected job type plus a well-formed postcode
--    and E.164 number and the full recovery + Human Review provenance, and the fold CHECK guarantees (type, outcome)
--    match. IDEMPOTENT: ON CONFLICT (recovery_id) DO NOTHING returns the existing resolution's id, so a repeat
--    determines nothing. Returns the resolution id.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_resolution(
  p_org_id                  uuid,
  p_recovery_id             uuid,
  p_authorisation_id        uuid,
  p_verification_id         uuid,
  p_resolution_type         text,
  p_resolution_outcome      text,
  p_resolution_state        text,
  p_terminal                boolean,
  p_intervention_required   boolean,
  p_recovery_classification text,
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
  if p_resolution_type not in ('resolve_booking_recovery') then
    raise exception 'receptionist resolution type must be one of resolve_booking_recovery, got %', p_resolution_type
      using errcode = 'check_violation';
  end if;

  if p_resolution_outcome not in ('conversation_resolution_determined') then
    raise exception 'receptionist resolution outcome must be one of conversation_resolution_determined, got %', p_resolution_outcome
      using errcode = 'check_violation';
  end if;

  if p_resolution_state not in ('terminal', 'recoverable', 'unresolved') then
    raise exception 'receptionist resolution state must be one of terminal, recoverable, unresolved, got %', p_resolution_state
      using errcode = 'check_violation';
  end if;

  if p_recovery_classification not in ('none', 'reinstate', 'reconcile') then
    raise exception 'receptionist resolution recovery classification must be one of none, reinstate, reconcile, got %', p_recovery_classification
      using errcode = 'check_violation';
  end if;

  -- THE HUMAN REVIEW GATE, AT THE STORAGE LAYER (inherited from R32 → R31 → R30). A resolution is determined ONLY for
  -- an APPROVED authorisation. The grant is the human's, recorded in the EXISTING Human Review ledger; this primitive
  -- can only ever file a resolution whose approval is 'approved'. There is no path to determining completion for
  -- un-approved work.
  if p_approval_state <> 'approved' then
    raise exception 'receptionist resolution requires an approved authorisation (Human Review may not be bypassed), got approval_state=%', p_approval_state
      using errcode = 'check_violation';
  end if;

  -- TERMINAL COHERENCE. `terminal` is TRUE iff the state is `terminal`. Belt-and-braces with the table CHECK: a
  -- precise error for an incoherent call.
  if p_terminal <> (p_resolution_state = 'terminal') then
    raise exception 'receptionist resolution terminal=% is incoherent with state=% (terminal iff state = terminal)',
      p_terminal, p_resolution_state
      using errcode = 'check_violation';
  end if;

  -- INTERVENTION COHERENCE. `intervention_required` is TRUE iff the state is NOT `terminal`. Belt-and-braces with the
  -- table CHECK: a precise error for an incoherent call.
  if p_intervention_required <> (p_resolution_state <> 'terminal') then
    raise exception 'receptionist resolution intervention_required=% is incoherent with state=% (required iff state <> terminal)',
      p_intervention_required, p_resolution_state
      using errcode = 'check_violation';
  end if;

  -- THE STATE FOLD. The completion state is the exact, deterministic fold of the source recovery classification:
  -- none ⇒ terminal, reinstate ⇒ recoverable, reconcile ⇒ unresolved. Belt-and-braces with the table CHECK: a
  -- precise error for a state that contradicts the classification it claims to have resolved.
  if not (
    (p_recovery_classification = 'none' and p_resolution_state = 'terminal')
    or (p_recovery_classification = 'reinstate' and p_resolution_state = 'recoverable')
    or (p_recovery_classification = 'reconcile' and p_resolution_state = 'unresolved')
  ) then
    raise exception 'receptionist resolution state=% is not the deterministic fold of recovery classification=%',
      p_resolution_state, p_recovery_classification
      using errcode = 'check_violation';
  end if;

  -- FULFILMENT-PRESENCE COHERENCE (inherited transitively from R32/R31). A `reinstate` classification means, and can
  -- ONLY mean, that no fulfilment was recorded (no `fulfilment_id`); any other classification means a fulfilment WAS
  -- recorded (`fulfilment_id` present). Belt-and-braces with the table CHECK: a precise error for an incoherent call.
  if (p_fulfilment_id is null) <> (p_recovery_classification = 'reinstate') then
    raise exception 'receptionist resolution recovery classification=% is incoherent with fulfilment_id=% (reinstate iff no fulfilment)',
      p_recovery_classification, coalesce(p_fulfilment_id::text, 'null')
      using errcode = 'check_violation';
  end if;

  -- The recovery anchor, the authorisation/verification anchors and the full Human Review provenance are MANDATORY — a
  -- resolution is ALWAYS determined from a specific recorded recovery, tracing a specific authorisation and
  -- verification, downstream of a specific human `sent` resolution on a specific held reply.
  if p_recovery_id is null or p_authorisation_id is null or p_verification_id is null or p_review_audit_id is null or p_sent_audit_id is null or p_review_resolution_id is null then
    raise exception 'receptionist resolution requires recovery_id, authorisation_id, verification_id, review_audit_id, sent_audit_id and review_resolution_id (the recovery + Human Review provenance)'
      using errcode = 'check_violation';
  end if;

  -- A resolve_booking_recovery resolution MUST carry the three facts that identify the EXPECTED visit — the trade,
  -- the place and the number to ring — each well-formed. This is the decision's expectation, present for every
  -- state (including `terminal`), so the resolution record is self-describing about what the recovery concerns.
  if p_resolution_type = 'resolve_booking_recovery'
     and (
       p_job_type is null or length(trim(p_job_type)) = 0
       or p_postcode is null or p_postcode !~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'
       or p_phone_number is null or p_phone_number !~ '^\+\d{10,15}$'
     ) then
    raise exception 'receptionist resolve_booking_recovery requires an expected job type, a well-formed postcode and a well-formed E.164 phone number, got job_type=%, postcode=%, phone=%',
      coalesce(p_job_type, 'null'), coalesce(p_postcode, 'null'), coalesce(p_phone_number, 'null')
      using errcode = 'check_violation';
  end if;

  -- The (type, outcome) MUST be the fold. Belt-and-braces with the table CHECK: a precise error for a mismatch.
  if not (p_resolution_type = 'resolve_booking_recovery' and p_resolution_outcome = 'conversation_resolution_determined') then
    raise exception 'receptionist resolution (type=%, outcome=%) does not match the deterministic fold',
      p_resolution_type, p_resolution_outcome
      using errcode = 'check_violation';
  end if;

  -- IDEMPOTENT INSERT — one resolution per recovery. A repeat determines nothing; we return the existing id.
  insert into public.receptionist_conversation_resolutions (
    org_id, recovery_id, authorisation_id, verification_id, fulfilment_id, resolution_type, resolution_outcome,
    resolution_state, terminal, intervention_required, recovery_classification, approval_state,
    correlation_id, review_audit_id, sent_audit_id, review_resolution_id,
    conversation_id, enquiry_id, lead_id, customer_ref, action_id, execution_id,
    job_type, postcode, phone_number, metadata
  ) values (
    p_org_id, p_recovery_id, p_authorisation_id, p_verification_id, p_fulfilment_id, p_resolution_type, p_resolution_outcome,
    p_resolution_state, p_terminal, p_intervention_required, p_recovery_classification, p_approval_state,
    p_correlation_id, p_review_audit_id, p_sent_audit_id, p_review_resolution_id,
    p_conversation_id, p_enquiry_id, p_lead_id, p_customer_ref, p_action_id, p_execution_id,
    p_job_type, p_postcode, p_phone_number, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (recovery_id) do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row when the recovery's resolution was already determined — resolve the existing
  -- resolution's id so the caller always gets a stable id and the operation is a true no-op on repeat.
  if v_id is null then
    select id into v_id
      from public.receptionist_conversation_resolutions
      where recovery_id = p_recovery_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_resolution(
  uuid, uuid, uuid, uuid, text, text, text, boolean, boolean, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_resolution(
  uuid, uuid, uuid, uuid, text, text, text, boolean, boolean, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. find_receptionist_resolution_context — the single service-role-only SECURITY DEFINER RESOLUTION-CONTEXT READER the
--    runtime uses to resolve, in ONE read, the RECORDED recovery disposition behind a held reply a human just
--    approved: the DECIDED `recover_booking_fulfilment` recovery (from the R32
--    `receptionist_conversation_recoveries` ledger — R32's RECORDED disposition, so the runtime can reconstruct the
--    RecoverBookingDecision verbatim and classify it through R33's own `resolveConversationResolution`). It reads ONLY
--    that ledger (no write), scoped by org and the held reply. The actual completion classification stays in the pure
--    core (R33's `resolveConversationResolution`); this reader supplies the recorded recovery, it never decides. This
--    centring on R32's recovery ledger is the storage embodiment of "the Recovery Engine remains authoritative — the
--    Resolution Engine consumes its RECORDED decision, it never re-derives it". EXECUTE revoked from PUBLIC / anon /
--    authenticated, granted only to service_role.
-- ---------------------------------------------------------------------------
create or replace function public.find_receptionist_resolution_context(
  p_org_id          uuid,
  p_review_audit_id uuid
)
returns table (
  -- The RECOVERY — the R32 row, so the runtime can reconstruct the RecoverBookingDecision and classify it. Every
  -- field is the recorded recovery's own; the runtime reads them into the decision it classifies.
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
  recovery_type         text,
  recovery_outcome      text,
  recovery_classification text,
  recovery_required     boolean,
  integrity             text,
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
    r.recovery_type,
    r.recovery_outcome,
    r.recovery_classification,
    r.recovery_required,
    r.integrity,
    r.approval_state,
    r.job_type,
    r.postcode,
    r.phone_number
  from public.receptionist_conversation_recoveries r
  where r.org_id = p_org_id
    and r.review_audit_id = p_review_audit_id
    and r.status = 'determined'
  order by r.created_at desc
  limit 1;
$$;

revoke all on function public.find_receptionist_resolution_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.find_receptionist_resolution_context(uuid, uuid)
  to service_role;
