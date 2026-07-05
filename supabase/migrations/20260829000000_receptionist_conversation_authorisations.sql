-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation AUTHORISATION-DECISION ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R29:
--  CONVERSATION AUTHORISATION ENGINE).
--
-- R17–R25 built the DERIVING stack; R26 added the OUTCOME ENGINE (RESOLVES an internal outcome); R27 added the
-- ACTION ENGINE (PREPARES an internal business action); R28 added the EXECUTION ENGINE (DECIDES whether a
-- prepared action is ELIGIBLE to execute, in its own append-only ledger). R29 is the NEXT layer: the
-- Authorisation Engine takes a decided EXECUTION DECISION and DETERMINES whether it requires approval — and
-- records the authorisation STATE. This migration is that decision's durable, append-only home. Booking approval
-- is the FIRST authorisation type; the decision captures the requirement, the turn-time state, the execution
-- eligibility it folded, the booking payload it authorises over, and the anchors that thread it to the very
-- execution row it authorises AND to the held reply in the EXISTING Human Review inbox.
--
-- IT DETERMINES APPROVAL — IT DOES NOT GRANT IT, AND IT DOES NOT EXECUTE. The `status` column is CHECK-pinned to
-- the single value 'assessed' (never 'approved', never 'executed'), and the `authorisation_state` column is
-- CHECK-pinned to a closed set that DELIBERATELY OMITS any grant value: the strongest a row can express is
-- 'pending'. R29's law ("the Authorisation Engine determines approval; it does not broaden authority beyond the
-- approved scope, and it executes nothing") is made storage: a row here can NEVER represent a granted approval,
-- an external business action, or an autonomous decision. The grant itself (`approved` / `rejected`) lives ONLY
-- in the EXISTING Human Review ledger (`receptionist_review_resolutions`, R14) — this ledger references the held
-- reply it belongs to (`review_audit_id`) so the two JOIN, but it never re-records the human's decision. That is
-- how "integrate with Human Review, do not duplicate it" is enforced structurally.
--
-- THE FOLD IS ENFORCED BY THE DATABASE — the decision is DETERMINISTIC by construction. A CHECK constraint pins
-- (`requirement`, `authorisation_state`) to the exact deterministic fold of its input (`execution_eligibility`):
-- requires_human_review ⇒ (human_approval_required, 'pending'); blocked_by_policy / blocked_by_org ⇒
-- (not_required, 'foreclosed'). No writer — not even service_role with a direct insert — can file a row whose
-- requirement or state contradicts the eligibility it folded, so the ledger is structurally incapable of
-- recording a non-deterministic authorisation or an autonomous grant. Human Review, Policy and the Execution
-- Engine remain MANDATORY by construction: every approvable booking lands on 'pending' (a human must approve), a
-- policy- or org-blocked execution lands on 'foreclosed', and the eligibility is the R28 engine's, folded here.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. An authorisation decision is a fact about one decided execution on
-- one turn, exactly as an execution (R28), an action (R27), an outcome (R26) and a reply audit
-- (20260815000000) are. It gets the SAME first-class, append-only home as
-- `receptionist_conversation_executions` (20260828000000) — not a best-effort spine fragment, not a mutable
-- column — so a decision can never be silently rewritten or erased. The confirmation the customer receives is
-- STILL produced and audited by the UNCHANGED reply pipeline (Generate → Enforce → Audit → Transport), and the
-- human's GRANT is STILL recorded by the UNCHANGED Human Review architecture (R14); this ledger records the
-- INTERNAL authorisation decision ALONGSIDE them, threaded to the SAME `correlation_id`, so an auditor can join
-- the decision to the confirmation reply that announced it, to the execution row it authorises (`execution_id`),
-- and to the held reply a human resolves (`review_audit_id`).
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the
-- `receptionist_conversation_executions` ledger:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER write primitive are the
--     only writers/readers; every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role, so a decision can never
--     be rewritten or erased.
--   • A single validated SECURITY DEFINER write entry point, EXECUTE revoked from PUBLIC / anon /
--     authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + function + triggers. No tenant table is touched, no existing
-- column is altered, and no producer is wired by this migration (the server runtime wires the store in
-- TypeScript). References to organisation / conversation / enquiry / customer / action / execution / held reply
-- are carried as DENORMALISED, un-FK'd facts (the append-only rule: a decision must outlive the rows it
-- describes, so no `on delete cascade` can ever erase authorisation-decision history).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_authorisations — one append-only record per AUTHORISATION DECISION. RLS:hq.
--    Captures WHAT was decided (`authorisation_type` + `requirement` + turn-time `authorisation_state`), the
--    INPUT that produced it (`execution_eligibility`, folded from the R28 execution decision), the booking
--    payload it authorises over, its non-granting `status`, and the anchors that thread it to the organisation,
--    conversation, enquiry, customer, prepared action and decided execution it concerns — and to the held reply
--    a human resolves in the EXISTING Human Review inbox (`review_audit_id`), and to the confirmation reply (and
--    the execution/action/outcome ledgers), via a SHARED `correlation_id`.
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_authorisations (
  id             uuid        primary key default gen_random_uuid(),
  -- WHO / WHERE — durable, un-FK'd facts (survive deletion of the referenced rows).
  org_id         uuid        not null,                 -- the organisation
  conversation_id uuid,                                 -- the conversation (receptionist_conversations.id)
  enquiry_id     uuid,                                  -- the originating inbound_enquiries.id, if known
  lead_id        uuid,                                  -- the customer (leads.id), if a lead exists
  customer_ref   text,                                  -- the caller identifier (phone / handle / email)
  correlation_id uuid        not null,                 -- the end-to-end trace id (shared with the reply audit)
  action_id      uuid,                                  -- the R27 action row, if filed
  execution_id   uuid,                                  -- the R28 execution row this decision authorises, if filed
  -- The held reply this authorisation belongs to, when the confirmation was HELD for review (verdict='review').
  -- A soft (un-FK'd) reference to the `ai_reply_audits` row the EXISTING R14 Human Review inbox surfaces and a
  -- human resolves in `receptionist_review_resolutions`. NULL when the confirmation auto-sent (verdict='allow')
  -- or was blocked — the authorisation is still recorded, and a future booking-approval inbox surfaces it via
  -- this ledger. This is the JOIN to Human Review; the grant itself is NEVER stored here.
  review_audit_id uuid,
  -- WHAT was decided.
  authorisation_type text    not null
                             check (authorisation_type in ('approve_booking')),
  -- The REQUIREMENT — is approval required? CHECK-pinned to the closed set; folded from the eligibility below.
  requirement    text        not null
                             check (requirement in ('human_approval_required', 'not_required')),
  -- The turn-time STATE — CHECK-pinned to a closed set that DELIBERATELY OMITS any grant value ('approved' /
  -- 'rejected'). The strongest a row can express is 'pending': a booking is a §9 A4 customer commitment and is
  -- never auto-approved. The grant states live ONLY in the EXISTING Human Review ledger; this store is
  -- structurally incapable of recording an approval.
  authorisation_state text   not null
                             check (authorisation_state in ('pending', 'foreclosed')),
  -- The INPUT that produced the requirement + state — the R28 execution eligibility this decision folded.
  -- Recorded so the decision is fully reconstructable from the row alone (and so the fold below can be enforced
  -- structurally). The policy verdict and org control that produced the eligibility are reachable via the
  -- linked `execution_id` row — R29 never re-imports or re-stores them.
  execution_eligibility text not null
                             check (execution_eligibility in ('requires_human_review', 'blocked_by_policy', 'blocked_by_org')),
  -- The BOOKING payload the decision authorises over — the trade, the place and the number to ring. Each bounded
  -- in DDL to its R20 shape so the ledger can never store a malformed booking phone or postcode. Nullable at the
  -- column level (future authorisation types may not carry these); the write primitive REQUIRES all three for an
  -- `approve_booking` decision.
  job_type       text,
  postcode       text        check (postcode is null or postcode ~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'),
  phone_number   text        check (phone_number is null or phone_number ~ '^\+\d{10,15}$'),
  -- NON-GRANTING BY CONSTRUCTION: a requirement is ASSESSED, never GRANTED here. Pinned to the single value
  -- 'assessed' so the ledger can never claim an approval was granted or an action executed.
  status         text        not null default 'assessed'
                             check (status = 'assessed'),
  -- Authorisation metadata — the resolving path, the strategy/goal it derived from, etc.
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now(),
  -- THE FOLD, ENFORCED. (`requirement`, `authorisation_state`) is the exact deterministic fold of
  -- `execution_eligibility`: requires_human_review ⇒ (human_approval_required, pending); blocked_by_policy /
  -- blocked_by_org ⇒ (not_required, foreclosed). No row can contradict its own input, so the decision is
  -- deterministic and an autonomous grant is unrepresentable at the storage layer.
  constraint receptionist_conversation_authorisations_state_fold check (
    (execution_eligibility = 'requires_human_review'
      and requirement = 'human_approval_required' and authorisation_state = 'pending')
    or (execution_eligibility in ('blocked_by_policy', 'blocked_by_org')
      and requirement = 'not_required' and authorisation_state = 'foreclosed')
  )
);

create index if not exists receptionist_conversation_authorisations_org_created_idx
  on public.receptionist_conversation_authorisations (org_id, created_at desc);
create index if not exists receptionist_conversation_authorisations_correlation_idx
  on public.receptionist_conversation_authorisations (correlation_id);
create index if not exists receptionist_conversation_authorisations_conversation_idx
  on public.receptionist_conversation_authorisations (conversation_id)
  where conversation_id is not null;
create index if not exists receptionist_conversation_authorisations_execution_idx
  on public.receptionist_conversation_authorisations (execution_id)
  where execution_id is not null;
-- The JOIN to the EXISTING Human Review inbox — find the authorisation for a held reply a human is resolving.
create index if not exists receptionist_conversation_authorisations_review_audit_idx
  on public.receptionist_conversation_authorisations (review_audit_id)
  where review_audit_id is not null;
-- Authorisation analytics — how many decisions of each type/requirement/state were rendered.
create index if not exists receptionist_conversation_authorisations_type_idx
  on public.receptionist_conversation_authorisations (authorisation_type, requirement, authorisation_state, created_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER write primitive are the
-- only paths in; every JWT client (anon / authenticated) is denied because an RLS-enabled table with no
-- policies defaults to deny. No table grant can open it.
alter table public.receptionist_conversation_authorisations enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a decision is a fact about one decided execution, never updated or deleted. Reject
--    UPDATE/DELETE even under service_role so a decision can never be rewritten or erased. Mirrors the
--    `receptionist_conversation_executions` append-only guard.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_authorisations_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_authorisations is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_authorisations_no_update
  on public.receptionist_conversation_authorisations;
create trigger receptionist_conversation_authorisations_no_update
  before update on public.receptionist_conversation_authorisations
  for each row execute function public.receptionist_conversation_authorisations_block_mutation();

drop trigger if exists receptionist_conversation_authorisations_no_delete
  on public.receptionist_conversation_authorisations;
create trigger receptionist_conversation_authorisations_no_delete
  before delete on public.receptionist_conversation_authorisations
  for each row execute function public.receptionist_conversation_authorisations_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_authorisation — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND
--    ONLY this to record a decision; the write is BEST-EFFORT there (a failure is logged and swallowed so a
--    durable, audited confirmation reply is never undone by a bookkeeping write), but the primitive itself
--    validates strictly: the authorisation type, requirement, state and execution eligibility must be in their
--    vocabularies, an `approve_booking` MUST carry a job type plus a well-formed postcode and E.164 number, and
--    the fold CHECK guarantees (requirement, state) matches the eligibility. Returns the new id.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_authorisation(
  p_org_id                uuid,
  p_authorisation_type    text,
  p_requirement           text,
  p_authorisation_state   text,
  p_execution_eligibility text,
  p_correlation_id        uuid,
  p_conversation_id       uuid    default null,
  p_enquiry_id            uuid    default null,
  p_lead_id               uuid    default null,
  p_customer_ref          text    default null,
  p_action_id             uuid    default null,
  p_execution_id          uuid    default null,
  p_review_audit_id       uuid    default null,
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
  if p_authorisation_type not in ('approve_booking') then
    raise exception 'receptionist authorisation type must be one of approve_booking, got %', p_authorisation_type
      using errcode = 'check_violation';
  end if;

  if p_requirement not in ('human_approval_required', 'not_required') then
    raise exception 'receptionist authorisation requirement must be one of human_approval_required, not_required, got %', p_requirement
      using errcode = 'check_violation';
  end if;

  -- The turn-time state must be a NON-GRANTING value. The grant states ('approved'/'rejected') are NEVER written
  -- here — they live in the EXISTING Human Review ledger. This primitive can only ever file 'pending'/'foreclosed'.
  if p_authorisation_state not in ('pending', 'foreclosed') then
    raise exception 'receptionist authorisation state must be one of pending, foreclosed (a grant is never recorded here), got %', p_authorisation_state
      using errcode = 'check_violation';
  end if;

  if p_execution_eligibility not in ('requires_human_review', 'blocked_by_policy', 'blocked_by_org') then
    raise exception 'receptionist authorisation execution_eligibility must be one of requires_human_review, blocked_by_policy, blocked_by_org, got %', p_execution_eligibility
      using errcode = 'check_violation';
  end if;

  -- An approve_booking decision MUST carry the three facts a human needs to weigh the visit — the trade, the
  -- place and the number to ring — each well-formed. The ledger never authorises over an unusable booking.
  -- (The column CHECKs also enforce the phone / postcode shapes; this gives a precise error for the missing
  -- case and requires the job type non-empty, which the column deliberately leaves to R20's validity authority.)
  if p_authorisation_type = 'approve_booking'
     and (
       p_job_type is null or length(trim(p_job_type)) = 0
       or p_postcode is null or p_postcode !~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'
       or p_phone_number is null or p_phone_number !~ '^\+\d{10,15}$'
     ) then
    raise exception 'receptionist approve_booking decision requires a job type, a well-formed postcode and a well-formed E.164 phone number, got job_type=%, postcode=%, phone=%',
      coalesce(p_job_type, 'null'), coalesce(p_postcode, 'null'), coalesce(p_phone_number, 'null')
      using errcode = 'check_violation';
  end if;

  -- The (requirement, state) MUST be the deterministic fold of the execution eligibility. Belt-and-braces with
  -- the table CHECK: a precise error for a mismatched decision (an autonomous-approve attempt, or a fold
  -- contradiction).
  if not (
       (p_execution_eligibility = 'requires_human_review'
         and p_requirement = 'human_approval_required' and p_authorisation_state = 'pending')
       or (p_execution_eligibility in ('blocked_by_policy', 'blocked_by_org')
         and p_requirement = 'not_required' and p_authorisation_state = 'foreclosed')
     ) then
    raise exception 'receptionist authorisation (requirement=%, state=%) does not match the deterministic fold of execution_eligibility=%',
      p_requirement, p_authorisation_state, p_execution_eligibility
      using errcode = 'check_violation';
  end if;

  insert into public.receptionist_conversation_authorisations (
    org_id, authorisation_type, requirement, authorisation_state, execution_eligibility, correlation_id,
    conversation_id, enquiry_id, lead_id, customer_ref, action_id, execution_id, review_audit_id,
    job_type, postcode, phone_number, metadata
  ) values (
    p_org_id, p_authorisation_type, p_requirement, p_authorisation_state, p_execution_eligibility, p_correlation_id,
    p_conversation_id, p_enquiry_id, p_lead_id, p_customer_ref, p_action_id, p_execution_id, p_review_audit_id,
    p_job_type, p_postcode, p_phone_number, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_authorisation(
  uuid, text, text, text, text, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_authorisation(
  uuid, text, text, text, text, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, text, jsonb
) to service_role;
