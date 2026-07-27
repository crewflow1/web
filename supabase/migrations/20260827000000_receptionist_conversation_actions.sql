-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation ACTION ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R27:
--  CONVERSATION ACTION ENGINE).
--
-- R17–R25 built the DERIVING stack; R26 added the OUTCOME ENGINE — the first layer that ACTS on a satisfied
-- objective, RECORDING an internal outcome (a callback) in its own append-only ledger. R27 is the NEXT layer:
-- the Action Engine converts the conversation's resolved OUTCOME into an internal BUSINESS ACTION PROPOSAL and
-- records it. When the objective is SATISFIED, the strategy says PROGRESS, and the Outcome Engine did NOT
-- claim the turn, the Action Engine resolves an INTERNAL ACTION and prepares it. This migration is that
-- action's durable, append-only home. Booking preparation is the FIRST action type; the job type, postcode
-- and callback number the team needs to arrange the visit are captured here.
--
-- IT PREPARES WORK — IT DOES NOT EXECUTE WORK. The `status` column is CHECK-pinned to the single value
-- 'prepared' (never 'executed'), so a row here can NEVER represent an external business action the engine took
-- automatically — a placed booking, a calendar write, a generated quote, a scheduled visit. R27's law ("the
-- Action Engine prepares work; it does not execute work — it must NOT execute external business actions
-- automatically") is made storage: an internal action is PREPARED for a human/CRM to act on, and the ledger is
-- structurally incapable of claiming otherwise. Widening `status` (or `action_type`) is a future increment
-- behind its own explicit, reviewable migration.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. An action is a fact about one satisfied objective on one turn,
-- exactly as an outcome (R26) and a reply audit (20260815000000) are. It gets the SAME first-class,
-- append-only home as `receptionist_conversation_outcomes` (20260826000000) and `ai_reply_audits` — not a
-- best-effort spine fragment, not a mutable column — so a prepared action can never be silently rewritten or
-- erased. The confirmation the customer receives is STILL produced and audited by the UNCHANGED reply pipeline
-- (Generate → Enforce → Audit → Transport); this ledger records the INTERNAL action ALONGSIDE it, threaded to
-- the SAME `correlation_id`, so an auditor can join the action to the confirmation reply that announced it —
-- and, via that shared id, to the outcome ledger too.
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the
-- `receptionist_conversation_outcomes` and `ai_reply_audits` ledgers:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER write primitive are the
--     only writers/readers; every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role, so a prepared action can
--     never be rewritten or erased.
--   • A single validated SECURITY DEFINER write entry point, EXECUTE revoked from PUBLIC / anon /
--     authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + function + triggers. No tenant table is touched, no existing
-- column is altered, and no producer is wired by this migration (the server runtime wires the store in
-- TypeScript). References to organisation / conversation / enquiry / customer are carried as DENORMALISED,
-- un-FK'd facts (the append-only rule: an action must outlive the rows it describes, so no
-- `on delete cascade` can ever erase action history).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_actions — one append-only record per PREPARED internal action. RLS:hq.
--    Captures WHAT action was prepared (`action_type` + its payload), its non-executing `status`, and the
--    anchors that thread it to the organisation, conversation, enquiry and customer it concerns — and to the
--    confirmation reply (and the outcome ledger), via a SHARED `correlation_id`.
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_actions (
  id             uuid        primary key default gen_random_uuid(),
  -- WHO / WHERE — durable, un-FK'd facts (survive deletion of the referenced rows).
  org_id         uuid        not null,                 -- the organisation
  conversation_id uuid,                                 -- the conversation (receptionist_conversations.id)
  enquiry_id     uuid,                                  -- the originating inbound_enquiries.id, if known
  lead_id        uuid,                                  -- the customer (leads.id), if a lead exists
  customer_ref   text,                                  -- the caller identifier (phone / handle / email)
  correlation_id uuid        not null,                 -- the end-to-end trace id (shared with the reply audit)
  -- WHAT action was prepared.
  action_type    text        not null
                             check (action_type in ('prepare_booking')),
  -- The PREPARE-BOOKING payload — the trade, the place and the number to ring. Each bounded in DDL to its R20
  -- shape so the ledger can never store a malformed booking phone or postcode. Nullable at the column level
  -- (future action types may not carry these); the write primitive REQUIRES all three for a `prepare_booking`.
  -- (`job_type` membership stays R20's single authority — validated by the pure core before the write — so it
  --  is deliberately NOT re-encoded as a SQL enumeration here; the primitive requires it non-empty.)
  job_type       text,
  postcode       text        check (postcode is null or postcode ~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'),
  phone_number   text        check (phone_number is null or phone_number ~ '^\+\d{10,15}$'),
  -- NON-EXECUTING BY CONSTRUCTION: an internal action is PREPARED, never externally EXECUTED. Pinned to the
  -- single value 'prepared' so the ledger can never claim an automatic external business action.
  status         text        not null default 'prepared'
                             check (status = 'prepared'),
  -- Execution metadata — the resolving path, the strategy/goal it derived from, etc.
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now()
);

create index if not exists receptionist_conversation_actions_org_created_idx
  on public.receptionist_conversation_actions (org_id, created_at desc);
create index if not exists receptionist_conversation_actions_correlation_idx
  on public.receptionist_conversation_actions (correlation_id);
create index if not exists receptionist_conversation_actions_conversation_idx
  on public.receptionist_conversation_actions (conversation_id)
  where conversation_id is not null;
-- Action analytics — how many of each action type were prepared.
create index if not exists receptionist_conversation_actions_type_idx
  on public.receptionist_conversation_actions (action_type, created_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER write primitive are the
-- only paths in; every JWT client (anon / authenticated) is denied because an RLS-enabled table with no
-- policies defaults to deny. No table grant can open it.
alter table public.receptionist_conversation_actions enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a prepared action is a fact about one satisfied objective, never updated or deleted.
--    Reject UPDATE/DELETE even under service_role so a prepared action can never be rewritten or erased.
--    Mirrors the `receptionist_conversation_outcomes` append-only guard.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_actions_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_actions is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_actions_no_update
  on public.receptionist_conversation_actions;
create trigger receptionist_conversation_actions_no_update
  before update on public.receptionist_conversation_actions
  for each row execute function public.receptionist_conversation_actions_block_mutation();

drop trigger if exists receptionist_conversation_actions_no_delete
  on public.receptionist_conversation_actions;
create trigger receptionist_conversation_actions_no_delete
  before delete on public.receptionist_conversation_actions
  for each row execute function public.receptionist_conversation_actions_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_action — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND
--    ONLY this to prepare an action; the write is BEST-EFFORT there (a failure is logged and swallowed so a
--    durable, audited confirmation reply is never undone by a bookkeeping write), but the primitive itself
--    validates strictly: the action type must be in the vocabulary, and a `prepare_booking` MUST carry a job
--    type plus a well-formed postcode and E.164 number. Returns the new id.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_action(
  p_org_id          uuid,
  p_action_type     text,
  p_correlation_id  uuid,
  p_conversation_id uuid    default null,
  p_enquiry_id      uuid    default null,
  p_lead_id         uuid    default null,
  p_customer_ref    text    default null,
  p_job_type        text    default null,
  p_postcode        text    default null,
  p_phone_number    text    default null,
  p_metadata        jsonb   default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_action_type not in ('prepare_booking') then
    raise exception 'receptionist action type must be one of prepare_booking, got %', p_action_type
      using errcode = 'check_violation';
  end if;

  -- A prepare_booking action MUST carry the three facts a human/CRM needs to arrange the visit — the trade,
  -- the place and the number to ring — each well-formed. The ledger never prepares an unusable booking. (The
  -- column CHECKs also enforce the phone / postcode shapes; this gives a precise error for the missing case
  -- and requires the job type non-empty, which the column deliberately leaves to R20's validity authority.)
  if p_action_type = 'prepare_booking'
     and (
       p_job_type is null or length(trim(p_job_type)) = 0
       or p_postcode is null or p_postcode !~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'
       or p_phone_number is null or p_phone_number !~ '^\+\d{10,15}$'
     ) then
    raise exception 'receptionist prepare_booking action requires a job type, a well-formed postcode and a well-formed E.164 phone number, got job_type=%, postcode=%, phone=%',
      coalesce(p_job_type, 'null'), coalesce(p_postcode, 'null'), coalesce(p_phone_number, 'null')
      using errcode = 'check_violation';
  end if;

  insert into public.receptionist_conversation_actions (
    org_id, action_type, correlation_id, conversation_id, enquiry_id, lead_id, customer_ref,
    job_type, postcode, phone_number, metadata
  ) values (
    p_org_id, p_action_type, p_correlation_id, p_conversation_id, p_enquiry_id, p_lead_id, p_customer_ref,
    p_job_type, p_postcode, p_phone_number, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_action(
  uuid, text, uuid, uuid, uuid, uuid, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_action(
  uuid, text, uuid, uuid, uuid, uuid, text, text, text, text, jsonb
) to service_role;
