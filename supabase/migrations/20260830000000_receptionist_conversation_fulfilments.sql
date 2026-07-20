-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation FULFILMENT ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R30:
--  CONVERSATION FULFILMENT ENGINE).
--
-- R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
-- eligibility; R29 DETERMINES whether that decided execution requires APPROVAL and records the turn-time
-- authorisation state. R30 is the NEXT layer — and the FIRST that PERFORMS: the Fulfilment Engine takes an
-- APPROVED authorisation and CARRIES OUT the approved internal business operation, recording it here. This
-- migration is that performed operation's durable, append-only, IDEMPOTENT home. Booking fulfilment is the FIRST
-- fulfilment type; the record captures WHAT was performed (`fulfilment_type` + `fulfilment_outcome`), the booking
-- payload it materialised, the grant that authorised it (`approval_state = 'approved'`), and the anchors that
-- thread it to the authorisation it fulfils (`authorisation_id`), to the held reply a human approved
-- (`review_audit_id`), to the reply that carried the human's approval (`sent_audit_id`), and to the human's
-- resolution itself in the EXISTING Human Review ledger (`review_resolution_id`).
--
-- IT PERFORMS APPROVED WORK — AND IT CANNOT PERFORM UNAPPROVED WORK. The `approval_state` column is CHECK-pinned
-- to the single value 'approved' (the INVERSE of R29's ledger, whose `authorisation_state` structurally OMITS any
-- grant): a fulfilment row can exist ONLY for an authorisation a human GRANTED. The grant lives in the EXISTING
-- Human Review ledger (`receptionist_review_resolutions`, R14, a `sent` resolution) and is folded to 'approved' by
-- R29's `deriveAuthorisationState`; this ledger records the PERFORMED operation that grant authorised, threaded to
-- the resolution row (`review_resolution_id`) and the held reply (`review_audit_id`) so the whole chain — held
-- reply → human grant → performed booking — joins. R30's law ("perform approved work; never bypass Human Review")
-- is made storage: a row here can NEVER represent an un-approved, un-reviewed, or autonomous operation.
--
-- IT IS IDEMPOTENT BY CONSTRUCTION — an approved booking is performed AT MOST ONCE. `authorisation_id` is UNIQUE:
-- one fulfilment per authorisation. The write primitive inserts ON CONFLICT (authorisation_id) DO NOTHING and
-- returns the EXISTING row's id on a repeat, so re-driving the same approved authorisation (a retried review-send,
-- a double-fire) never materialises a second booking. This is the storage-layer guarantee behind the R30
-- required behaviour "preserve idempotency" — distinct from RETRY (an explicit R30 non-goal): the ledger does not
-- re-attempt anything, it makes a repeat a no-op.
--
-- THE FOLD IS ENFORCED BY THE DATABASE — the operation is DETERMINISTIC by construction. A CHECK pins
-- (`fulfilment_type`, `fulfilment_outcome`) to the exact fold (fulfil_booking ⇒ booking_recorded), and
-- `approval_state` to 'approved' and `status` to 'fulfilled'. No writer — not even service_role with a direct
-- insert — can file a fulfilment whose outcome contradicts its type, whose approval is anything but granted, or
-- whose status claims anything but performed.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. A fulfilment is a fact about one approved authorisation carried out
-- once, exactly as an authorisation (R29), an execution (R28), an action (R27) and an outcome (R26) are. It gets
-- the SAME first-class, append-only home — not a mutable status column — so a performed operation can never be
-- silently rewritten or erased. The confirmation the customer received is STILL produced and audited by the
-- UNCHANGED reply pipeline, and the human's GRANT is STILL recorded by the UNCHANGED Human Review architecture
-- (R14); this ledger records the PERFORMED internal operation ALONGSIDE them, threaded to the SAME
-- `correlation_id`, so an auditor can join the fulfilment to the authorisation it fulfils, the reply that
-- announced it, and the human who approved it.
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the
-- `receptionist_conversation_authorisations` ledger:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
--     writers/readers; every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role.
--   • A single validated SECURITY DEFINER write entry point, plus a single service-role-only SECURITY DEFINER
--     READER that resolves the pending booking authorisation behind a held reply (the join the runtime fulfils
--     over) — both with EXECUTE revoked from PUBLIC / anon / authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + two functions + triggers. No tenant table is touched, no existing
-- column is altered, and no producer is wired by this migration (the server runtime wires the store in
-- TypeScript). References to organisation / conversation / enquiry / customer / action / execution / authorisation
-- / held reply / sent reply / resolution are carried as DENORMALISED, un-FK'd facts (the append-only rule: a
-- fulfilment must outlive the rows it describes, so no `on delete cascade` can ever erase fulfilment history).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_fulfilments — one append-only record per PERFORMED fulfilment. RLS:hq. Captures
--    WHAT was performed (`fulfilment_type` + `fulfilment_outcome`), the booking payload it materialised, the
--    grant that authorised it (`approval_state`), its performed `status`, and the anchors that thread it to the
--    organisation, conversation, enquiry, customer, prepared action, decided execution and — the load-bearing
--    ones — the authorisation it fulfils (`authorisation_id`, UNIQUE), the held reply a human approved
--    (`review_audit_id`), the reply that carried the approval (`sent_audit_id`) and the human's resolution
--    (`review_resolution_id`).
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_fulfilments (
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
  -- THE AUTHORISATION THIS FULFILMENT CARRIES OUT — the R29 `receptionist_conversation_authorisations` row, a
  -- soft (un-FK'd) reference. UNIQUE: one fulfilment per authorisation (the idempotency anchor). NOT NULL: a
  -- fulfilment always fulfils a specific approved authorisation.
  authorisation_id uuid      not null,
  -- THE HUMAN REVIEW CHAIN — the held reply a human approved (`review_audit_id`, the `ai_reply_audits` row the
  -- R14 inbox surfaced), the reply that CARRIED the human's approval to the customer (`sent_audit_id`, the new
  -- `ai_reply_audits` row the send produced) and the human's resolution itself (`review_resolution_id`, the
  -- `receptionist_review_resolutions` row — the grant). All NOT NULL: a fulfilment is carried out ONLY downstream
  -- of a human's `sent` resolution, so the full provenance always exists. This is how "never bypass Human Review"
  -- is threaded structurally.
  review_audit_id     uuid   not null,
  sent_audit_id       uuid   not null,
  review_resolution_id uuid  not null,
  -- WHAT was performed.
  fulfilment_type    text    not null
                             check (fulfilment_type in ('fulfil_booking')),
  -- The PERFORMED result — CHECK-pinned to the closed set; folded from the fulfilment type below.
  fulfilment_outcome text    not null
                             check (fulfilment_outcome in ('booking_recorded')),
  -- THE GRANT THAT AUTHORISED IT — CHECK-pinned to the single value 'approved'. This is the R30 KEYSTONE (the
  -- inverse of R29, whose turn-time state can never BE a grant): a fulfilment can ONLY exist for an approved
  -- authorisation. A pending, rejected or foreclosed authorisation is structurally unfulfillable. The grant lives
  -- in the EXISTING Human Review ledger; this column records that a grant authorised the performed operation.
  approval_state text        not null
                             check (approval_state = 'approved'),
  -- The BOOKING payload the fulfilment materialised — the trade, the place and the number to ring. Each bounded
  -- in DDL to its R20 shape so the ledger can never store a malformed booking phone or postcode. Nullable at the
  -- column level (future fulfilment types may not carry these); the write primitive REQUIRES all three for a
  -- `fulfil_booking` operation.
  job_type       text,
  postcode       text        check (postcode is null or postcode ~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'),
  phone_number   text        check (phone_number is null or phone_number ~ '^\+\d{10,15}$'),
  -- PERFORMED BY CONSTRUCTION: an operation is CARRIED OUT, and the row records exactly that. Pinned to the single
  -- value 'fulfilled' so the ledger can never claim a partial, pending or reversed operation.
  status         text        not null default 'fulfilled'
                             check (status = 'fulfilled'),
  -- Fulfilment metadata — the resolving path, the strategy/goal it derived from, etc.
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now(),
  -- IDEMPOTENCY — one fulfilment per authorisation. Combined with the primitive's ON CONFLICT DO NOTHING, an
  -- approved booking is performed AT MOST ONCE.
  constraint receptionist_conversation_fulfilments_authorisation_unique unique (authorisation_id),
  -- THE FOLD, ENFORCED. (`fulfilment_type`, `fulfilment_outcome`) is the exact fold: fulfil_booking ⇒
  -- booking_recorded. No row can contradict its own type, so the performed result is deterministic.
  constraint receptionist_conversation_fulfilments_outcome_fold check (
    fulfilment_type = 'fulfil_booking' and fulfilment_outcome = 'booking_recorded'
  )
);

create index if not exists receptionist_conversation_fulfilments_org_created_idx
  on public.receptionist_conversation_fulfilments (org_id, created_at desc);
create index if not exists receptionist_conversation_fulfilments_correlation_idx
  on public.receptionist_conversation_fulfilments (correlation_id);
create index if not exists receptionist_conversation_fulfilments_conversation_idx
  on public.receptionist_conversation_fulfilments (conversation_id)
  where conversation_id is not null;
create index if not exists receptionist_conversation_fulfilments_execution_idx
  on public.receptionist_conversation_fulfilments (execution_id)
  where execution_id is not null;
-- The JOIN back to the EXISTING Human Review inbox — find the fulfilment for a held reply a human resolved.
create index if not exists receptionist_conversation_fulfilments_review_audit_idx
  on public.receptionist_conversation_fulfilments (review_audit_id);
-- Fulfilment analytics — how many operations of each type/outcome were performed.
create index if not exists receptionist_conversation_fulfilments_type_idx
  on public.receptionist_conversation_fulfilments (fulfilment_type, fulfilment_outcome, status, created_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
-- paths in; every JWT client (anon / authenticated) is denied because an RLS-enabled table with no policies
-- defaults to deny.
alter table public.receptionist_conversation_fulfilments enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a fulfilment is a fact about one performed operation, never updated or deleted. Reject
--    UPDATE/DELETE even under service_role. Mirrors the R29 authorisations append-only guard.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_fulfilments_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_fulfilments is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_fulfilments_no_update
  on public.receptionist_conversation_fulfilments;
create trigger receptionist_conversation_fulfilments_no_update
  before update on public.receptionist_conversation_fulfilments
  for each row execute function public.receptionist_conversation_fulfilments_block_mutation();

drop trigger if exists receptionist_conversation_fulfilments_no_delete
  on public.receptionist_conversation_fulfilments;
create trigger receptionist_conversation_fulfilments_no_delete
  before delete on public.receptionist_conversation_fulfilments
  for each row execute function public.receptionist_conversation_fulfilments_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_fulfilment — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND ONLY
--    this to record a performed fulfilment; the write is BEST-EFFORT there (a failure is logged and swallowed so
--    a durable, audited, human-approved confirmation reply is never undone by a bookkeeping write), but the
--    primitive itself validates strictly: the fulfilment type and outcome must be in their vocabularies, the
--    approval MUST be 'approved' (the storage-layer Human Review gate), a `fulfil_booking` MUST carry a job type
--    plus a well-formed postcode and E.164 number and the full Human Review provenance, and the fold CHECK
--    guarantees (type, outcome) match. IDEMPOTENT: ON CONFLICT (authorisation_id) DO NOTHING returns the existing
--    fulfilment's id, so a repeat performs nothing. Returns the fulfilment id.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_fulfilment(
  p_org_id                uuid,
  p_authorisation_id      uuid,
  p_fulfilment_type       text,
  p_fulfilment_outcome    text,
  p_approval_state        text,
  p_correlation_id        uuid,
  p_review_audit_id       uuid,
  p_sent_audit_id         uuid,
  p_review_resolution_id  uuid,
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
  if p_fulfilment_type not in ('fulfil_booking') then
    raise exception 'receptionist fulfilment type must be one of fulfil_booking, got %', p_fulfilment_type
      using errcode = 'check_violation';
  end if;

  if p_fulfilment_outcome not in ('booking_recorded') then
    raise exception 'receptionist fulfilment outcome must be one of booking_recorded, got %', p_fulfilment_outcome
      using errcode = 'check_violation';
  end if;

  -- THE HUMAN REVIEW GATE, AT THE STORAGE LAYER. A fulfilment is performed ONLY for an APPROVED authorisation.
  -- The grant is the human's, recorded in the EXISTING Human Review ledger; this primitive can only ever file a
  -- fulfilment whose approval is 'approved'. There is no path to performing un-approved work.
  if p_approval_state <> 'approved' then
    raise exception 'receptionist fulfilment requires an approved authorisation (Human Review may not be bypassed), got approval_state=%', p_approval_state
      using errcode = 'check_violation';
  end if;

  -- The authorisation anchor and the full Human Review provenance are MANDATORY — a fulfilment always fulfils a
  -- specific authorisation, downstream of a specific human `sent` resolution on a specific held reply.
  if p_authorisation_id is null or p_review_audit_id is null or p_sent_audit_id is null or p_review_resolution_id is null then
    raise exception 'receptionist fulfilment requires authorisation_id, review_audit_id, sent_audit_id and review_resolution_id (the Human Review provenance)'
      using errcode = 'check_violation';
  end if;

  -- A fulfil_booking operation MUST carry the three facts that identify the visit — the trade, the place and the
  -- number to ring — each well-formed. The ledger never materialises an unusable booking.
  if p_fulfilment_type = 'fulfil_booking'
     and (
       p_job_type is null or length(trim(p_job_type)) = 0
       or p_postcode is null or p_postcode !~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'
       or p_phone_number is null or p_phone_number !~ '^\+\d{10,15}$'
     ) then
    raise exception 'receptionist fulfil_booking requires a job type, a well-formed postcode and a well-formed E.164 phone number, got job_type=%, postcode=%, phone=%',
      coalesce(p_job_type, 'null'), coalesce(p_postcode, 'null'), coalesce(p_phone_number, 'null')
      using errcode = 'check_violation';
  end if;

  -- The (type, outcome) MUST be the fold. Belt-and-braces with the table CHECK: a precise error for a mismatch.
  if not (p_fulfilment_type = 'fulfil_booking' and p_fulfilment_outcome = 'booking_recorded') then
    raise exception 'receptionist fulfilment (type=%, outcome=%) does not match the deterministic fold',
      p_fulfilment_type, p_fulfilment_outcome
      using errcode = 'check_violation';
  end if;

  -- IDEMPOTENT INSERT — one fulfilment per authorisation. A repeat performs nothing; we return the existing id.
  insert into public.receptionist_conversation_fulfilments (
    org_id, authorisation_id, fulfilment_type, fulfilment_outcome, approval_state, correlation_id,
    review_audit_id, sent_audit_id, review_resolution_id,
    conversation_id, enquiry_id, lead_id, customer_ref, action_id, execution_id,
    job_type, postcode, phone_number, metadata
  ) values (
    p_org_id, p_authorisation_id, p_fulfilment_type, p_fulfilment_outcome, p_approval_state, p_correlation_id,
    p_review_audit_id, p_sent_audit_id, p_review_resolution_id,
    p_conversation_id, p_enquiry_id, p_lead_id, p_customer_ref, p_action_id, p_execution_id,
    p_job_type, p_postcode, p_phone_number, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (authorisation_id) do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row when the authorisation was already fulfilled — resolve the existing
  -- fulfilment's id so the caller always gets a stable id and the operation is a true no-op on repeat.
  if v_id is null then
    select id into v_id
      from public.receptionist_conversation_fulfilments
      where authorisation_id = p_authorisation_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_fulfilment(
  uuid, uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_fulfilment(
  uuid, uuid, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. find_receptionist_pending_booking_authorisation — the single service-role-only SECURITY DEFINER READER the
--    runtime uses to resolve the PENDING approve_booking authorisation behind a held reply a human just approved.
--    It reads ONLY the R29 `receptionist_conversation_authorisations` ledger (no write), scoped by org and the
--    held reply, returning exactly the fields the runtime needs to reconstruct the authorisation and thread the
--    fulfilment. This is the JOIN the Fulfilment Engine performs over; the actual approval FOLD stays in R29's
--    pure `deriveAuthorisationState` (this reader supplies the row; it never decides approval). EXECUTE revoked
--    from PUBLIC / anon / authenticated, granted only to service_role.
-- ---------------------------------------------------------------------------
create or replace function public.find_receptionist_pending_booking_authorisation(
  p_org_id          uuid,
  p_review_audit_id uuid
)
returns table (
  authorisation_id      uuid,
  conversation_id       uuid,
  enquiry_id            uuid,
  lead_id               uuid,
  customer_ref          text,
  correlation_id        uuid,
  action_id             uuid,
  execution_id          uuid,
  requirement           text,
  authorisation_state   text,
  execution_eligibility text,
  job_type              text,
  postcode              text,
  phone_number          text
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
    a.phone_number
  from public.receptionist_conversation_authorisations a
  where a.org_id = p_org_id
    and a.review_audit_id = p_review_audit_id
    and a.authorisation_type = 'approve_booking'
    and a.authorisation_state = 'pending'
    and a.status = 'assessed'
  order by a.created_at desc
  limit 1;
$$;

revoke all on function public.find_receptionist_pending_booking_authorisation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.find_receptionist_pending_booking_authorisation(uuid, uuid)
  to service_role;
