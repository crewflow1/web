-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation RECOVERY ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R32:
--  CONVERSATION RECOVERY ENGINE).
--
-- R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
-- eligibility; R29 DETERMINES whether that decided execution requires APPROVAL; R30 PERFORMS the approved internal
-- business operation (booking fulfilment) and records it; R31 VERIFIES that performed operation — reconciling the
-- decision against the record and recording an auditable INTEGRITY verdict (consistent / missing / inconsistent).
-- R32 is the NEXT layer — and, in this stack, the SECOND that does not perform: the Recovery Engine takes a DECIDED
-- verification and CLASSIFIES its integrity verdict into the RECOVERY it warrants, recording an auditable RECOVERY
-- disposition here. This migration is that disposition's durable, append-only, IDEMPOTENT home. Fulfilment recovery
-- is the FIRST recovery type; the record captures WHAT recovery was determined (`recovery_type` +
-- `recovery_outcome`), the DISPOSITION it classified the verdict into (`recovery_classification`), WHETHER recovery
-- is required (`recovery_required`), the SOURCE integrity verdict it classified (`integrity`), the EXPECTED booking
-- payload (what the decision said should have been performed), the grant that authorised the underlying operation
-- (`approval_state = 'approved'`), and the anchors that thread it to the verification it was determined from
-- (`verification_id`, NOT NULL — R32's load-bearing anchor), to the authorisation the verification verified
-- (`authorisation_id`), to the fulfilment that verification reconciled (`fulfilment_id`, NULL when the operation is
-- MISSING), to the held reply a human approved (`review_audit_id`), to the reply that carried the human's approval
-- (`sent_audit_id`), and to the human's resolution itself in the EXISTING Human Review ledger
-- (`review_resolution_id`).
--
-- IT DETERMINES RECOVERY FOR APPROVED WORK — AND IT CANNOT DETERMINE RECOVERY FOR UNAPPROVED WORK. The
-- `approval_state` column is CHECK-pinned to the single value 'approved' (inherited transitively from R31 → R30,
-- whose verification and fulfilment can exist ONLY for an approved authorisation): a recovery row can exist ONLY for
-- an operation a human GRANTED. The grant lives in the EXISTING Human Review ledger
-- (`receptionist_review_resolutions`, R14, a `sent` resolution) and is folded to 'approved' by R29's
-- `deriveAuthorisationState`; this ledger records the RECOVERY DISPOSITION of the operation that grant authorised,
-- threaded to the resolution row (`review_resolution_id`) and the held reply (`review_audit_id`) so the whole chain
-- — held reply → human grant → performed booking → verified integrity → determined recovery — joins. R32's law
-- ("determine recovery for approved, verified work; never bypass Human Review") is made storage: a row here can
-- NEVER represent an un-approved, un-reviewed, or autonomous recovery determination.
--
-- IT DETERMINES RECOVERY — IT NEVER EXECUTES IT. Unlike R30 (whose row is a PERFORMED business operation), a
-- recovery row is a DETERMINATION: it re-books nothing, retries nothing, schedules nothing, reaches no provider and
-- corrects no record. It records that a recovery disposition was determined (`recovery_outcome =
-- 'fulfilment_recovery_determined'`) and the {@link recovery_classification} it warrants. It is the layer that turns
-- R31's observable INTEGRITY signal into an auditable, actionable RECOVERY disposition — the determination a future,
-- explicitly-authorised operational capability reads and acts on. Automatic retries, automatic booking recreation
-- and automatic scheduling are EXPLICIT R32 non-goals; NOTHING in this ledger performs them.
--
-- A DISPOSITION IS A DETERMINATION, NOT AN ABSTENTION — A ROW IS FILED FOR ALL THREE. `recovery_classification` is
-- CHECK-pinned to the closed set (none / reinstate / reconcile). A recovery row is produced for EVERY decided
-- verification: `none` (the verification was `consistent`; the operation completed correctly, so NO recovery is
-- required — but the determination "considered and found unnecessary" is still filed), `reinstate` (the
-- verification was `missing`; the unrecorded operation warrants REINSTATEMENT) and `reconcile` (the verification was
-- `inconsistent`; the divergent record warrants RECONCILIATION). Classifying `reinstate` and `reconcile` is the
-- WHOLE PURPOSE of the engine, so they are first-class dispositions on a filed row — never silent.
--
-- THE DISPOSITION IS COHERENT WITH ITS REQUIREMENT — enforced by the database. A CHECK pins
-- (`recovery_required`) = (`recovery_classification <> 'none'`): recovery is required IFF the classification is a
-- real recovery (`reinstate` or `reconcile`), and NOT required IFF the classification is `none`. This is R32's
-- keystone — the analogue of R31's integrity coherence. No writer — not even service_role with a direct insert — can
-- file a recovery whose `recovery_required` flag contradicts the disposition it classified.
--
-- THE CLASSIFICATION IS A DETERMINISTIC FOLD OF THE VERDICT — enforced by the database. A CHECK pins the exact fold
-- of the SOURCE integrity verdict to its classification: `consistent` ⇒ `none`, `missing` ⇒ `reinstate`,
-- `inconsistent` ⇒ `reconcile`. No writer can file a recovery whose classification contradicts the verification
-- verdict it claims to have classified. Combined with the integrity coherence CHECK (inherited from R31,
-- `missing` iff no `fulfilment_id`), the whole row is deterministic by construction.
--
-- THE FOLD IS ENFORCED BY THE DATABASE — the operation is DETERMINISTIC by construction. A CHECK pins
-- (`recovery_type`, `recovery_outcome`) to the exact fold (recover_booking_fulfilment ⇒
-- fulfilment_recovery_determined), and `approval_state` to 'approved' and `status` to 'determined'. No writer can
-- file a recovery whose outcome contradicts its type, whose approval is anything but granted, or whose status claims
-- anything but determined.
--
-- IT IS IDEMPOTENT BY CONSTRUCTION — a verified fulfilment's recovery is determined AT MOST ONCE. `authorisation_id`
-- is UNIQUE: one recovery per authorisation. The write primitive inserts ON CONFLICT (authorisation_id) DO NOTHING
-- and returns the EXISTING row's id on a repeat, so re-driving the same approved authorisation (a retried
-- review-send, a double-fire) never materialises a second recovery. This is the storage-layer guarantee behind
-- R32's deterministic classification — distinct from RETRY (an explicit R32 non-goal): the ledger does not
-- re-attempt anything, it makes a repeat a no-op.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. A recovery is a fact about one verified fulfilment classified once,
-- exactly as a verification (R31), a fulfilment (R30), an authorisation (R29), an execution (R28), an action (R27)
-- and an outcome (R26) are. It gets the SAME first-class, append-only home — not a mutable status column — so a
-- recovery disposition can never be silently rewritten or erased. The confirmation the customer received is STILL
-- produced and audited by the UNCHANGED reply pipeline, the human's GRANT is STILL recorded by the UNCHANGED Human
-- Review architecture (R14), the operation is STILL performed and recorded by the UNCHANGED R30 fulfilment ledger,
-- and it is STILL verified by the UNCHANGED R31 verification ledger; this ledger records the RECOVERY disposition
-- ALONGSIDE them, threaded to the SAME `correlation_id`, so an auditor can join the recovery to the verification it
-- was determined from, the fulfilment that verification reconciled, the authorisation it verifies, the reply that
-- announced it, and the human who approved it.
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the
-- `receptionist_conversation_verifications` ledger:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
--     writers/readers; every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role.
--   • A single validated SECURITY DEFINER write entry point, plus a single service-role-only SECURITY DEFINER
--     RECOVERY-CONTEXT READER that resolves the RECORDED verification verdict behind a held reply (the R31
--     verification the runtime classifies into a recovery) — both with EXECUTE revoked from PUBLIC / anon /
--     authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + two functions + triggers. No tenant table is touched, no existing
-- column is altered, and no producer is wired by this migration (the server runtime wires the store in
-- TypeScript). References to organisation / conversation / enquiry / customer / action / execution / authorisation
-- / fulfilment / verification / held reply / sent reply / resolution are carried as DENORMALISED, un-FK'd facts (the
-- append-only rule: a recovery must outlive the rows it describes, so no `on delete cascade` can ever erase recovery
-- history).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_recoveries — one append-only record per DETERMINED recovery. RLS:hq. Captures WHAT
--    recovery was determined (`recovery_type` + `recovery_outcome`), the DISPOSITION it classified the verdict into
--    (`recovery_classification`), WHETHER recovery is required (`recovery_required`), the SOURCE `integrity` verdict,
--    the EXPECTED booking payload, the grant that authorised the underlying operation (`approval_state`), its
--    `status`, and the anchors that thread it to the organisation, conversation, enquiry, customer, prepared action,
--    decided execution and — the load-bearing ones — the verification it was determined from (`verification_id`,
--    NOT NULL), the authorisation that verification verified (`authorisation_id`, UNIQUE), the fulfilment that
--    verification reconciled (`fulfilment_id`, NULL when MISSING), the held reply a human approved
--    (`review_audit_id`), the reply that carried the approval (`sent_audit_id`) and the human's resolution
--    (`review_resolution_id`).
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_recoveries (
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
  -- THE VERIFICATION THIS RECOVERY WAS DETERMINED FROM — the R31 `receptionist_conversation_verifications` row, a
  -- soft (un-FK'd) reference. NOT NULL: a recovery is ALWAYS determined from a specific recorded verification verdict
  -- (R32 reads R31's RECORDED verdict and classifies it; there is no recovery without a verification to classify).
  -- This is R32's load-bearing anchor — the storage proof that "the Verification Engine remains authoritative".
  verification_id uuid       not null,
  -- THE AUTHORISATION THE VERIFICATION VERIFIED — the R29 `receptionist_conversation_authorisations` row, a soft
  -- (un-FK'd) reference. UNIQUE: one recovery per authorisation (the idempotency anchor). NOT NULL: a recovery always
  -- traces to the specific approved authorisation its verification verified.
  authorisation_id uuid      not null,
  -- THE FULFILMENT THE VERIFICATION RECONCILED — the R30 `receptionist_conversation_fulfilments` row, a soft
  -- (un-FK'd) reference. NULLABLE: it is NULL exactly when the operation is MISSING (decided but never recorded),
  -- and NOT NULL for a `consistent` or `inconsistent` verdict — a coherence CHECK below binds the two (inherited from
  -- R31).
  fulfilment_id  uuid,
  -- THE HUMAN REVIEW CHAIN — the held reply a human approved (`review_audit_id`, the `ai_reply_audits` row the
  -- R14 inbox surfaced), the reply that CARRIED the human's approval to the customer (`sent_audit_id`, the new
  -- `ai_reply_audits` row the send produced) and the human's resolution itself (`review_resolution_id`, the
  -- `receptionist_review_resolutions` row — the grant). All NOT NULL: a recovery is determined ONLY downstream of a
  -- human's `sent` resolution, so the full provenance always exists. This is how "never bypass Human Review" is
  -- threaded structurally.
  review_audit_id     uuid   not null,
  sent_audit_id       uuid   not null,
  review_resolution_id uuid  not null,
  -- WHAT recovery was determined.
  recovery_type        text  not null
                             check (recovery_type in ('recover_booking_fulfilment')),
  -- The DETERMINED result of running the recovery — CHECK-pinned to the closed set; folded from the recovery type
  -- below. This is the operation R32 performs (a recovery disposition was determined); the DISPOSITION of that
  -- determination is `recovery_classification`, not this.
  recovery_outcome     text  not null
                             check (recovery_outcome in ('fulfilment_recovery_determined')),
  -- THE RECOVERY DISPOSITION — CHECK-pinned to the closed set. A row is filed for ALL three: `none` (the verification
  -- was `consistent`; no recovery required), `reinstate` (the verification was `missing`; the unrecorded operation
  -- warrants reinstatement), `reconcile` (the verification was `inconsistent`; the divergent record warrants
  -- reconciliation). This is the auditable disposition future operational capabilities read to determine whether (and
  -- how) to recover an operation.
  recovery_classification text not null
                             check (recovery_classification in ('none', 'reinstate', 'reconcile')),
  -- WHETHER recovery is required — the coherent companion of the classification (true IFF the classification is a
  -- real recovery, i.e. not `none`). Bound to the classification by the keystone CHECK below so it can never drift.
  recovery_required    boolean not null,
  -- THE SOURCE INTEGRITY VERDICT — the R31 verdict this recovery classified, CHECK-pinned to the closed set. Carried
  -- for audit + coherence: the classification fold CHECK binds it to `recovery_classification`, and the integrity
  -- coherence CHECK (inherited from R31) binds it to the presence of the fulfilment.
  integrity      text        not null
                             check (integrity in ('consistent', 'missing', 'inconsistent')),
  -- THE GRANT THAT AUTHORISED THE UNDERLYING OPERATION — CHECK-pinned to the single value 'approved', inherited
  -- transitively from R31 → R30 (a verification, and therefore a recovery determined from one, can ONLY exist for an
  -- approved authorisation). A pending, rejected or foreclosed authorisation is structurally unrecoverable. The grant
  -- lives in the EXISTING Human Review ledger; this column records that a grant authorised the operation this row's
  -- verification verified.
  approval_state text        not null
                             check (approval_state = 'approved'),
  -- The EXPECTED booking payload — the trade, the place and the number to ring the DECISION said should have been
  -- performed (carried through from the R31 verification decision, which carried it from the R30 fulfilment
  -- decision). Each bounded in DDL to its R20 shape so the ledger can never store a malformed expectation. Nullable
  -- at the column level (future recovery types may not carry these); the write primitive REQUIRES all three for a
  -- `recover_booking_fulfilment` recovery, regardless of the disposition (the expectation always exists).
  job_type       text,
  postcode       text        check (postcode is null or postcode ~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'),
  phone_number   text        check (phone_number is null or phone_number ~ '^\+\d{10,15}$'),
  -- DETERMINED BY CONSTRUCTION: a recovery disposition is DETERMINED, and the row records exactly that. Pinned to the
  -- single value 'determined' so the ledger can never claim a partial, pending or executed recovery. (Whether
  -- recovery is required, and of what kind, is `recovery_required` + `recovery_classification`; a `reinstate` /
  -- `reconcile` disposition is still a fully `determined` recovery — determined, never EXECUTED.)
  status         text        not null default 'determined'
                             check (status = 'determined'),
  -- Recovery metadata — the resolving path, the strategy/goal it derived from, etc.
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now(),
  -- IDEMPOTENCY — one recovery per authorisation. Combined with the primitive's ON CONFLICT DO NOTHING, a verified
  -- fulfilment's recovery is determined AT MOST ONCE.
  constraint receptionist_conversation_recoveries_authorisation_unique unique (authorisation_id),
  -- THE FOLD, ENFORCED. (`recovery_type`, `recovery_outcome`) is the exact fold: recover_booking_fulfilment ⇒
  -- fulfilment_recovery_determined. No row can contradict its own type, so the determined result is deterministic.
  constraint receptionist_conversation_recoveries_outcome_fold check (
    recovery_type = 'recover_booking_fulfilment' and recovery_outcome = 'fulfilment_recovery_determined'
  ),
  -- THE KEYSTONE: RECOVERY-REQUIREMENT COHERENCE, ENFORCED. `recovery_required` is TRUE IFF the classification is a
  -- real recovery (not `none`). Recovery is required for `reinstate` and `reconcile`, and NOT required for `none`.
  -- The equivalence binds the flag to the disposition, so the ledger can never claim recovery is required over a
  -- `none` disposition, or not required over a `reinstate`/`reconcile` one. This is the R32 analogue of R31's
  -- integrity coherence — the novel coherence at the heart of this engine.
  constraint receptionist_conversation_recoveries_requirement_coherence check (
    recovery_required = (recovery_classification <> 'none')
  ),
  -- THE CLASSIFICATION FOLD, ENFORCED. The disposition is the exact, deterministic fold of the SOURCE integrity
  -- verdict: `consistent` ⇒ `none`, `missing` ⇒ `reinstate`, `inconsistent` ⇒ `reconcile`. No row can contradict the
  -- verification verdict it classified.
  constraint receptionist_conversation_recoveries_classification_fold check (
    (integrity = 'consistent' and recovery_classification = 'none')
    or (integrity = 'missing' and recovery_classification = 'reinstate')
    or (integrity = 'inconsistent' and recovery_classification = 'reconcile')
  ),
  -- INTEGRITY COHERENCE, ENFORCED (inherited from R31). A `missing` verdict means — and can ONLY mean — that no
  -- fulfilment was recorded (`fulfilment_id` NULL); any other verdict (`consistent` / `inconsistent`) means a
  -- fulfilment WAS recorded (`fulfilment_id` NOT NULL). The equivalence binds the verdict to the presence of the
  -- record it reconciled, so the ledger can never claim `missing` over a present record or `consistent`/`inconsistent`
  -- over an absent one.
  constraint receptionist_conversation_recoveries_integrity_coherence check (
    (fulfilment_id is null) = (integrity = 'missing')
  )
);

create index if not exists receptionist_conversation_recoveries_org_created_idx
  on public.receptionist_conversation_recoveries (org_id, created_at desc);
create index if not exists receptionist_conversation_recoveries_correlation_idx
  on public.receptionist_conversation_recoveries (correlation_id);
create index if not exists receptionist_conversation_recoveries_conversation_idx
  on public.receptionist_conversation_recoveries (conversation_id)
  where conversation_id is not null;
create index if not exists receptionist_conversation_recoveries_execution_idx
  on public.receptionist_conversation_recoveries (execution_id)
  where execution_id is not null;
-- The JOIN back to the R31 verification ledger — find the recovery determined from a verification.
create index if not exists receptionist_conversation_recoveries_verification_idx
  on public.receptionist_conversation_recoveries (verification_id);
-- The JOIN back to the R30 fulfilment ledger — find the recovery for a performed fulfilment.
create index if not exists receptionist_conversation_recoveries_fulfilment_idx
  on public.receptionist_conversation_recoveries (fulfilment_id)
  where fulfilment_id is not null;
-- The JOIN back to the EXISTING Human Review inbox — find the recovery for a held reply a human resolved.
create index if not exists receptionist_conversation_recoveries_review_audit_idx
  on public.receptionist_conversation_recoveries (review_audit_id);
-- Recovery analytics — how many recoveries of each type/outcome/disposition were determined (the disposition signal
-- an operator and future operational capabilities watch to find operations warranting reinstatement or
-- reconciliation).
create index if not exists receptionist_conversation_recoveries_type_idx
  on public.receptionist_conversation_recoveries (recovery_type, recovery_outcome, recovery_classification, recovery_required, status, created_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
-- paths in; every JWT client (anon / authenticated) is denied because an RLS-enabled table with no policies
-- defaults to deny.
alter table public.receptionist_conversation_recoveries enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a recovery is a fact about one determination, never updated or deleted. Reject
--    UPDATE/DELETE even under service_role. Mirrors the R31 verifications append-only guard.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_recoveries_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_recoveries is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_recoveries_no_update
  on public.receptionist_conversation_recoveries;
create trigger receptionist_conversation_recoveries_no_update
  before update on public.receptionist_conversation_recoveries
  for each row execute function public.receptionist_conversation_recoveries_block_mutation();

drop trigger if exists receptionist_conversation_recoveries_no_delete
  on public.receptionist_conversation_recoveries;
create trigger receptionist_conversation_recoveries_no_delete
  before delete on public.receptionist_conversation_recoveries
  for each row execute function public.receptionist_conversation_recoveries_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_recovery — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND ONLY
--    this to record a recovery disposition; the write is BEST-EFFORT there (a failure is logged and swallowed so a
--    durable, audited, human-approved confirmation reply is never undone by a recovery write), but the primitive
--    itself validates strictly: the recovery type, outcome, classification and integrity must be in their
--    vocabularies, the approval MUST be 'approved' (the storage-layer Human Review gate, inherited from R31 → R30),
--    `recovery_required` MUST be COHERENT with the disposition (true iff not `none` — the keystone), the
--    classification MUST be the deterministic fold of the integrity verdict, the integrity must be COHERENT with the
--    presence of the fulfilment (`missing` iff no `fulfilment_id`, inherited from R31), a `recover_booking_fulfilment`
--    MUST carry the expected job type plus a well-formed postcode and E.164 number and the full verification +
--    Human Review provenance, and the fold CHECK guarantees (type, outcome) match. IDEMPOTENT: ON CONFLICT
--    (authorisation_id) DO NOTHING returns the existing recovery's id, so a repeat determines nothing. Returns the
--    recovery id.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_recovery(
  p_org_id                 uuid,
  p_authorisation_id       uuid,
  p_verification_id        uuid,
  p_recovery_type          text,
  p_recovery_outcome       text,
  p_recovery_classification text,
  p_recovery_required      boolean,
  p_integrity              text,
  p_approval_state         text,
  p_correlation_id         uuid,
  p_review_audit_id        uuid,
  p_sent_audit_id          uuid,
  p_review_resolution_id   uuid,
  p_fulfilment_id          uuid    default null,
  p_conversation_id        uuid    default null,
  p_enquiry_id             uuid    default null,
  p_lead_id                uuid    default null,
  p_customer_ref           text    default null,
  p_action_id              uuid    default null,
  p_execution_id           uuid    default null,
  p_job_type               text    default null,
  p_postcode               text    default null,
  p_phone_number           text    default null,
  p_metadata               jsonb   default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_recovery_type not in ('recover_booking_fulfilment') then
    raise exception 'receptionist recovery type must be one of recover_booking_fulfilment, got %', p_recovery_type
      using errcode = 'check_violation';
  end if;

  if p_recovery_outcome not in ('fulfilment_recovery_determined') then
    raise exception 'receptionist recovery outcome must be one of fulfilment_recovery_determined, got %', p_recovery_outcome
      using errcode = 'check_violation';
  end if;

  if p_recovery_classification not in ('none', 'reinstate', 'reconcile') then
    raise exception 'receptionist recovery classification must be one of none, reinstate, reconcile, got %', p_recovery_classification
      using errcode = 'check_violation';
  end if;

  if p_integrity not in ('consistent', 'missing', 'inconsistent') then
    raise exception 'receptionist recovery integrity must be one of consistent, missing, inconsistent, got %', p_integrity
      using errcode = 'check_violation';
  end if;

  -- THE HUMAN REVIEW GATE, AT THE STORAGE LAYER (inherited from R31 → R30). A recovery is determined ONLY for an
  -- APPROVED authorisation. The grant is the human's, recorded in the EXISTING Human Review ledger; this primitive
  -- can only ever file a recovery whose approval is 'approved'. There is no path to determining recovery for
  -- un-approved work.
  if p_approval_state <> 'approved' then
    raise exception 'receptionist recovery requires an approved authorisation (Human Review may not be bypassed), got approval_state=%', p_approval_state
      using errcode = 'check_violation';
  end if;

  -- THE KEYSTONE: RECOVERY-REQUIREMENT COHERENCE. `recovery_required` is TRUE iff the classification is a real
  -- recovery (not `none`). Belt-and-braces with the table CHECK: a precise error for an incoherent call.
  if p_recovery_required <> (p_recovery_classification <> 'none') then
    raise exception 'receptionist recovery required=% is incoherent with classification=% (required iff classification <> none)',
      p_recovery_required, p_recovery_classification
      using errcode = 'check_violation';
  end if;

  -- THE CLASSIFICATION FOLD. The disposition is the exact, deterministic fold of the source integrity verdict:
  -- consistent ⇒ none, missing ⇒ reinstate, inconsistent ⇒ reconcile. Belt-and-braces with the table CHECK: a
  -- precise error for a classification that contradicts the verdict it claims to have classified.
  if not (
    (p_integrity = 'consistent' and p_recovery_classification = 'none')
    or (p_integrity = 'missing' and p_recovery_classification = 'reinstate')
    or (p_integrity = 'inconsistent' and p_recovery_classification = 'reconcile')
  ) then
    raise exception 'receptionist recovery classification=% is not the deterministic fold of integrity=%',
      p_recovery_classification, p_integrity
      using errcode = 'check_violation';
  end if;

  -- INTEGRITY COHERENCE (inherited from R31). A `missing` verdict means, and can ONLY mean, that no fulfilment was
  -- recorded (no `fulfilment_id`); any other verdict means a fulfilment WAS recorded (`fulfilment_id` present).
  -- Belt-and-braces with the table CHECK: a precise error for an incoherent call.
  if (p_fulfilment_id is null) <> (p_integrity = 'missing') then
    raise exception 'receptionist recovery integrity=% is incoherent with fulfilment_id=% (missing iff no fulfilment)',
      p_integrity, coalesce(p_fulfilment_id::text, 'null')
      using errcode = 'check_violation';
  end if;

  -- The verification anchor, the authorisation anchor and the full Human Review provenance are MANDATORY — a recovery
  -- is ALWAYS determined from a specific recorded verification, verifying a specific authorisation, downstream of a
  -- specific human `sent` resolution on a specific held reply.
  if p_verification_id is null or p_authorisation_id is null or p_review_audit_id is null or p_sent_audit_id is null or p_review_resolution_id is null then
    raise exception 'receptionist recovery requires verification_id, authorisation_id, review_audit_id, sent_audit_id and review_resolution_id (the verification + Human Review provenance)'
      using errcode = 'check_violation';
  end if;

  -- A recover_booking_fulfilment recovery MUST carry the three facts that identify the EXPECTED visit — the trade,
  -- the place and the number to ring — each well-formed. This is the decision's expectation, present for every
  -- disposition (including `none`), so the recovery record is self-describing about what SHOULD have been performed.
  if p_recovery_type = 'recover_booking_fulfilment'
     and (
       p_job_type is null or length(trim(p_job_type)) = 0
       or p_postcode is null or p_postcode !~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'
       or p_phone_number is null or p_phone_number !~ '^\+\d{10,15}$'
     ) then
    raise exception 'receptionist recover_booking_fulfilment requires an expected job type, a well-formed postcode and a well-formed E.164 phone number, got job_type=%, postcode=%, phone=%',
      coalesce(p_job_type, 'null'), coalesce(p_postcode, 'null'), coalesce(p_phone_number, 'null')
      using errcode = 'check_violation';
  end if;

  -- The (type, outcome) MUST be the fold. Belt-and-braces with the table CHECK: a precise error for a mismatch.
  if not (p_recovery_type = 'recover_booking_fulfilment' and p_recovery_outcome = 'fulfilment_recovery_determined') then
    raise exception 'receptionist recovery (type=%, outcome=%) does not match the deterministic fold',
      p_recovery_type, p_recovery_outcome
      using errcode = 'check_violation';
  end if;

  -- IDEMPOTENT INSERT — one recovery per authorisation. A repeat determines nothing; we return the existing id.
  insert into public.receptionist_conversation_recoveries (
    org_id, authorisation_id, verification_id, fulfilment_id, recovery_type, recovery_outcome, recovery_classification,
    recovery_required, integrity, approval_state,
    correlation_id, review_audit_id, sent_audit_id, review_resolution_id,
    conversation_id, enquiry_id, lead_id, customer_ref, action_id, execution_id,
    job_type, postcode, phone_number, metadata
  ) values (
    p_org_id, p_authorisation_id, p_verification_id, p_fulfilment_id, p_recovery_type, p_recovery_outcome, p_recovery_classification,
    p_recovery_required, p_integrity, p_approval_state,
    p_correlation_id, p_review_audit_id, p_sent_audit_id, p_review_resolution_id,
    p_conversation_id, p_enquiry_id, p_lead_id, p_customer_ref, p_action_id, p_execution_id,
    p_job_type, p_postcode, p_phone_number, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (authorisation_id) do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row when the authorisation's recovery was already determined — resolve the
  -- existing recovery's id so the caller always gets a stable id and the operation is a true no-op on repeat.
  if v_id is null then
    select id into v_id
      from public.receptionist_conversation_recoveries
      where authorisation_id = p_authorisation_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_recovery(
  uuid, uuid, uuid, text, text, text, boolean, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_recovery(
  uuid, uuid, uuid, text, text, text, boolean, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. find_receptionist_recovery_context — the single service-role-only SECURITY DEFINER RECOVERY-CONTEXT READER the
--    runtime uses to resolve, in ONE read, the RECORDED verification verdict behind a held reply a human just
--    approved: the DECIDED `verify_booking_fulfilment` verification (from the R31
--    `receptionist_conversation_verifications` ledger — R31's RECORDED verdict, so the runtime can reconstruct the
--    VerificationDecision verbatim and classify it through R32's own `resolveRecovery`). It reads ONLY that ledger
--    (no write), scoped by org and the held reply. The actual recovery classification stays in the pure core (R32's
--    `resolveRecovery`); this reader supplies the recorded verification, it never decides. This centring on R31's
--    verification ledger is the storage embodiment of "the Verification Engine remains authoritative — the Recovery
--    Engine consumes its RECORDED decision, it never re-derives it". EXECUTE revoked from PUBLIC / anon /
--    authenticated, granted only to service_role.
-- ---------------------------------------------------------------------------
create or replace function public.find_receptionist_recovery_context(
  p_org_id          uuid,
  p_review_audit_id uuid
)
returns table (
  -- The VERIFICATION — the R31 row, so the runtime can reconstruct the VerificationDecision and classify it. Every
  -- field is the recorded verification's own; the runtime reads them into the decision it classifies.
  verification_id       uuid,
  authorisation_id      uuid,
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
  verification_type     text,
  verification_outcome  text,
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
    v.id,
    v.authorisation_id,
    v.fulfilment_id,
    v.conversation_id,
    v.enquiry_id,
    v.lead_id,
    v.customer_ref,
    v.correlation_id,
    v.action_id,
    v.execution_id,
    v.review_audit_id,
    v.sent_audit_id,
    v.review_resolution_id,
    v.verification_type,
    v.verification_outcome,
    v.integrity,
    v.approval_state,
    v.job_type,
    v.postcode,
    v.phone_number
  from public.receptionist_conversation_verifications v
  where v.org_id = p_org_id
    and v.review_audit_id = p_review_audit_id
    and v.status = 'verified'
  order by v.created_at desc
  limit 1;
$$;

revoke all on function public.find_receptionist_recovery_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.find_receptionist_recovery_context(uuid, uuid)
  to service_role;
