-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation WORK CLAIM ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R46:
--  CONVERSATION WORK CLAIM).
--
-- R37–R45 built the READ spine over recorded coordinations (Read Model → Worklist Engine → Read Surface → API →
-- Client → Session → View Model → Operator Surface → Detail Surface). Every one of those layers is READ-ONLY: they
-- LIST and INSPECT the conversations the receptionist has coordinated, and NOTHING on them claims, mutates or executes
-- work. R46 is the NEXT layer — and, in this whole stack, the FIRST that lets a HUMAN OPERATOR WRITE: it records that
-- an operator has taken OWNERSHIP of one Conversation Worklist item. This migration is that claim's durable,
-- append-only, CONFLICT-GUARDED home. Conversation-work claiming is the FIRST (and only R46) claim type; the record
-- captures WHAT was claimed (`claim_type` + `claim_outcome`), WHO claimed it (`operator_id` + denormalised
-- `operator_email`), WHEN (`claimed_at`), its `status`, and the anchors that thread it to the coordination it is filed
-- against (`coordination_id`, NOT NULL and UNIQUE — R46's load-bearing anchor AND conflict key), to the conversation
-- (`conversation_id`) and to the end-to-end trace (`correlation_id`).
--
-- IT RECORDS OWNERSHIP — IT NEVER EXECUTES WORK. A claim row is a statement of RESPONSIBILITY: it assigns nothing
-- automatically, dispatches nothing, notifies no one, schedules nothing, fulfils nothing, promotes no customer,
-- completes nothing and closes no conversation. Every one of those is an EXPLICIT R46 non-goal, and NOTHING in this
-- ledger performs them. It records that a human operator has claimed a coordinated conversation — the fact a future,
-- explicitly-authorised operator capability (a queue, a dashboard) reads to know who owns what. It records ownership;
-- it carries nothing out.
--
-- IT PREVENTS CONFLICTING ACTIVE CLAIMS — BY CONSTRUCTION. `coordination_id` is UNIQUE: at most ONE active claim per
-- coordinated item. The write primitive inserts ON CONFLICT (coordination_id) DO NOTHING; on a repeat it resolves the
-- EXISTING claim's operator and returns the existing id ONLY when the SAME operator re-claims (idempotent), and NULL
-- when a DIFFERENT operator attempts to claim an already-owned item (the conflict is refused; nothing is written).
-- This is the storage-layer guarantee behind R46's required behaviour "prevent conflicting active claims" — two
-- operators can never both hold the same item.
--
-- THE COORDINATION ENGINE REMAINS AUTHORITATIVE — AND ORGANISATION ISOLATION IS ENFORCED HERE. The write primitive
-- refuses to file a claim unless the named `coordination_id` names a REAL row in the R36
-- `receptionist_conversation_coordinations` ledger THAT BELONGS TO THE CLAIMING ORGANISATION (`org_id`). A claim can
-- therefore be filed ONLY against a coordination the operator's organisation actually owns: a cross-tenant claim
-- (org B claiming org A's coordination) names no coordination in org B and is refused, structurally. The coordinations
-- ledger stays the single source of truth for a recorded coordination; this ledger records ownership of one, threaded
-- to it by a DENORMALISED, un-FK'd `coordination_id` (the append-only rule: a claim must outlive the rows it
-- describes, so no `on delete cascade` can ever erase claim history).
--
-- THE FOLD IS ENFORCED BY THE DATABASE — the claim is DETERMINISTIC by construction. A CHECK pins
-- (`claim_type`, `claim_outcome`) to the exact fold (claim_conversation_work ⇒ work_claimed) and `status` to
-- 'claimed'. No writer — not even service_role with a direct insert — can file a claim whose outcome contradicts its
-- type, or whose status claims anything but held.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. A claim is a fact about one operator taking ownership of one coordinated
-- conversation once. It gets a first-class, append-only home — not a mutable status column — so a claim can never be
-- silently rewritten or erased: the audit of who claimed what, and when, is preserved in full. This ledger is DISTINCT
-- from R14's conversation-grain assignee (`receptionist_conversations.assignee_id`): R46 claims at the COORDINATION
-- grain (`coordination_id`), a different key entirely, so the two never collide.
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the
-- `receptionist_conversation_coordinations` ledger:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER primitive are the only path in;
--     every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role.
--   • A single validated SECURITY DEFINER write entry point, with EXECUTE revoked from PUBLIC / anon / authenticated
--     and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + one function + triggers. No tenant table is touched, no existing column
-- is altered, and no producer is wired by this migration (the server runtime wires the store in TypeScript).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_claims — one append-only record per operator CLAIM of a coordinated conversation.
--    RLS:hq. Captures WHAT was claimed (`claim_type` + `claim_outcome`), WHO claimed it (`operator_id` +
--    denormalised `operator_email`), WHEN (`claimed_at`), its `status`, and the anchors that thread it to the
--    organisation, the coordination it is filed against (`coordination_id`, NOT NULL, UNIQUE — the conflict key), the
--    conversation and the correlation trace.
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_claims (
  id             uuid        primary key default gen_random_uuid(),
  -- WHERE — the organisation the claim is scoped to. NOT NULL: a claim is ALWAYS org-scoped (isolation is structural).
  org_id         uuid        not null,
  -- THE COORDINATION THIS CLAIM IS FILED AGAINST — the R36 `receptionist_conversation_coordinations` row, a soft
  -- (un-FK'd) reference. NOT NULL: a claim is ALWAYS filed against a specific recorded coordination. UNIQUE: at most
  -- one active claim per coordination (the conflict key). This is R46's load-bearing anchor — the storage proof that
  -- "the Coordination Engine remains authoritative" and that "conflicting active claims are prevented".
  coordination_id uuid       not null,
  -- Provenance for cross-reference — the conversation the coordination concerns and the end-to-end trace. Denormalised,
  -- un-FK'd, nullable (best-effort threading; the coordination is the load-bearing anchor).
  conversation_id uuid,
  correlation_id uuid,
  -- WHO claimed it — the authenticated operator's stable id (un-FK'd: the claim outlives the user row), plus the
  -- operator's email as DENORMALISED attribution (so an HQ operator without a tenant-membership row is still
  -- attributable in the audit). `operator_id` is NOT NULL: a claim ALWAYS records who took it. `operator_email` is
  -- nullable (best-effort attribution; the id is the load-bearing identity).
  operator_id    uuid        not null,
  operator_email text,
  -- WHAT was claimed.
  claim_type     text        not null
                             check (claim_type in ('claim_conversation_work')),
  -- The RECORDED result of taking the claim — CHECK-pinned to the closed set; folded from the claim type below.
  claim_outcome  text        not null
                             check (claim_outcome in ('work_claimed')),
  -- HELD BY CONSTRUCTION: a claim is TAKEN, and the row records exactly that. Pinned to the single value 'claimed' so
  -- the ledger can never claim a released, reassigned or completed state (all explicit non-goals for a later
  -- increment).
  status         text        not null default 'claimed'
                             check (status = 'claimed'),
  -- Claim metadata — reserved for future provenance; always an object.
  metadata       jsonb       not null default '{}',
  -- WHEN the operator took the claim, and when the row was written. Both default to now(); kept distinct so a future
  -- increment can record a claim taken at a time other than its insert.
  claimed_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  -- CONFLICT PREVENTION — at most one active claim per coordination. Combined with the primitive's ON CONFLICT DO
  -- NOTHING, a coordinated item is owned by AT MOST ONE operator.
  constraint receptionist_conversation_claims_coordination_unique unique (coordination_id),
  -- THE FOLD, ENFORCED. (`claim_type`, `claim_outcome`) is the exact fold: claim_conversation_work ⇒ work_claimed. No
  -- row can contradict its own type, so the recorded result is deterministic.
  constraint receptionist_conversation_claims_outcome_fold check (
    claim_type = 'claim_conversation_work' and claim_outcome = 'work_claimed'
  )
);

create index if not exists receptionist_conversation_claims_org_created_idx
  on public.receptionist_conversation_claims (org_id, created_at desc);
-- WHO owns what — every claim an operator holds, most recent first.
create index if not exists receptionist_conversation_claims_operator_idx
  on public.receptionist_conversation_claims (operator_id, created_at desc);
create index if not exists receptionist_conversation_claims_conversation_idx
  on public.receptionist_conversation_claims (conversation_id)
  where conversation_id is not null;
create index if not exists receptionist_conversation_claims_correlation_idx
  on public.receptionist_conversation_claims (correlation_id)
  where correlation_id is not null;

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER primitive are the only paths in;
-- every JWT client (anon / authenticated) is denied because an RLS-enabled table with no policies defaults to deny.
alter table public.receptionist_conversation_claims enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a claim is a fact about one taking of ownership, never updated or deleted. Reject
--    UPDATE/DELETE even under service_role. Mirrors the R36 coordinations append-only guard. This is what preserves
--    the claim AUDIT: the history of who claimed what can never be silently rewritten or erased.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_claims_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_claims is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_claims_no_update
  on public.receptionist_conversation_claims;
create trigger receptionist_conversation_claims_no_update
  before update on public.receptionist_conversation_claims
  for each row execute function public.receptionist_conversation_claims_block_mutation();

drop trigger if exists receptionist_conversation_claims_no_delete
  on public.receptionist_conversation_claims;
create trigger receptionist_conversation_claims_no_delete
  before delete on public.receptionist_conversation_claims
  for each row execute function public.receptionist_conversation_claims_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_claim — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND ONLY this
--    to record a claim; the write is BEST-EFFORT there (a failure is logged and swallowed), but the primitive itself
--    validates strictly: the claim type and outcome must be in their vocabularies, the org / coordination / operator
--    must be present, the named coordination MUST exist in the claiming organisation (the coordination-authority AND
--    organisation-isolation gate), and the fold CHECK guarantees (type, outcome) match. CONFLICT-GUARDED: ON CONFLICT
--    (coordination_id) DO NOTHING — a repeat by the SAME operator returns the existing id (idempotent), a repeat by a
--    DIFFERENT operator returns NULL (the conflict is refused). Returns the claim id, or NULL on conflict.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_claim(
  p_org_id          uuid,
  p_coordination_id uuid,
  p_operator_id     uuid,
  p_claim_type      text,
  p_claim_outcome   text,
  p_operator_email  text    default null,
  p_conversation_id uuid    default null,
  p_correlation_id  uuid    default null,
  p_metadata        jsonb   default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_existing_operator uuid;
begin
  if p_claim_type not in ('claim_conversation_work') then
    raise exception 'receptionist claim type must be one of claim_conversation_work, got %', p_claim_type
      using errcode = 'check_violation';
  end if;

  if p_claim_outcome not in ('work_claimed') then
    raise exception 'receptionist claim outcome must be one of work_claimed, got %', p_claim_outcome
      using errcode = 'check_violation';
  end if;

  -- The (type, outcome) MUST be the fold. Belt-and-braces with the table CHECK: a precise error for a mismatch.
  if not (p_claim_type = 'claim_conversation_work' and p_claim_outcome = 'work_claimed') then
    raise exception 'receptionist claim (type=%, outcome=%) does not match the deterministic fold',
      p_claim_type, p_claim_outcome
      using errcode = 'check_violation';
  end if;

  -- The organisation, coordination and operator are MANDATORY — a claim is always org-scoped, always filed against a
  -- specific coordination, and always records who took it.
  if p_org_id is null or p_coordination_id is null or p_operator_id is null then
    raise exception 'receptionist claim requires org_id, coordination_id and operator_id'
      using errcode = 'check_violation';
  end if;

  -- COORDINATION AUTHORITY + ORGANISATION ISOLATION, AT THE STORAGE LAYER. A claim can be filed ONLY against a REAL
  -- coordination in the CLAIMING organisation. The Coordination Engine stays authoritative over what a coordination
  -- is; this primitive refuses to record ownership of anything that is not a recorded coordination the org owns. A
  -- cross-tenant claim (org B naming org A's coordination) names no coordination in org B and is refused here —
  -- organisation isolation is structural, not a matter of discipline.
  if not exists (
    select 1
    from public.receptionist_conversation_coordinations c
    where c.id = p_coordination_id
      and c.org_id = p_org_id
  ) then
    raise exception 'receptionist claim names no coordination in this organisation (coordination_id=%, org_id=%)',
      p_coordination_id, p_org_id
      using errcode = 'check_violation';
  end if;

  -- CONFLICT-GUARDED INSERT — at most one active claim per coordination. A repeat performs nothing.
  insert into public.receptionist_conversation_claims (
    org_id, coordination_id, conversation_id, correlation_id, operator_id, operator_email,
    claim_type, claim_outcome, metadata
  ) values (
    p_org_id, p_coordination_id, p_conversation_id, p_correlation_id, p_operator_id, p_operator_email,
    p_claim_type, p_claim_outcome, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (coordination_id) do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row when the coordination was already claimed. Resolve the existing claim's
  -- operator: if it is the SAME operator, this is an idempotent re-claim — return the existing id. If it is a
  -- DIFFERENT operator, the item is already owned — return NULL, refusing the conflict WITHOUT writing anything. This
  -- is the conflict-prevention idiom: same operator ⇒ idempotent; different operator ⇒ refused.
  if v_id is null then
    select id, operator_id into v_id, v_existing_operator
      from public.receptionist_conversation_claims
      where coordination_id = p_coordination_id;
    if v_existing_operator is distinct from p_operator_id then
      return null;
    end if;
  end if;

  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_claim(
  uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_claim(
  uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb
) to service_role;
