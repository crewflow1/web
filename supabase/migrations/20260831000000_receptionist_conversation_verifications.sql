-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation VERIFICATION ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R31:
--  CONVERSATION VERIFICATION ENGINE).
--
-- R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
-- eligibility; R29 DETERMINES whether that decided execution requires APPROVAL; R30 PERFORMS the approved internal
-- business operation (booking fulfilment) and records it. R31 is the NEXT layer — and, in this stack, the FIRST
-- that VERIFIES: the Verification Engine takes a DECIDED fulfilment and the durable record R30 filed beside it and
-- RECONCILES the two, recording an auditable INTEGRITY verdict here. This migration is that verdict's durable,
-- append-only, IDEMPOTENT home. Fulfilment reconciliation is the FIRST verification type; the record captures WHAT
-- was verified (`verification_type` + `verification_outcome`), the INTEGRITY it found (`integrity`), the EXPECTED
-- booking payload (what the decision said should have been performed), the grant that authorised the underlying
-- operation (`approval_state = 'approved'`), and the anchors that thread it to the authorisation it verifies
-- (`authorisation_id`), to the fulfilment it reconciled (`fulfilment_id`, NULL when the operation is MISSING), to
-- the held reply a human approved (`review_audit_id`), to the reply that carried the human's approval
-- (`sent_audit_id`), and to the human's resolution itself in the EXISTING Human Review ledger
-- (`review_resolution_id`).
--
-- IT VERIFIES APPROVED WORK — AND IT CANNOT VERIFY UNAPPROVED WORK. The `approval_state` column is CHECK-pinned to
-- the single value 'approved' (inherited from R30, whose fulfilment can exist ONLY for an approved authorisation):
-- a verification row can exist ONLY for an operation a human GRANTED. The grant lives in the EXISTING Human Review
-- ledger (`receptionist_review_resolutions`, R14, a `sent` resolution) and is folded to 'approved' by R29's
-- `deriveAuthorisationState`; this ledger records the VERIFICATION of the operation that grant authorised, threaded
-- to the resolution row (`review_resolution_id`) and the held reply (`review_audit_id`) so the whole chain — held
-- reply → human grant → performed booking → verified integrity — joins. R31's law ("verify approved work; never
-- bypass Human Review") is made storage: a row here can NEVER represent an un-approved, un-reviewed, or autonomous
-- verification.
--
-- IT VERIFIES WORK — IT NEVER PERFORMS IT. Unlike R30 (whose row is a PERFORMED business operation), a verification
-- row is a RECONCILIATION FINDING: it materialises no booking, reaches no provider and executes no further
-- fulfilment. It records that a reconciliation was carried out (`verification_outcome = 'fulfilment_reconciled'`)
-- and the {@link integrity} it found. It is the independent check ON R30 — the layer that turns R30's best-effort
-- bookkeeping write into an observable, auditable INTEGRITY signal.
--
-- INTEGRITY IS A VERDICT, NOT AN ABSTENTION — A ROW IS FILED FOR ALL THREE. `integrity` is CHECK-pinned to the
-- closed set (consistent / missing / inconsistent). A verification row is produced for EVERY reconciliation of a
-- decided fulfilment: `consistent` (a record was found and matches the decision), `missing` (the operation was
-- decided but NO record exists — the observable detection of R30's best-effort gap) and `inconsistent` (a record
-- was found but diverges from the decision). Detecting `missing` and `inconsistent` is the WHOLE PURPOSE of the
-- engine, so they are first-class verdicts on a filed row — never silent.
--
-- INTEGRITY IS COHERENT WITH THE RECORD IT RECONCILES — enforced by the database. A CHECK pins
-- (`fulfilment_id is null`) = (`integrity = 'missing'`): a `missing` verdict means, and can ONLY mean, that no R30
-- fulfilment row was found (`fulfilment_id` NULL); a `consistent` or `inconsistent` verdict means, and can ONLY
-- mean, that a fulfilment WAS found (`fulfilment_id` NOT NULL). No writer — not even service_role with a direct
-- insert — can file a verification whose verdict contradicts the presence of the record it claims to have
-- reconciled.
--
-- THE FOLD IS ENFORCED BY THE DATABASE — the operation is DETERMINISTIC by construction. A CHECK pins
-- (`verification_type`, `verification_outcome`) to the exact fold (verify_booking_fulfilment ⇒
-- fulfilment_reconciled), and `approval_state` to 'approved' and `status` to 'verified'. No writer can file a
-- verification whose outcome contradicts its type, whose approval is anything but granted, or whose status claims
-- anything but verified.
--
-- IT IS IDEMPOTENT BY CONSTRUCTION — an approved fulfilment is verified AT MOST ONCE. `authorisation_id` is UNIQUE:
-- one verification per authorisation. The write primitive inserts ON CONFLICT (authorisation_id) DO NOTHING and
-- returns the EXISTING row's id on a repeat, so re-driving the same approved authorisation (a retried review-send,
-- a double-fire) never materialises a second verification. This is the storage-layer guarantee behind R31's
-- deterministic reconciliation — distinct from RETRY (an explicit R31 non-goal): the ledger does not re-attempt
-- anything, it makes a repeat a no-op.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. A verification is a fact about one approved fulfilment reconciled
-- once, exactly as a fulfilment (R30), an authorisation (R29), an execution (R28), an action (R27) and an outcome
-- (R26) are. It gets the SAME first-class, append-only home — not a mutable status column — so a verification
-- verdict can never be silently rewritten or erased. The confirmation the customer received is STILL produced and
-- audited by the UNCHANGED reply pipeline, the human's GRANT is STILL recorded by the UNCHANGED Human Review
-- architecture (R14), and the operation is STILL performed and recorded by the UNCHANGED R30 fulfilment ledger;
-- this ledger records the VERIFICATION verdict ALONGSIDE them, threaded to the SAME `correlation_id`, so an auditor
-- can join the verification to the fulfilment it reconciled, the authorisation it verifies, the reply that
-- announced it, and the human who approved it.
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the
-- `receptionist_conversation_fulfilments` ledger:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
--     writers/readers; every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role.
--   • A single validated SECURITY DEFINER write entry point, plus a single service-role-only SECURITY DEFINER
--     RECONCILIATION READER that resolves the pending booking authorisation behind a held reply AND left-joins the
--     fulfilment R30 filed for it (the reconciliation JOIN the runtime verifies over) — both with EXECUTE revoked
--     from PUBLIC / anon / authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + two functions + triggers. No tenant table is touched, no existing
-- column is altered, and no producer is wired by this migration (the server runtime wires the store in
-- TypeScript). References to organisation / conversation / enquiry / customer / action / execution / authorisation
-- / fulfilment / held reply / sent reply / resolution are carried as DENORMALISED, un-FK'd facts (the append-only
-- rule: a verification must outlive the rows it describes, so no `on delete cascade` can ever erase verification
-- history).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_verifications — one append-only record per RECONCILED fulfilment. RLS:hq. Captures
--    WHAT was verified (`verification_type` + `verification_outcome`), the INTEGRITY it found (`integrity`), the
--    EXPECTED booking payload, the grant that authorised the underlying operation (`approval_state`), its verified
--    `status`, and the anchors that thread it to the organisation, conversation, enquiry, customer, prepared
--    action, decided execution and — the load-bearing ones — the authorisation it verifies (`authorisation_id`,
--    UNIQUE), the fulfilment it reconciled (`fulfilment_id`, NULL when MISSING), the held reply a human approved
--    (`review_audit_id`), the reply that carried the approval (`sent_audit_id`) and the human's resolution
--    (`review_resolution_id`).
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_verifications (
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
  -- THE AUTHORISATION THIS VERIFICATION VERIFIES — the R29 `receptionist_conversation_authorisations` row, a soft
  -- (un-FK'd) reference. UNIQUE: one verification per authorisation (the idempotency anchor). NOT NULL: a
  -- verification always verifies a specific approved authorisation.
  authorisation_id uuid      not null,
  -- THE FULFILMENT THIS VERIFICATION RECONCILED — the R30 `receptionist_conversation_fulfilments` row, a soft
  -- (un-FK'd) reference. NULLABLE: it is NULL exactly when the operation is MISSING (decided but never recorded),
  -- and NOT NULL for a `consistent` or `inconsistent` verdict — a coherence CHECK below binds the two.
  fulfilment_id  uuid,
  -- THE HUMAN REVIEW CHAIN — the held reply a human approved (`review_audit_id`, the `ai_reply_audits` row the
  -- R14 inbox surfaced), the reply that CARRIED the human's approval to the customer (`sent_audit_id`, the new
  -- `ai_reply_audits` row the send produced) and the human's resolution itself (`review_resolution_id`, the
  -- `receptionist_review_resolutions` row — the grant). All NOT NULL: a verification is carried out ONLY downstream
  -- of a human's `sent` resolution, so the full provenance always exists. This is how "never bypass Human Review"
  -- is threaded structurally.
  review_audit_id     uuid   not null,
  sent_audit_id       uuid   not null,
  review_resolution_id uuid  not null,
  -- WHAT was verified.
  verification_type    text  not null
                             check (verification_type in ('verify_booking_fulfilment')),
  -- The PERFORMED result of running the verification — CHECK-pinned to the closed set; folded from the verification
  -- type below. This is the operation R31 performs (a reconciliation was carried out); the VERDICT of that
  -- reconciliation is `integrity`, not this.
  verification_outcome text  not null
                             check (verification_outcome in ('fulfilment_reconciled')),
  -- THE INTEGRITY VERDICT — CHECK-pinned to the closed set. A row is filed for ALL three: `consistent` (record
  -- found and matches the decision), `missing` (decided but no record — R30's best-effort gap made observable),
  -- `inconsistent` (record found but diverges). This is the auditable finding the whole engine exists to produce.
  integrity      text        not null
                             check (integrity in ('consistent', 'missing', 'inconsistent')),
  -- THE GRANT THAT AUTHORISED THE UNDERLYING OPERATION — CHECK-pinned to the single value 'approved', inherited
  -- from R30 (a fulfilment, and therefore a verification of one, can ONLY exist for an approved authorisation). A
  -- pending, rejected or foreclosed authorisation is structurally unverifiable. The grant lives in the EXISTING
  -- Human Review ledger; this column records that a grant authorised the operation this row verifies.
  approval_state text        not null
                             check (approval_state = 'approved'),
  -- The EXPECTED booking payload — the trade, the place and the number to ring the DECISION said should have been
  -- performed (carried through from the R30 fulfilment decision, NOT the recorded row). Each bounded in DDL to its
  -- R20 shape so the ledger can never store a malformed expectation. Nullable at the column level (future
  -- verification types may not carry these); the write primitive REQUIRES all three for a `verify_booking_fulfilment`
  -- verification, regardless of the integrity verdict (the expectation always exists).
  job_type       text,
  postcode       text        check (postcode is null or postcode ~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'),
  phone_number   text        check (phone_number is null or phone_number ~ '^\+\d{10,15}$'),
  -- VERIFIED BY CONSTRUCTION: a reconciliation is CARRIED OUT, and the row records exactly that. Pinned to the
  -- single value 'verified' so the ledger can never claim a partial, pending or reversed verification. (The
  -- integrity of what was verified is `integrity`, a separate column — a `missing`/`inconsistent` finding is still
  -- a fully `verified` reconciliation.)
  status         text        not null default 'verified'
                             check (status = 'verified'),
  -- Verification metadata — the resolving path, the strategy/goal it derived from, etc.
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now(),
  -- IDEMPOTENCY — one verification per authorisation. Combined with the primitive's ON CONFLICT DO NOTHING, an
  -- approved fulfilment is verified AT MOST ONCE.
  constraint receptionist_conversation_verifications_authorisation_unique unique (authorisation_id),
  -- THE FOLD, ENFORCED. (`verification_type`, `verification_outcome`) is the exact fold: verify_booking_fulfilment
  -- ⇒ fulfilment_reconciled. No row can contradict its own type, so the performed result is deterministic.
  constraint receptionist_conversation_verifications_outcome_fold check (
    verification_type = 'verify_booking_fulfilment' and verification_outcome = 'fulfilment_reconciled'
  ),
  -- INTEGRITY COHERENCE, ENFORCED. A `missing` verdict means — and can ONLY mean — that no fulfilment was recorded
  -- (`fulfilment_id` NULL); any other verdict (`consistent` / `inconsistent`) means a fulfilment WAS recorded
  -- (`fulfilment_id` NOT NULL). The equivalence binds the verdict to the presence of the record it reconciles, so
  -- the ledger can never claim `missing` over a present record or `consistent`/`inconsistent` over an absent one.
  constraint receptionist_conversation_verifications_integrity_coherence check (
    (fulfilment_id is null) = (integrity = 'missing')
  )
);

create index if not exists receptionist_conversation_verifications_org_created_idx
  on public.receptionist_conversation_verifications (org_id, created_at desc);
create index if not exists receptionist_conversation_verifications_correlation_idx
  on public.receptionist_conversation_verifications (correlation_id);
create index if not exists receptionist_conversation_verifications_conversation_idx
  on public.receptionist_conversation_verifications (conversation_id)
  where conversation_id is not null;
create index if not exists receptionist_conversation_verifications_execution_idx
  on public.receptionist_conversation_verifications (execution_id)
  where execution_id is not null;
-- The JOIN back to the R30 fulfilment ledger — find the verification for a performed fulfilment.
create index if not exists receptionist_conversation_verifications_fulfilment_idx
  on public.receptionist_conversation_verifications (fulfilment_id)
  where fulfilment_id is not null;
-- The JOIN back to the EXISTING Human Review inbox — find the verification for a held reply a human resolved.
create index if not exists receptionist_conversation_verifications_review_audit_idx
  on public.receptionist_conversation_verifications (review_audit_id);
-- Verification analytics — how many reconciliations of each type/outcome/integrity were carried out (the signal an
-- operator watches to detect `missing` or `inconsistent` operations).
create index if not exists receptionist_conversation_verifications_type_idx
  on public.receptionist_conversation_verifications (verification_type, verification_outcome, integrity, status, created_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
-- paths in; every JWT client (anon / authenticated) is denied because an RLS-enabled table with no policies
-- defaults to deny.
alter table public.receptionist_conversation_verifications enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a verification is a fact about one reconciliation, never updated or deleted. Reject
--    UPDATE/DELETE even under service_role. Mirrors the R30 fulfilments append-only guard.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_verifications_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_verifications is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_verifications_no_update
  on public.receptionist_conversation_verifications;
create trigger receptionist_conversation_verifications_no_update
  before update on public.receptionist_conversation_verifications
  for each row execute function public.receptionist_conversation_verifications_block_mutation();

drop trigger if exists receptionist_conversation_verifications_no_delete
  on public.receptionist_conversation_verifications;
create trigger receptionist_conversation_verifications_no_delete
  before delete on public.receptionist_conversation_verifications
  for each row execute function public.receptionist_conversation_verifications_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_verification — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND ONLY
--    this to record a verification verdict; the write is BEST-EFFORT there (a failure is logged and swallowed so a
--    durable, audited, human-approved confirmation reply is never undone by a verification write), but the
--    primitive itself validates strictly: the verification type, outcome and integrity must be in their
--    vocabularies, the approval MUST be 'approved' (the storage-layer Human Review gate, inherited from R30), the
--    integrity must be COHERENT with the presence of the fulfilment (`missing` iff no `fulfilment_id`), a
--    `verify_booking_fulfilment` MUST carry the expected job type plus a well-formed postcode and E.164 number and
--    the full Human Review provenance, and the fold CHECK guarantees (type, outcome) match. IDEMPOTENT: ON CONFLICT
--    (authorisation_id) DO NOTHING returns the existing verification's id, so a repeat verifies nothing. Returns
--    the verification id.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_verification(
  p_org_id                uuid,
  p_authorisation_id      uuid,
  p_verification_type     text,
  p_verification_outcome  text,
  p_integrity             text,
  p_approval_state        text,
  p_correlation_id        uuid,
  p_review_audit_id       uuid,
  p_sent_audit_id         uuid,
  p_review_resolution_id  uuid,
  p_fulfilment_id         uuid    default null,
  p_conversation_id       uuid    default null,
  p_enquiry_id            uuid    default null,
  p_lead_id               uuid    default null,
  p_customer_ref          text    default null,
  p_action_id             uuid    default null,
  p_execution_id          uuid    default null,
  p_job_type              text    default null,
  p_postcode              text    default null,
  p_phone_number          text    default null,
  p_metadata              jsonb   default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_verification_type not in ('verify_booking_fulfilment') then
    raise exception 'receptionist verification type must be one of verify_booking_fulfilment, got %', p_verification_type
      using errcode = 'check_violation';
  end if;

  if p_verification_outcome not in ('fulfilment_reconciled') then
    raise exception 'receptionist verification outcome must be one of fulfilment_reconciled, got %', p_verification_outcome
      using errcode = 'check_violation';
  end if;

  if p_integrity not in ('consistent', 'missing', 'inconsistent') then
    raise exception 'receptionist verification integrity must be one of consistent, missing, inconsistent, got %', p_integrity
      using errcode = 'check_violation';
  end if;

  -- THE HUMAN REVIEW GATE, AT THE STORAGE LAYER (inherited from R30). A verification is carried out ONLY for an
  -- APPROVED authorisation. The grant is the human's, recorded in the EXISTING Human Review ledger; this primitive
  -- can only ever file a verification whose approval is 'approved'. There is no path to verifying un-approved work.
  if p_approval_state <> 'approved' then
    raise exception 'receptionist verification requires an approved authorisation (Human Review may not be bypassed), got approval_state=%', p_approval_state
      using errcode = 'check_violation';
  end if;

  -- INTEGRITY COHERENCE. A `missing` verdict means, and can ONLY mean, that no fulfilment was recorded (no
  -- `fulfilment_id`); any other verdict means a fulfilment WAS recorded (`fulfilment_id` present). Belt-and-braces
  -- with the table CHECK: a precise error for an incoherent call.
  if (p_fulfilment_id is null) <> (p_integrity = 'missing') then
    raise exception 'receptionist verification integrity=% is incoherent with fulfilment_id=% (missing iff no fulfilment)',
      p_integrity, coalesce(p_fulfilment_id::text, 'null')
      using errcode = 'check_violation';
  end if;

  -- The authorisation anchor and the full Human Review provenance are MANDATORY — a verification always verifies a
  -- specific authorisation, downstream of a specific human `sent` resolution on a specific held reply.
  if p_authorisation_id is null or p_review_audit_id is null or p_sent_audit_id is null or p_review_resolution_id is null then
    raise exception 'receptionist verification requires authorisation_id, review_audit_id, sent_audit_id and review_resolution_id (the Human Review provenance)'
      using errcode = 'check_violation';
  end if;

  -- A verify_booking_fulfilment verification MUST carry the three facts that identify the EXPECTED visit — the
  -- trade, the place and the number to ring — each well-formed. This is the decision's expectation, present for
  -- every verdict (including `missing`), so the verification record is self-describing about what SHOULD have been
  -- performed.
  if p_verification_type = 'verify_booking_fulfilment'
     and (
       p_job_type is null or length(trim(p_job_type)) = 0
       or p_postcode is null or p_postcode !~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'
       or p_phone_number is null or p_phone_number !~ '^\+\d{10,15}$'
     ) then
    raise exception 'receptionist verify_booking_fulfilment requires an expected job type, a well-formed postcode and a well-formed E.164 phone number, got job_type=%, postcode=%, phone=%',
      coalesce(p_job_type, 'null'), coalesce(p_postcode, 'null'), coalesce(p_phone_number, 'null')
      using errcode = 'check_violation';
  end if;

  -- The (type, outcome) MUST be the fold. Belt-and-braces with the table CHECK: a precise error for a mismatch.
  if not (p_verification_type = 'verify_booking_fulfilment' and p_verification_outcome = 'fulfilment_reconciled') then
    raise exception 'receptionist verification (type=%, outcome=%) does not match the deterministic fold',
      p_verification_type, p_verification_outcome
      using errcode = 'check_violation';
  end if;

  -- IDEMPOTENT INSERT — one verification per authorisation. A repeat verifies nothing; we return the existing id.
  insert into public.receptionist_conversation_verifications (
    org_id, authorisation_id, fulfilment_id, verification_type, verification_outcome, integrity, approval_state,
    correlation_id, review_audit_id, sent_audit_id, review_resolution_id,
    conversation_id, enquiry_id, lead_id, customer_ref, action_id, execution_id,
    job_type, postcode, phone_number, metadata
  ) values (
    p_org_id, p_authorisation_id, p_fulfilment_id, p_verification_type, p_verification_outcome, p_integrity, p_approval_state,
    p_correlation_id, p_review_audit_id, p_sent_audit_id, p_review_resolution_id,
    p_conversation_id, p_enquiry_id, p_lead_id, p_customer_ref, p_action_id, p_execution_id,
    p_job_type, p_postcode, p_phone_number, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (authorisation_id) do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row when the authorisation was already verified — resolve the existing
  -- verification's id so the caller always gets a stable id and the operation is a true no-op on repeat.
  if v_id is null then
    select id into v_id
      from public.receptionist_conversation_verifications
      where authorisation_id = p_authorisation_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_verification(
  uuid, uuid, text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_verification(
  uuid, uuid, text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. find_receptionist_fulfilment_reconciliation — the single service-role-only SECURITY DEFINER RECONCILIATION
--    READER the runtime uses to resolve, in ONE read, both sides of the reconciliation behind a held reply a human
--    just approved: the PENDING `approve_booking` authorisation (from the R29
--    `receptionist_conversation_authorisations` ledger, so the runtime can reconstruct it and re-derive the
--    EXPECTED fulfilment through R30's own `resolveFulfilment`) LEFT JOINed to the fulfilment R30 filed for it
--    (from the R30 `receptionist_conversation_fulfilments` ledger — the RECORDED operation, or NULLs when the
--    operation is MISSING). It reads ONLY those two ledgers (no write), scoped by org and the held reply. The
--    actual EXPECTED shape and the integrity VERDICT stay in the pure cores (R30's `resolveFulfilment`, R31's
--    `resolveVerification`); this reader supplies both rows, it never decides. EXECUTE revoked from PUBLIC / anon /
--    authenticated, granted only to service_role.
-- ---------------------------------------------------------------------------
create or replace function public.find_receptionist_fulfilment_reconciliation(
  p_org_id          uuid,
  p_review_audit_id uuid
)
returns table (
  -- The AUTHORISATION side — the R29 row, so the runtime can reconstruct it and re-derive the EXPECTED fulfilment.
  authorisation_id            uuid,
  conversation_id             uuid,
  enquiry_id                  uuid,
  lead_id                     uuid,
  customer_ref                text,
  correlation_id              uuid,
  action_id                   uuid,
  execution_id                uuid,
  requirement                 text,
  authorisation_state         text,
  execution_eligibility       text,
  job_type                    text,
  postcode                    text,
  phone_number                text,
  -- The RECORDED side — the R30 fulfilment LEFT JOINed on the authorisation. Every field is NULL when the operation
  -- is MISSING (decided but never recorded); the runtime reads them into the recorded snapshot it reconciles.
  fulfilment_id               uuid,
  recorded_fulfilment_type    text,
  recorded_fulfilment_outcome text,
  recorded_approval_state     text,
  recorded_status             text,
  recorded_job_type           text,
  recorded_postcode           text,
  recorded_phone_number       text
)
language sql
security definer
set search_path = ''
as $$
  select
    a.id,
    a.conversation_id,
    a.enquiry_id,
    a.lead_id,
    a.customer_ref,
    a.correlation_id,
    a.action_id,
    a.execution_id,
    a.requirement,
    a.authorisation_state,
    a.execution_eligibility,
    a.job_type,
    a.postcode,
    a.phone_number,
    f.id,
    f.fulfilment_type,
    f.fulfilment_outcome,
    f.approval_state,
    f.status,
    f.job_type,
    f.postcode,
    f.phone_number
  from public.receptionist_conversation_authorisations a
  left join public.receptionist_conversation_fulfilments f
    on f.authorisation_id = a.id
  where a.org_id = p_org_id
    and a.review_audit_id = p_review_audit_id
    and a.authorisation_type = 'approve_booking'
    and a.authorisation_state = 'pending'
    and a.status = 'assessed'
  order by a.created_at desc
  limit 1;
$$;

revoke all on function public.find_receptionist_fulfilment_reconciliation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.find_receptionist_fulfilment_reconciliation(uuid, uuid)
  to service_role;
