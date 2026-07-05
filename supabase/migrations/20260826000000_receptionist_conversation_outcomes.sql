-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation OUTCOME ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R26:
--  CONVERSATION OUTCOME ENGINE).
--
-- R17–R25 built the DERIVING stack: state, intent, goal, information, gap, strategy, prompt, response and
-- generation. Every one of those layers OBSERVES, DERIVES or WORDS — none of them ACTS. R26 is the FIRST
-- layer that ACTS on a satisfied conversational goal: when the objective is SATISFIED and the strategy says
-- PROGRESS, the Outcome Engine resolves an INTERNAL OUTCOME and records it. This migration is that outcome's
-- durable, append-only home. Callback fulfilment is the FIRST outcome type; the number the customer asked us
-- to ring back is captured here.
--
-- IT RECORDS INTERNAL OUTCOMES — IT NEVER EXECUTES A BUSINESS ACTION. The `status` column is CHECK-pinned to
-- the single value 'recorded' (never 'executed'), so a row here can NEVER represent an external business
-- action the engine took automatically — booking, scheduling, a placed call. R26's law ("the Outcome Engine
-- may create internal outcomes; it must NOT execute external business actions automatically") is made
-- storage: an internal outcome is RECORDED for a human/CRM to act on, and the ledger is structurally
-- incapable of claiming otherwise. Widening `status` (or `outcome_type`) is a future increment behind its own
-- explicit, reviewable migration.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. An outcome is a fact about one satisfied objective on one turn,
-- exactly as a reply audit is a fact about one attempted reply. It gets the SAME first-class, append-only
-- home as `ai_reply_audits` (20260815000000) — not a best-effort spine fragment, not a mutable column — so a
-- recorded outcome can never be silently rewritten or erased. The confirmation the customer receives is
-- STILL produced and audited by the UNCHANGED reply pipeline (Generate → Enforce → Audit → Transport); this
-- ledger records the INTERNAL outcome ALONGSIDE it, threaded to the SAME `correlation_id`, so an auditor can
-- join the outcome to the confirmation reply that announced it.
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the `ai_reply_audits`
-- ledger:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER write primitive are the
--     only writers/readers; every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role, so a recorded outcome
--     can never be rewritten or erased.
--   • A single validated SECURITY DEFINER write entry point, EXECUTE revoked from PUBLIC / anon /
--     authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + function + triggers. No tenant table is touched, no existing
-- column is altered, and no producer is wired by this migration (the server runtime wires the store in
-- TypeScript). References to organisation / conversation / enquiry / customer are carried as DENORMALISED,
-- un-FK'd facts (the append-only rule: an outcome must outlive the rows it describes, so no
-- `on delete cascade` can ever erase outcome history).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_outcomes — one append-only record per RESOLVED internal outcome. RLS:hq.
--    Captures WHAT outcome was resolved (`outcome_type` + its payload), its non-executing `status`, and the
--    anchors that thread it to the organisation, conversation, enquiry and customer it concerns — and to the
--    confirmation reply, via a SHARED `correlation_id`.
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_outcomes (
  id             uuid        primary key default gen_random_uuid(),
  -- WHO / WHERE — durable, un-FK'd facts (survive deletion of the referenced rows).
  org_id         uuid        not null,                 -- the organisation
  conversation_id uuid,                                 -- the conversation (receptionist_conversations.id)
  enquiry_id     uuid,                                  -- the originating inbound_enquiries.id, if known
  lead_id        uuid,                                  -- the customer (leads.id), if a lead exists
  customer_ref   text,                                  -- the caller identifier (phone / handle / email)
  correlation_id uuid        not null,                 -- the end-to-end trace id (shared with the reply audit)
  -- WHAT outcome was resolved.
  outcome_type   text        not null
                             check (outcome_type in ('callback')),
  -- The CALLBACK payload — the E.164 number to ring back. Bounded in DDL to the R20 phone shape so the ledger
  -- can never store a malformed callback number. Nullable at the column level (future outcome types may not
  -- carry a phone); the write primitive REQUIRES it for a `callback`.
  phone_number   text        check (phone_number is null or phone_number ~ '^\+\d{10,15}$'),
  -- NON-EXECUTING BY CONSTRUCTION: an internal outcome is RECORDED, never externally EXECUTED. Pinned to the
  -- single value 'recorded' so the ledger can never claim an automatic external business action.
  status         text        not null default 'recorded'
                             check (status = 'recorded'),
  -- Execution metadata — the resolving path, the strategy/goal it derived from, etc.
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now()
);

create index if not exists receptionist_conversation_outcomes_org_created_idx
  on public.receptionist_conversation_outcomes (org_id, created_at desc);
create index if not exists receptionist_conversation_outcomes_correlation_idx
  on public.receptionist_conversation_outcomes (correlation_id);
create index if not exists receptionist_conversation_outcomes_conversation_idx
  on public.receptionist_conversation_outcomes (conversation_id)
  where conversation_id is not null;
-- Outcome analytics — how many of each outcome type were recorded.
create index if not exists receptionist_conversation_outcomes_type_idx
  on public.receptionist_conversation_outcomes (outcome_type, created_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER write primitive are the
-- only paths in; every JWT client (anon / authenticated) is denied because an RLS-enabled table with no
-- policies defaults to deny. No table grant can open it.
alter table public.receptionist_conversation_outcomes enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a recorded outcome is a fact about one satisfied objective, never updated or
--    deleted. Reject UPDATE/DELETE even under service_role so a recorded outcome can never be rewritten or
--    erased. Mirrors the `ai_reply_audits` append-only guard.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_outcomes_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_outcomes is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_outcomes_no_update
  on public.receptionist_conversation_outcomes;
create trigger receptionist_conversation_outcomes_no_update
  before update on public.receptionist_conversation_outcomes
  for each row execute function public.receptionist_conversation_outcomes_block_mutation();

drop trigger if exists receptionist_conversation_outcomes_no_delete
  on public.receptionist_conversation_outcomes;
create trigger receptionist_conversation_outcomes_no_delete
  before delete on public.receptionist_conversation_outcomes
  for each row execute function public.receptionist_conversation_outcomes_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_outcome — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND
--    ONLY this to file an outcome; the write is BEST-EFFORT there (a failure is logged and swallowed so a
--    durable, audited confirmation reply is never undone by a bookkeeping write), but the primitive itself
--    validates strictly: the outcome type must be in the vocabulary, and a `callback` MUST carry a
--    well-formed E.164 number. Returns the new id.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_outcome(
  p_org_id          uuid,
  p_outcome_type    text,
  p_correlation_id  uuid,
  p_conversation_id uuid    default null,
  p_enquiry_id      uuid    default null,
  p_lead_id         uuid    default null,
  p_customer_ref    text    default null,
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
  if p_outcome_type not in ('callback') then
    raise exception 'receptionist outcome type must be one of callback, got %', p_outcome_type
      using errcode = 'check_violation';
  end if;

  -- A callback outcome MUST carry a well-formed E.164 number — the ledger never records an unringable
  -- callback. (The column CHECK also enforces the shape; this gives a precise error for the missing case.)
  if p_outcome_type = 'callback'
     and (p_phone_number is null or p_phone_number !~ '^\+\d{10,15}$') then
    raise exception 'receptionist callback outcome requires a well-formed E.164 phone number, got %',
      coalesce(p_phone_number, 'null')
      using errcode = 'check_violation';
  end if;

  insert into public.receptionist_conversation_outcomes (
    org_id, outcome_type, correlation_id, conversation_id, enquiry_id, lead_id, customer_ref,
    phone_number, metadata
  ) values (
    p_org_id, p_outcome_type, p_correlation_id, p_conversation_id, p_enquiry_id, p_lead_id, p_customer_ref,
    p_phone_number, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_outcome(
  uuid, text, uuid, uuid, uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_outcome(
  uuid, text, uuid, uuid, uuid, uuid, text, text, jsonb
) to service_role;
