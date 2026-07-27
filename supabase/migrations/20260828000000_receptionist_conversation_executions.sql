-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation EXECUTION-DECISION ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R28:
--  CONVERSATION EXECUTION ENGINE).
--
-- R17–R25 built the DERIVING stack; R26 added the OUTCOME ENGINE (RESOLVES an internal outcome); R27 added the
-- ACTION ENGINE (PREPARES an internal business action — a `prepare_booking` proposal — in its own append-only
-- ledger). R28 is the NEXT layer: the Execution Engine takes a PREPARED action, the reply's ALREADY-computed
-- policy verdict, and the organisation's controls, and DECIDES whether that action is eligible to execute —
-- and under what authority. This migration is that decision's durable, append-only home. Booking execution is
-- the FIRST execution type; the decision captures the eligibility, the policy verdict it consumed, the
-- organisational control it validated, and the booking payload it decided over.
--
-- IT DECIDES ELIGIBILITY — IT DOES NOT EXECUTE. The `status` column is CHECK-pinned to the single value
-- 'decided' (never 'executed'), and the `eligibility` column is CHECK-pinned to a closed set that DELIBERATELY
-- OMITS any autonomous-execute value: the strongest a row can express is 'requires_human_review'. R28's law
-- ("the Execution Engine determines WHETHER work may execute; it does not broaden execution authority beyond
-- the approved scope, and it executes nothing") is made storage: a row here can NEVER represent an external
-- business action the engine took automatically — a placed booking, a calendar write, a scheduled visit — nor
-- can it EVER authorise one. Widening `status`, `execution_type` or `eligibility` is a future increment behind
-- its own explicit, reviewable migration.
--
-- THE FOLD IS ENFORCED BY THE DATABASE — the decision is DETERMINISTIC by construction. A CHECK constraint
-- pins `eligibility` to the exact deterministic fold of its two inputs (`live_execution`, `policy_verdict`):
-- org-disabled ⇒ 'blocked_by_org'; else policy-blocked ⇒ 'blocked_by_policy'; else 'requires_human_review'.
-- No writer — not even service_role with a direct insert — can file a row whose eligibility contradicts its
-- inputs, so the ledger is structurally incapable of recording a non-deterministic or autonomous decision.
-- Human Review, Policy and organisational control remain MANDATORY by construction: every executable booking
-- lands on 'requires_human_review', a `block` verdict forces 'blocked_by_policy', and a disabled org forces
-- 'blocked_by_org'.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. An execution decision is a fact about one prepared action on one
-- turn, exactly as an action (R27), an outcome (R26) and a reply audit (20260815000000) are. It gets the SAME
-- first-class, append-only home as `receptionist_conversation_actions` (20260827000000) and
-- `receptionist_conversation_outcomes` (20260826000000) — not a best-effort spine fragment, not a mutable
-- column — so a decision can never be silently rewritten or erased. The confirmation the customer receives is
-- STILL produced and audited by the UNCHANGED reply pipeline (Generate → Enforce → Audit → Transport); this
-- ledger records the INTERNAL decision ALONGSIDE it, threaded to the SAME `correlation_id`, so an auditor can
-- join the decision to the confirmation reply that announced it — and, via that shared id, to the action and
-- outcome ledgers too (and to the very action row it decides over, via `action_id`).
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the
-- `receptionist_conversation_actions` and `receptionist_conversation_outcomes` ledgers:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER write primitive are the
--     only writers/readers; every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role, so a decision can never
--     be rewritten or erased.
--   • A single validated SECURITY DEFINER write entry point, EXECUTE revoked from PUBLIC / anon /
--     authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + function + triggers. No tenant table is touched, no existing
-- column is altered, and no producer is wired by this migration (the server runtime wires the store in
-- TypeScript). References to organisation / conversation / enquiry / customer / action are carried as
-- DENORMALISED, un-FK'd facts (the append-only rule: a decision must outlive the rows it describes, so no
-- `on delete cascade` can ever erase execution-decision history).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_executions — one append-only record per EXECUTION DECISION. RLS:hq.
--    Captures WHAT was decided (`execution_type` + `eligibility`), the INPUTS that produced it (`policy_verdict`
--    consumed from the R3 guardrail, `live_execution` validated from the org control), the booking payload it
--    decided over, its non-executing `status`, and the anchors that thread it to the organisation,
--    conversation, enquiry, customer and prepared action it concerns — and to the confirmation reply (and the
--    action/outcome ledgers), via a SHARED `correlation_id`.
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_executions (
  id             uuid        primary key default gen_random_uuid(),
  -- WHO / WHERE — durable, un-FK'd facts (survive deletion of the referenced rows).
  org_id         uuid        not null,                 -- the organisation
  conversation_id uuid,                                 -- the conversation (receptionist_conversations.id)
  enquiry_id     uuid,                                  -- the originating inbound_enquiries.id, if known
  lead_id        uuid,                                  -- the customer (leads.id), if a lead exists
  customer_ref   text,                                  -- the caller identifier (phone / handle / email)
  correlation_id uuid        not null,                 -- the end-to-end trace id (shared with the reply audit)
  action_id      uuid,                                  -- the R27 action row this decision decides over, if filed
  -- WHAT was decided.
  execution_type text        not null
                             check (execution_type in ('execute_booking')),
  -- The ELIGIBILITY verdict — CHECK-pinned to a closed set that DELIBERATELY OMITS any autonomous-execute
  -- value. The strongest a row can express is 'requires_human_review': a booking is a §9 A4 customer
  -- commitment and never executes autonomously. The store is structurally incapable of authorising execution.
  eligibility    text        not null
                             check (eligibility in ('requires_human_review', 'blocked_by_policy', 'blocked_by_org')),
  -- The INPUTS that produced the eligibility — recorded so the decision is fully reconstructable from the row
  -- alone (and so the fold below can be enforced structurally).
  policy_verdict text        not null                  -- the R3 guardrail verdict consumed for this turn
                             check (policy_verdict in ('allow', 'review', 'block')),
  live_execution boolean     not null,                 -- whether the org had enabled controlled live execution
  -- The PREPARE-BOOKING payload the decision decided over — the trade, the place and the number to ring. Each
  -- bounded in DDL to its R20 shape so the ledger can never store a malformed booking phone or postcode.
  -- Nullable at the column level (future execution types may not carry these); the write primitive REQUIRES
  -- all three for an `execute_booking` decision.
  job_type       text,
  postcode       text        check (postcode is null or postcode ~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'),
  phone_number   text        check (phone_number is null or phone_number ~ '^\+\d{10,15}$'),
  -- NON-EXECUTING BY CONSTRUCTION: an eligibility is DECIDED, never externally EXECUTED. Pinned to the single
  -- value 'decided' so the ledger can never claim an automatic external business action.
  status         text        not null default 'decided'
                             check (status = 'decided'),
  -- Execution metadata — the resolving path, the strategy/goal it derived from, etc.
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now(),
  -- THE FOLD, ENFORCED. `eligibility` is the exact deterministic fold of (`live_execution`, `policy_verdict`):
  -- org-disabled ⇒ blocked_by_org; else policy-blocked ⇒ blocked_by_policy; else requires_human_review. No
  -- row can contradict its own inputs, so the decision is deterministic and autonomous execution is
  -- unrepresentable at the storage layer.
  constraint receptionist_conversation_executions_eligibility_fold check (
    (not live_execution and eligibility = 'blocked_by_org')
    or (live_execution and policy_verdict = 'block' and eligibility = 'blocked_by_policy')
    or (live_execution and policy_verdict <> 'block' and eligibility = 'requires_human_review')
  )
);

create index if not exists receptionist_conversation_executions_org_created_idx
  on public.receptionist_conversation_executions (org_id, created_at desc);
create index if not exists receptionist_conversation_executions_correlation_idx
  on public.receptionist_conversation_executions (correlation_id);
create index if not exists receptionist_conversation_executions_conversation_idx
  on public.receptionist_conversation_executions (conversation_id)
  where conversation_id is not null;
create index if not exists receptionist_conversation_executions_action_idx
  on public.receptionist_conversation_executions (action_id)
  where action_id is not null;
-- Execution analytics — how many decisions of each type/eligibility were rendered.
create index if not exists receptionist_conversation_executions_type_idx
  on public.receptionist_conversation_executions (execution_type, eligibility, created_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER write primitive are the
-- only paths in; every JWT client (anon / authenticated) is denied because an RLS-enabled table with no
-- policies defaults to deny. No table grant can open it.
alter table public.receptionist_conversation_executions enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a decision is a fact about one prepared action, never updated or deleted. Reject
--    UPDATE/DELETE even under service_role so a decision can never be rewritten or erased. Mirrors the
--    `receptionist_conversation_actions` append-only guard.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_executions_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_executions is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_executions_no_update
  on public.receptionist_conversation_executions;
create trigger receptionist_conversation_executions_no_update
  before update on public.receptionist_conversation_executions
  for each row execute function public.receptionist_conversation_executions_block_mutation();

drop trigger if exists receptionist_conversation_executions_no_delete
  on public.receptionist_conversation_executions;
create trigger receptionist_conversation_executions_no_delete
  before delete on public.receptionist_conversation_executions
  for each row execute function public.receptionist_conversation_executions_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_execution — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND
--    ONLY this to record a decision; the write is BEST-EFFORT there (a failure is logged and swallowed so a
--    durable, audited confirmation reply is never undone by a bookkeeping write), but the primitive itself
--    validates strictly: the execution type, eligibility and policy verdict must be in their vocabularies, an
--    `execute_booking` MUST carry a job type plus a well-formed postcode and E.164 number, and the eligibility
--    fold CHECK guarantees the decision matches its inputs. Returns the new id.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_execution(
  p_org_id          uuid,
  p_execution_type  text,
  p_eligibility     text,
  p_policy_verdict  text,
  p_live_execution  boolean,
  p_correlation_id  uuid,
  p_conversation_id uuid    default null,
  p_enquiry_id      uuid    default null,
  p_lead_id         uuid    default null,
  p_customer_ref    text    default null,
  p_action_id       uuid    default null,
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
  if p_execution_type not in ('execute_booking') then
    raise exception 'receptionist execution type must be one of execute_booking, got %', p_execution_type
      using errcode = 'check_violation';
  end if;

  if p_eligibility not in ('requires_human_review', 'blocked_by_policy', 'blocked_by_org') then
    raise exception 'receptionist execution eligibility must be one of requires_human_review, blocked_by_policy, blocked_by_org, got %', p_eligibility
      using errcode = 'check_violation';
  end if;

  if p_policy_verdict not in ('allow', 'review', 'block') then
    raise exception 'receptionist execution policy_verdict must be one of allow, review, block, got %', p_policy_verdict
      using errcode = 'check_violation';
  end if;

  -- An execute_booking decision MUST carry the three facts a human/CRM needs to arrange the visit — the trade,
  -- the place and the number to ring — each well-formed. The ledger never decides over an unusable booking.
  -- (The column CHECKs also enforce the phone / postcode shapes; this gives a precise error for the missing
  -- case and requires the job type non-empty, which the column deliberately leaves to R20's validity authority.)
  if p_execution_type = 'execute_booking'
     and (
       p_job_type is null or length(trim(p_job_type)) = 0
       or p_postcode is null or p_postcode !~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'
       or p_phone_number is null or p_phone_number !~ '^\+\d{10,15}$'
     ) then
    raise exception 'receptionist execute_booking decision requires a job type, a well-formed postcode and a well-formed E.164 phone number, got job_type=%, postcode=%, phone=%',
      coalesce(p_job_type, 'null'), coalesce(p_postcode, 'null'), coalesce(p_phone_number, 'null')
      using errcode = 'check_violation';
  end if;

  -- The eligibility MUST be the deterministic fold of its inputs. Belt-and-braces with the table CHECK: a
  -- precise error for a mismatched decision (an autonomous-execute attempt, or a fold contradiction).
  if not (
       (not p_live_execution and p_eligibility = 'blocked_by_org')
       or (p_live_execution and p_policy_verdict = 'block' and p_eligibility = 'blocked_by_policy')
       or (p_live_execution and p_policy_verdict <> 'block' and p_eligibility = 'requires_human_review')
     ) then
    raise exception 'receptionist execution eligibility % does not match the deterministic fold of live_execution=% policy_verdict=%',
      p_eligibility, p_live_execution, p_policy_verdict
      using errcode = 'check_violation';
  end if;

  insert into public.receptionist_conversation_executions (
    org_id, execution_type, eligibility, policy_verdict, live_execution, correlation_id,
    conversation_id, enquiry_id, lead_id, customer_ref, action_id,
    job_type, postcode, phone_number, metadata
  ) values (
    p_org_id, p_execution_type, p_eligibility, p_policy_verdict, p_live_execution, p_correlation_id,
    p_conversation_id, p_enquiry_id, p_lead_id, p_customer_ref, p_action_id,
    p_job_type, p_postcode, p_phone_number, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_execution(
  uuid, text, text, text, boolean, uuid, uuid, uuid, uuid, text, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_execution(
  uuid, text, text, text, boolean, uuid, uuid, uuid, uuid, text, uuid, text, text, text, jsonb
) to service_role;
