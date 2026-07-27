-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation WORK REASSIGNMENT ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R52:
--  CONVERSATION WORK REASSIGNMENT).
--
-- R46 recorded the FIRST operator write — a CLAIM, an operator taking OWNERSHIP of one coordinated Conversation Worklist
-- item — into the append-only `receptionist_conversation_claims` ledger. R50 recorded its RELEASE — an owner stepping
-- back, returning the item to the unclaimed pool — into the append-only `receptionist_conversation_claim_releases`
-- ledger. R51 made the Ownership State Engine the single authority over ownership STATE folded from those two ledgers.
-- Ownership, until now, has moved in only two directions: an operator could TAKE an item (R46) or PUT IT BACK (R50), but
-- never HAND IT TO ANOTHER OPERATOR. R52 is that third door — the FIRST governed TRANSFER: it records that the operator
-- who currently HOLDS a coordinated item has REASSIGNED it to a DIFFERENT operator, who now holds it. This migration is
-- that transfer's durable, append-only, OWNERSHIP-GUARDED home. Conversation-work reassignment is the FIRST (and only
-- R52) reassignment type; the record captures WHAT was transferred (`reassignment_type` + `reassignment_outcome`), WHO
-- gave it up (`from_operator_id` + denormalised `from_operator_email`), WHO received it (`to_operator_id` +
-- `to_operator_email`), WHEN (`reassigned_at`), its `status`, and the anchors that thread it to the coordination it is
-- filed against (`coordination_id`), to the claim it transfers (`claim_id`, a soft reference to the R46 claim row), to
-- the conversation (`conversation_id`) and to the end-to-end trace (`correlation_id`).
--
-- IT TRANSFERS OWNERSHIP — IT NEVER EXECUTES WORK, AND IT MOVES WORK TO NO SYSTEM. A reassignment row is a statement that
-- ONE human operator handed a coordinated item to ANOTHER human operator: it dispatches nothing, notifies no one,
-- schedules nothing, fulfils nothing, promotes no customer, completes nothing, closes no conversation, and — crucially —
-- assigns nothing AUTOMATICALLY (a reassignment is always operator-to-named-operator, never a queue picking a worker).
-- Every one of those is an EXPLICIT R52 non-goal, and NOTHING in this ledger performs them. It records that ownership
-- passed from one operator to another — the fact a future, explicitly-authorised operator capability reads to know who
-- now owns what. It records a transfer; it carries nothing out.
--
-- IT PREVENTS INVALID TRANSFERS — BY CONSTRUCTION AND BY GUARD. `request_id` is UNIQUE: the write primitive inserts ON
-- CONFLICT (request_id) DO NOTHING, so a repeat of the SAME transfer request is idempotent (the existing reassignment id
-- is returned, no second row). `coordination_id` is DELIBERATELY NOT UNIQUE: a coordinated item can be reassigned more
-- than once (A→B→C is a chain of transfers, each a first-class append-only row), so the full ownership history is
-- preserved and never overwritten. Crucially, BEFORE it writes, the primitive proves the reassigning operator ACTUALLY
-- HOLDS the item: it resolves the item's CURRENT owner — the latest reassignment's new owner, or, if the item has never
-- been reassigned, the original R46 claimant — and refuses (writing nothing, returning NULL) when there is no claim to
-- transfer, when the item has been released (it has no current owner), or when the `from` operator is NOT the current
-- owner. "You can only reassign what you hold" is enforced where ownership is visible — the claim + release +
-- reassignment ledgers — never on trust. A CHECK also forbids a self-transfer (`from_operator_id <> to_operator_id`): a
-- reassignment always moves the item to a DIFFERENT operator.
--
-- THE CLAIM ENGINE, THE RELEASE ENGINE AND THE OWNERSHIP STATE ENGINE ALL REMAIN AUTHORITATIVE — AND ORGANISATION
-- ISOLATION IS ENFORCED HERE. The write primitive refuses to file a reassignment unless the named `coordination_id`
-- names a REAL row in the R36 `receptionist_conversation_coordinations` ledger THAT BELONGS TO THE REASSIGNING
-- ORGANISATION (`org_id`), AND unless that coordination carries an active claim in that organisation currently held by
-- the `from` operator. A reassignment can therefore be filed ONLY against an item the operator's organisation actually
-- owns and the operator actually holds: a cross-tenant reassignment (org B naming org A's coordination) names no
-- coordination in org B and is refused, structurally. The claim ledger stays the single source of truth for who ORIGINALLY
-- claimed; this ledger records the ONWARD transfers, threaded to the claim by a DENORMALISED, un-FK'd `coordination_id`
-- and `claim_id` (the append-only rule: a reassignment must outlive the rows it describes, so no `on delete cascade` can
-- ever erase transfer history). This migration ADDS NO STATE to the R51 ownership lifecycle — a reassigned item is still
-- `claimed` (it has a claim and no release); reassignment changes WHO holds it, not WHETHER it is held.
--
-- THE FOLD IS ENFORCED BY THE DATABASE — the reassignment is DETERMINISTIC by construction. A CHECK pins
-- (`reassignment_type`, `reassignment_outcome`) to the exact fold (reassign_conversation_work ⇒ work_reassigned) and
-- `status` to 'reassigned'. No writer — not even service_role with a direct insert — can file a reassignment whose
-- outcome contradicts its type, or whose status claims anything but transferred.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. A reassignment is a fact about one operator handing one coordinated
-- conversation to another once. It cannot live in the R46 claim ledger (append-only, `coordination_id` UNIQUE, `status`
-- pinned to 'claimed') nor the R50 release ledger (append-only, one row per coordination, pinned to 'released'). The
-- transfer therefore gets its own first-class, append-only home — not a mutable owner column — so ownership history
-- (claimed by A, THEN reassigned to B, THEN to C) is preserved in full and can never be silently rewritten or erased.
-- Ownership is derived, not stored.
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the `receptionist_conversation_claims`
-- and `receptionist_conversation_claim_releases` ledgers:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER primitive are the only path in;
--     every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role.
--   • A single validated SECURITY DEFINER write entry point, with EXECUTE revoked from PUBLIC / anon / authenticated
--     and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + one new function + triggers, PLUS a create-or-replace of the R50 release
-- writer that upgrades its OWNERSHIP gate to resolve the CURRENT (possibly-reassigned) owner. No tenant table is touched,
-- no existing column is altered, the R46 claim ledger and R50 release ledger are UNCHANGED in shape, and no producer is
-- wired by this migration (the server runtime wires the store in TypeScript). For an item that was never reassigned, the
-- upgraded release writer behaves EXACTLY as before (the current owner IS the original claimant).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_claim_reassignments — one append-only record per operator-to-operator TRANSFER of a
--    coordinated conversation. RLS:hq. Captures WHAT was transferred (`reassignment_type` + `reassignment_outcome`), WHO
--    gave it up (`from_operator_id` + denormalised `from_operator_email`), WHO received it (`to_operator_id` +
--    `to_operator_email`), WHEN (`reassigned_at`), its `status`, and the anchors that thread it to the organisation, the
--    coordination it is filed against (`coordination_id`, NOT NULL, NOT UNIQUE — a chain of transfers is allowed), the
--    claim it transfers (`claim_id`), the idempotency key (`request_id`, NOT NULL, UNIQUE — the conflict key), the
--    conversation and the correlation trace.
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_claim_reassignments (
  id             uuid        primary key default gen_random_uuid(),
  -- WHERE — the organisation the reassignment is scoped to. NOT NULL: a reassignment is ALWAYS org-scoped (isolation is
  -- structural).
  org_id         uuid        not null,
  -- THE COORDINATION THIS REASSIGNMENT IS FILED AGAINST — the R36 `receptionist_conversation_coordinations` row, a soft
  -- (un-FK'd) reference. NOT NULL: a reassignment is ALWAYS filed against a specific recorded coordination. DELIBERATELY
  -- NOT UNIQUE: a coordinated item can be reassigned repeatedly (A→B→C), and each transfer is a first-class append-only
  -- row — so the full ownership history is preserved, never overwritten.
  coordination_id uuid       not null,
  -- THE CLAIM THIS REASSIGNMENT TRANSFERS — a soft (un-FK'd) reference to the R46 `receptionist_conversation_claims` row
  -- whose ownership is being handed on. Threads the transfer to the exact claim it moves, for a complete ownership audit.
  -- NOT NULL: a reassignment always transfers a specific recorded claim (the primitive resolves it before writing).
  claim_id       uuid        not null,
  -- THE IDEMPOTENCY KEY — a caller-supplied (or primitive-generated) request id that makes a retried transfer a no-op.
  -- NOT NULL, UNIQUE: the conflict key. The primitive inserts ON CONFLICT (request_id) DO NOTHING, so replaying the SAME
  -- request returns the existing reassignment id and writes no second row — even after the current owner has moved on.
  request_id     uuid        not null,
  -- Provenance for cross-reference — the conversation the coordination concerns and the end-to-end trace. Denormalised,
  -- un-FK'd, nullable (best-effort threading; the coordination is the load-bearing anchor).
  conversation_id uuid,
  correlation_id uuid,
  -- WHO GAVE IT UP — the PREVIOUS owner: the authenticated operator's stable id (un-FK'd: the transfer outlives the user
  -- row), plus the operator's email as DENORMALISED attribution. `from_operator_id` is NOT NULL: a reassignment ALWAYS
  -- records who it came from. `from_operator_email` is nullable (best-effort attribution; the id is load-bearing).
  from_operator_id    uuid   not null,
  from_operator_email text,
  -- WHO RECEIVED IT — the NEW owner: the operator the item was handed to. `to_operator_id` is NOT NULL: a reassignment
  -- ALWAYS records who it went to. `to_operator_email` is nullable (best-effort attribution).
  to_operator_id      uuid   not null,
  to_operator_email   text,
  -- WHAT was transferred.
  reassignment_type   text   not null
                             check (reassignment_type in ('reassign_conversation_work')),
  -- The RECORDED result of transferring the claim — CHECK-pinned to the closed set; folded from the reassignment type.
  reassignment_outcome text  not null
                             check (reassignment_outcome in ('work_reassigned')),
  -- TRANSFERRED BY CONSTRUCTION: a reassignment is a HANDING-ON, and the row records exactly that. Pinned to the single
  -- value 'reassigned' so the ledger can never claim a released or completed state (explicit non-goals for a later
  -- increment).
  status         text        not null default 'reassigned'
                             check (status = 'reassigned'),
  -- Reassignment metadata — reserved for future provenance; always an object.
  metadata       jsonb       not null default '{}',
  -- WHEN the operator transferred the claim, and when the row was written. Both default to now(); kept distinct so a
  -- future increment can record a transfer taken at a time other than its insert.
  reassigned_at  timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  -- CONFLICT PREVENTION — the idempotency key is unique. Combined with the primitive's ON CONFLICT DO NOTHING, a retried
  -- transfer request records AT MOST ONCE.
  constraint receptionist_conversation_claim_reassignments_request_unique unique (request_id),
  -- A TRANSFER ALWAYS MOVES THE ITEM — the giver and receiver are DIFFERENT operators. A self-reassignment is a no-op and
  -- is forbidden by construction.
  constraint receptionist_conversation_claim_reassignments_distinct_operators check (
    from_operator_id <> to_operator_id
  ),
  -- THE FOLD, ENFORCED. (`reassignment_type`, `reassignment_outcome`) is the exact fold: reassign_conversation_work ⇒
  -- work_reassigned. No row can contradict its own type, so the recorded result is deterministic.
  constraint receptionist_conversation_claim_reassignments_outcome_fold check (
    reassignment_type = 'reassign_conversation_work' and reassignment_outcome = 'work_reassigned'
  )
);

create index if not exists receptionist_conversation_claim_reassignments_org_created_idx
  on public.receptionist_conversation_claim_reassignments (org_id, created_at desc);
-- THE CURRENT-OWNER + HISTORY lookup — every transfer filed against a coordination, most recent first. This is R52's
-- load-bearing index: the writer (and the upgraded R50 release writer) resolve the CURRENT owner by reading the latest
-- reassignment for a coordination, newest first.
create index if not exists receptionist_conversation_claim_reassignments_coordination_idx
  on public.receptionist_conversation_claim_reassignments (coordination_id, reassigned_at desc);
-- WHAT an operator HANDED OFF — every transfer an operator gave up, most recent first.
create index if not exists receptionist_conversation_claim_reassignments_from_operator_idx
  on public.receptionist_conversation_claim_reassignments (from_operator_id, created_at desc);
-- WHAT an operator RECEIVED — every transfer an operator was handed, most recent first.
create index if not exists receptionist_conversation_claim_reassignments_to_operator_idx
  on public.receptionist_conversation_claim_reassignments (to_operator_id, created_at desc);
-- The claim each transfer moves — for joining reassignment history back to the claim ledger.
create index if not exists receptionist_conversation_claim_reassignments_claim_idx
  on public.receptionist_conversation_claim_reassignments (claim_id);
create index if not exists receptionist_conversation_claim_reassignments_conversation_idx
  on public.receptionist_conversation_claim_reassignments (conversation_id)
  where conversation_id is not null;
create index if not exists receptionist_conversation_claim_reassignments_correlation_idx
  on public.receptionist_conversation_claim_reassignments (correlation_id)
  where correlation_id is not null;

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER primitive are the only paths in;
-- every JWT client (anon / authenticated) is denied because an RLS-enabled table with no policies defaults to deny.
alter table public.receptionist_conversation_claim_reassignments enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a reassignment is a fact about one handing-on of ownership, never updated or deleted. Reject
--    UPDATE/DELETE even under service_role. Mirrors the R46 claim / R50 release append-only guard. This is what preserves
--    the transfer AUDIT: the history of who reassigned what to whom can never be silently rewritten or erased.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_claim_reassignments_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_claim_reassignments is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_claim_reassignments_no_update
  on public.receptionist_conversation_claim_reassignments;
create trigger receptionist_conversation_claim_reassignments_no_update
  before update on public.receptionist_conversation_claim_reassignments
  for each row execute function public.receptionist_conversation_claim_reassignments_block_mutation();

drop trigger if exists receptionist_conversation_claim_reassignments_no_delete
  on public.receptionist_conversation_claim_reassignments;
create trigger receptionist_conversation_claim_reassignments_no_delete
  before delete on public.receptionist_conversation_claim_reassignments
  for each row execute function public.receptionist_conversation_claim_reassignments_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_claim_reassignment — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND ONLY this to
--    record a reassignment; the write is BEST-EFFORT there (a failure is logged and swallowed), but the primitive itself
--    validates strictly: the reassignment type and outcome must be in their vocabularies, the org / coordination / from
--    / to operators must be present, the from and to operators must DIFFER, the named coordination MUST exist in the
--    reassigning organisation (the coordination-authority AND organisation-isolation gate), and — the OWNERSHIP gate —
--    the `from` operator MUST be the coordination's CURRENT owner in that organisation. IDEMPOTENT: a caller-supplied
--    `request_id` short-circuits BEFORE the ownership gate (a replay of an already-recorded transfer returns its id even
--    after the current owner has moved on), and the insert is ON CONFLICT (request_id) DO NOTHING. Returns the
--    reassignment id, or NULL when there is nothing the operator may transfer (no claim, a released item, or the operator
--    is not the current owner) — the "prevent invalid transfers" refusal.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_claim_reassignment(
  p_org_id             uuid,
  p_coordination_id    uuid,
  p_from_operator_id   uuid,
  p_to_operator_id     uuid,
  p_reassignment_type  text,
  p_reassignment_outcome text,
  p_from_operator_email text  default null,
  p_to_operator_email  text   default null,
  p_conversation_id    uuid   default null,
  p_correlation_id     uuid   default null,
  p_request_id         uuid   default null,
  p_metadata           jsonb  default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_request_id uuid;
  v_claim_id uuid;
  v_claim_operator uuid;
  v_current_owner uuid;
begin
  if p_reassignment_type not in ('reassign_conversation_work') then
    raise exception 'receptionist reassignment type must be one of reassign_conversation_work, got %', p_reassignment_type
      using errcode = 'check_violation';
  end if;

  if p_reassignment_outcome not in ('work_reassigned') then
    raise exception 'receptionist reassignment outcome must be one of work_reassigned, got %', p_reassignment_outcome
      using errcode = 'check_violation';
  end if;

  -- The (type, outcome) MUST be the fold. Belt-and-braces with the table CHECK: a precise error for a mismatch.
  if not (p_reassignment_type = 'reassign_conversation_work' and p_reassignment_outcome = 'work_reassigned') then
    raise exception 'receptionist reassignment (type=%, outcome=%) does not match the deterministic fold',
      p_reassignment_type, p_reassignment_outcome
      using errcode = 'check_violation';
  end if;

  -- The organisation, coordination and BOTH operators are MANDATORY — a reassignment is always org-scoped, always filed
  -- against a specific coordination, and always records who it came from and who it went to.
  if p_org_id is null or p_coordination_id is null or p_from_operator_id is null or p_to_operator_id is null then
    raise exception 'receptionist reassignment requires org_id, coordination_id, from_operator_id and to_operator_id'
      using errcode = 'check_violation';
  end if;

  -- A TRANSFER ALWAYS MOVES THE ITEM — the giver and receiver must DIFFER. Belt-and-braces with the table CHECK.
  if p_from_operator_id = p_to_operator_id then
    raise exception 'receptionist reassignment must move the item to a DIFFERENT operator (from = to = %)', p_from_operator_id
      using errcode = 'check_violation';
  end if;

  -- COORDINATION AUTHORITY + ORGANISATION ISOLATION, AT THE STORAGE LAYER. A reassignment can be filed ONLY against a
  -- REAL coordination in the REASSIGNING organisation. The Coordination Engine stays authoritative over what a
  -- coordination is; this primitive refuses to record the transfer of anything that is not a recorded coordination the
  -- org owns. A cross-tenant reassignment (org B naming org A's coordination) names no coordination in org B and is
  -- refused here — organisation isolation is structural, not a matter of discipline.
  if not exists (
    select 1
    from public.receptionist_conversation_coordinations c
    where c.id = p_coordination_id
      and c.org_id = p_org_id
  ) then
    raise exception 'receptionist reassignment names no coordination in this organisation (coordination_id=%, org_id=%)',
      p_coordination_id, p_org_id
      using errcode = 'check_violation';
  end if;

  -- IDEMPOTENT REPLAY — resolve the request id (the caller-supplied idempotency key, or a fresh one when none is given)
  -- and, if a reassignment already carries it in this organisation, return that id BEFORE the ownership gate. A replay of
  -- A→B AFTER A→B has landed no longer has A as the current owner, so the ownership gate below would wrongly refuse it;
  -- the request-id short-circuit makes the retried transfer idempotent regardless of who now holds the item.
  v_request_id := coalesce(p_request_id, gen_random_uuid());
  select id into v_id
    from public.receptionist_conversation_claim_reassignments
    where request_id = v_request_id
      and org_id = p_org_id;
  if v_id is not null then
    return v_id;
  end if;

  -- OWNERSHIP GATE — "you can only reassign what you hold". Resolve the coordination's active claim from the R46 ledger
  -- (at most one, since `coordination_id` is UNIQUE there). Refuse — writing NOTHING, returning NULL — when there is no
  -- claim to transfer.
  select id, operator_id into v_claim_id, v_claim_operator
    from public.receptionist_conversation_claims
    where coordination_id = p_coordination_id
      and org_id = p_org_id;

  if v_claim_id is null then
    return null; -- nothing to reassign: the item carries no claim in this organisation
  end if;

  -- A RELEASED item has NO current owner — it must be re-claimed before it can be reassigned. Refuse (NULL, no write).
  if exists (
    select 1
    from public.receptionist_conversation_claim_releases
    where coordination_id = p_coordination_id
      and org_id = p_org_id
  ) then
    return null;
  end if;

  -- THE CURRENT OWNER is the latest reassignment's new owner (this coordination's most recent transfer), or — if the item
  -- has never been reassigned — the original R46 claimant. Org-scoped, so one org can never resolve another's owner.
  select to_operator_id into v_current_owner
    from public.receptionist_conversation_claim_reassignments
    where coordination_id = p_coordination_id
      and org_id = p_org_id
    order by reassigned_at desc, created_at desc, id desc
    limit 1;
  v_current_owner := coalesce(v_current_owner, v_claim_operator);

  -- The reassigning (`from`) operator MUST be the current owner. A stale or non-owner `from` is refused (NULL, no write).
  if v_current_owner is distinct from p_from_operator_id then
    return null;
  end if;

  -- CONFLICT-GUARDED INSERT — idempotent on the request id. The `from` operator has been proven to hold the item above.
  insert into public.receptionist_conversation_claim_reassignments (
    org_id, coordination_id, claim_id, request_id, conversation_id, correlation_id,
    from_operator_id, from_operator_email, to_operator_id, to_operator_email,
    reassignment_type, reassignment_outcome, metadata
  ) values (
    p_org_id, p_coordination_id, v_claim_id, v_request_id, p_conversation_id, p_correlation_id,
    p_from_operator_id, p_from_operator_email, p_to_operator_id, p_to_operator_email,
    p_reassignment_type, p_reassignment_outcome, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (request_id) do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row when a concurrent call with the same request id won the race. Resolve and
  -- return the EXISTING reassignment id (org-scoped) so the caller sees the idempotent success.
  if v_id is null then
    select id into v_id
      from public.receptionist_conversation_claim_reassignments
      where request_id = v_request_id
        and org_id = p_org_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_claim_reassignment(
  uuid, uuid, uuid, uuid, text, text, text, text, uuid, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_claim_reassignment(
  uuid, uuid, uuid, uuid, text, text, text, text, uuid, uuid, uuid, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. record_receptionist_conversation_claim_release — UPGRADED (create-or-replace). R50 defined this writer with an
--    ownership gate that read the ORIGINAL claimant directly (`v_claim_operator`), because before R52 the claimant was
--    the only possible owner. R52 makes ownership transferable, so the release writer's ownership gate must resolve the
--    CURRENT owner — the latest reassignment's new owner, or the original claimant when the item was never reassigned —
--    and let ONLY that operator release the item. This is a PURE HARDENING of the SAME single release writer: it adds no
--    second release path, changes no signature, and for an item that was never reassigned behaves IDENTICALLY to R50 (the
--    current owner IS the claimant). The Release Runtime remains the sole authority over recording a release; only its
--    ownership resolution now respects R52 transfers. Everything else — the vocabulary, the fold, the coordination guard,
--    the conflict-guarded insert and the idempotent re-release — is exactly as R50 defined it.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_claim_release(
  p_org_id          uuid,
  p_coordination_id uuid,
  p_operator_id     uuid,
  p_release_type    text,
  p_release_outcome text,
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
  v_claim_id uuid;
  v_claim_operator uuid;
  v_current_owner uuid;
begin
  if p_release_type not in ('release_conversation_work') then
    raise exception 'receptionist release type must be one of release_conversation_work, got %', p_release_type
      using errcode = 'check_violation';
  end if;

  if p_release_outcome not in ('work_released') then
    raise exception 'receptionist release outcome must be one of work_released, got %', p_release_outcome
      using errcode = 'check_violation';
  end if;

  -- The (type, outcome) MUST be the fold. Belt-and-braces with the table CHECK: a precise error for a mismatch.
  if not (p_release_type = 'release_conversation_work' and p_release_outcome = 'work_released') then
    raise exception 'receptionist release (type=%, outcome=%) does not match the deterministic fold',
      p_release_type, p_release_outcome
      using errcode = 'check_violation';
  end if;

  -- The organisation, coordination and operator are MANDATORY — a release is always org-scoped, always filed against a
  -- specific coordination, and always records who relinquished it.
  if p_org_id is null or p_coordination_id is null or p_operator_id is null then
    raise exception 'receptionist release requires org_id, coordination_id and operator_id'
      using errcode = 'check_violation';
  end if;

  -- COORDINATION AUTHORITY + ORGANISATION ISOLATION, AT THE STORAGE LAYER. A release can be filed ONLY against a REAL
  -- coordination in the RELEASING organisation. A cross-tenant release (org B naming org A's coordination) names no
  -- coordination in org B and is refused here — organisation isolation is structural, not a matter of discipline.
  if not exists (
    select 1
    from public.receptionist_conversation_coordinations c
    where c.id = p_coordination_id
      and c.org_id = p_org_id
  ) then
    raise exception 'receptionist release names no coordination in this organisation (coordination_id=%, org_id=%)',
      p_coordination_id, p_org_id
      using errcode = 'check_violation';
  end if;

  -- OWNERSHIP GATE — "you can only release what you hold". Resolve the coordination's active claim from the R46 ledger
  -- (at most one, since `coordination_id` is UNIQUE there). Refuse — writing NOTHING, returning NULL — when there is no
  -- claim to release.
  select id, operator_id into v_claim_id, v_claim_operator
    from public.receptionist_conversation_claims
    where coordination_id = p_coordination_id
      and org_id = p_org_id;

  if v_claim_id is null then
    return null; -- nothing to release: the item carries no active claim in this organisation
  end if;

  -- THE CURRENT OWNER (R52) is the latest reassignment's new owner, or — if the item was never reassigned — the original
  -- claimant. A reassigned item is releasable ONLY by the operator who currently holds it; the operator it was handed
  -- away FROM can no longer release it. For a never-reassigned item this resolves to the claimant, exactly as R50.
  select to_operator_id into v_current_owner
    from public.receptionist_conversation_claim_reassignments
    where coordination_id = p_coordination_id
      and org_id = p_org_id
    order by reassigned_at desc, created_at desc, id desc
    limit 1;
  v_current_owner := coalesce(v_current_owner, v_claim_operator);

  if v_current_owner is distinct from p_operator_id then
    return null; -- the item is held by a DIFFERENT operator: this operator may not release it
  end if;

  -- CONFLICT-GUARDED INSERT — at most one release per coordination. A repeat performs nothing. The releasing operator has
  -- been proven to be the current owner above, so a conflict here can only be this same owner re-releasing.
  insert into public.receptionist_conversation_claim_releases (
    org_id, coordination_id, claim_id, conversation_id, correlation_id, operator_id, operator_email,
    release_type, release_outcome, metadata
  ) values (
    p_org_id, p_coordination_id, v_claim_id, p_conversation_id, p_correlation_id, p_operator_id, p_operator_email,
    p_release_type, p_release_outcome, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (coordination_id) do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row when the coordination was already released. This is an idempotent re-release by
  -- the same owner (ownership was proven above) — return the EXISTING release id so the caller sees success without
  -- writing a second row.
  if v_id is null then
    select id into v_id
      from public.receptionist_conversation_claim_releases
      where coordination_id = p_coordination_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_claim_release(
  uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_claim_release(
  uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb
) to service_role;
