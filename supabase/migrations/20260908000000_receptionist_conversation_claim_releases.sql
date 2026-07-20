-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation WORK RELEASE ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R50:
--  CONVERSATION WORK RELEASE).
--
-- R46 recorded the first operator WRITE — a CLAIM, an operator taking OWNERSHIP of one coordinated Conversation
-- Worklist item — into the append-only, conflict-guarded `receptionist_conversation_claims` ledger. Ownership has been
-- a ONE-WAY door ever since: an operator could take an item but never put it back. R50 is that door's other side — the
-- FIRST governed RELINQUISH: it records that an operator has RELEASED their ownership of a coordinated item, returning
-- it to the unclaimed state. This migration is that release's durable, append-only, OWNERSHIP-GUARDED home.
-- Conversation-work release is the FIRST (and only R50) release type; the record captures WHAT was released
-- (`release_type` + `release_outcome`), WHO released it (`operator_id` + denormalised `operator_email`), WHEN
-- (`released_at`), its `status`, and the anchors that thread it to the coordination it is filed against
-- (`coordination_id`, NOT NULL and UNIQUE — R50's load-bearing anchor AND conflict key), to the claim it relinquishes
-- (`claim_id`, a soft reference to the R46 claim row), to the conversation (`conversation_id`) and to the end-to-end
-- trace (`correlation_id`).
--
-- IT RELINQUISHES OWNERSHIP — IT NEVER EXECUTES WORK, AND IT MOVES WORK TO NO ONE. A release row is a statement that an
-- owner STEPPED BACK: it reassigns nothing, assigns nothing automatically, dispatches nothing, notifies no one,
-- schedules nothing, fulfils nothing, promotes no customer, completes nothing and closes no conversation. Every one of
-- those is an EXPLICIT R50 non-goal, and NOTHING in this ledger performs them. It records that a human operator has let
-- go of a coordinated conversation — the fact the R48 Ownership Read Model reads to return the item to the unclaimed
-- state. It records a relinquish; it carries nothing out and hands the work to no other operator.
--
-- IT PREVENTS INVALID RELEASES — BY CONSTRUCTION AND BY GUARD. `coordination_id` is UNIQUE: at most ONE release per
-- coordinated item. The write primitive inserts ON CONFLICT (coordination_id) DO NOTHING, so a repeat by the owner is
-- idempotent (the item is already unclaimed; the existing release id is returned). Crucially, BEFORE it writes, the
-- primitive proves the releasing operator ACTUALLY OWNS the item: it resolves the item's active claim from the R46
-- ledger and refuses (writing nothing, returning NULL) when there is no claim to release, or when the claim is held by
-- a DIFFERENT operator. "You can only release what you hold" is enforced where ownership is visible — the claim ledger —
-- never on trust. This is the storage-layer guarantee behind R50's required behaviour "prevent invalid releases".
--
-- THE CLAIM ENGINE REMAINS AUTHORITATIVE — AND ORGANISATION ISOLATION IS ENFORCED HERE. The write primitive refuses to
-- file a release unless the named `coordination_id` names a REAL row in the R36
-- `receptionist_conversation_coordinations` ledger THAT BELONGS TO THE RELEASING ORGANISATION (`org_id`), AND unless
-- that coordination carries an active claim in that organisation held by the releasing operator. A release can
-- therefore be filed ONLY against an item the operator's organisation actually owns and the operator actually holds: a
-- cross-tenant release (org B releasing org A's coordination) names no coordination in org B and is refused,
-- structurally. The claim ledger stays the single source of truth for who owns what; this ledger records the
-- relinquishing of one, threaded to it by a DENORMALISED, un-FK'd `coordination_id` and `claim_id` (the append-only
-- rule: a release must outlive the rows it describes, so no `on delete cascade` can ever erase release history).
--
-- THE FOLD IS ENFORCED BY THE DATABASE — the release is DETERMINISTIC by construction. A CHECK pins
-- (`release_type`, `release_outcome`) to the exact fold (release_conversation_work ⇒ work_released) and `status` to
-- 'released'. No writer — not even service_role with a direct insert — can file a release whose outcome contradicts its
-- type, or whose status claims anything but relinquished.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. A release is a fact about one operator relinquishing one coordinated
-- conversation once. It cannot live in the R46 claim ledger: that ledger is append-only, its `coordination_id` is
-- UNIQUE and its `status` is CHECK-pinned to 'claimed', so a claim can never be rewritten to 'released'. The release
-- therefore gets its own first-class, append-only home — not a mutable status column — so ownership history (claimed
-- THEN released) is preserved in full and can never be silently rewritten or erased. Ownership is derived, not stored:
-- the R48 read model reads BOTH ledgers and a coordination is owned when it has a claim AND no release.
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the
-- `receptionist_conversation_claims` ledger:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER primitive are the only path in;
--     every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role.
--   • A single validated SECURITY DEFINER write entry point, with EXECUTE revoked from PUBLIC / anon / authenticated
--     and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + one function + triggers. No tenant table is touched, no existing column
-- is altered, the R46 claim ledger is UNCHANGED, and no producer is wired by this migration (the server runtime wires
-- the store in TypeScript).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_claim_releases — one append-only record per operator RELEASE of a coordinated
--    conversation. RLS:hq. Captures WHAT was released (`release_type` + `release_outcome`), WHO released it
--    (`operator_id` + denormalised `operator_email`), WHEN (`released_at`), its `status`, and the anchors that thread
--    it to the organisation, the coordination it is filed against (`coordination_id`, NOT NULL, UNIQUE — the conflict
--    key), the claim it relinquishes (`claim_id`), the conversation and the correlation trace.
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_claim_releases (
  id             uuid        primary key default gen_random_uuid(),
  -- WHERE — the organisation the release is scoped to. NOT NULL: a release is ALWAYS org-scoped (isolation is
  -- structural).
  org_id         uuid        not null,
  -- THE COORDINATION THIS RELEASE IS FILED AGAINST — the R36 `receptionist_conversation_coordinations` row, a soft
  -- (un-FK'd) reference. NOT NULL: a release is ALWAYS filed against a specific recorded coordination. UNIQUE: at most
  -- one release per coordination (the conflict key). This is R50's load-bearing anchor — the storage proof that
  -- "invalid releases are prevented" (a repeat is idempotent) and that ownership returns to unclaimed exactly once.
  coordination_id uuid       not null,
  -- THE CLAIM THIS RELEASE RELINQUISHES — a soft (un-FK'd) reference to the R46 `receptionist_conversation_claims` row
  -- the release lets go of. Threads the release to the exact claim it undoes, for a complete ownership audit. NOT NULL:
  -- a release always relinquishes a specific recorded claim (the primitive resolves it before writing).
  claim_id       uuid        not null,
  -- Provenance for cross-reference — the conversation the coordination concerns and the end-to-end trace. Denormalised,
  -- un-FK'd, nullable (best-effort threading; the coordination is the load-bearing anchor).
  conversation_id uuid,
  correlation_id uuid,
  -- WHO released it — the authenticated operator's stable id (un-FK'd: the release outlives the user row), plus the
  -- operator's email as DENORMALISED attribution (so an HQ operator without a tenant-membership row is still
  -- attributable in the audit). `operator_id` is NOT NULL: a release ALWAYS records who relinquished it.
  -- `operator_email` is nullable (best-effort attribution; the id is the load-bearing identity).
  operator_id    uuid        not null,
  operator_email text,
  -- WHAT was released.
  release_type   text        not null
                             check (release_type in ('release_conversation_work')),
  -- The RECORDED result of relinquishing the claim — CHECK-pinned to the closed set; folded from the release type below.
  release_outcome text       not null
                             check (release_outcome in ('work_released')),
  -- RELINQUISHED BY CONSTRUCTION: a release is a GIVING-UP, and the row records exactly that. Pinned to the single value
  -- 'released' so the ledger can never claim a reassigned or completed state (all explicit non-goals for a later
  -- increment).
  status         text        not null default 'released'
                             check (status = 'released'),
  -- Release metadata — reserved for future provenance; always an object.
  metadata       jsonb       not null default '{}',
  -- WHEN the operator relinquished the claim, and when the row was written. Both default to now(); kept distinct so a
  -- future increment can record a release taken at a time other than its insert.
  released_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  -- CONFLICT PREVENTION — at most one release per coordination. Combined with the primitive's ON CONFLICT DO NOTHING, a
  -- coordinated item is relinquished AT MOST ONCE, and a repeat release by its owner is idempotent.
  constraint receptionist_conversation_claim_releases_coordination_unique unique (coordination_id),
  -- THE FOLD, ENFORCED. (`release_type`, `release_outcome`) is the exact fold: release_conversation_work ⇒
  -- work_released. No row can contradict its own type, so the recorded result is deterministic.
  constraint receptionist_conversation_claim_releases_outcome_fold check (
    release_type = 'release_conversation_work' and release_outcome = 'work_released'
  )
);

create index if not exists receptionist_conversation_claim_releases_org_created_idx
  on public.receptionist_conversation_claim_releases (org_id, created_at desc);
-- WHAT an operator has relinquished — every release an operator made, most recent first.
create index if not exists receptionist_conversation_claim_releases_operator_idx
  on public.receptionist_conversation_claim_releases (operator_id, created_at desc);
-- The claim each release undoes — for joining release history back to the claim ledger.
create index if not exists receptionist_conversation_claim_releases_claim_idx
  on public.receptionist_conversation_claim_releases (claim_id);
create index if not exists receptionist_conversation_claim_releases_conversation_idx
  on public.receptionist_conversation_claim_releases (conversation_id)
  where conversation_id is not null;
create index if not exists receptionist_conversation_claim_releases_correlation_idx
  on public.receptionist_conversation_claim_releases (correlation_id)
  where correlation_id is not null;

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER primitive are the only paths in;
-- every JWT client (anon / authenticated) is denied because an RLS-enabled table with no policies defaults to deny.
alter table public.receptionist_conversation_claim_releases enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a release is a fact about one relinquishing of ownership, never updated or deleted. Reject
--    UPDATE/DELETE even under service_role. Mirrors the R46 claim append-only guard. This is what preserves the release
--    AUDIT: the history of who released what can never be silently rewritten or erased.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_claim_releases_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_claim_releases is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_claim_releases_no_update
  on public.receptionist_conversation_claim_releases;
create trigger receptionist_conversation_claim_releases_no_update
  before update on public.receptionist_conversation_claim_releases
  for each row execute function public.receptionist_conversation_claim_releases_block_mutation();

drop trigger if exists receptionist_conversation_claim_releases_no_delete
  on public.receptionist_conversation_claim_releases;
create trigger receptionist_conversation_claim_releases_no_delete
  before delete on public.receptionist_conversation_claim_releases
  for each row execute function public.receptionist_conversation_claim_releases_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_claim_release — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND ONLY this
--    to record a release; the write is BEST-EFFORT there (a failure is logged and swallowed), but the primitive itself
--    validates strictly: the release type and outcome must be in their vocabularies, the org / coordination / operator
--    must be present, the named coordination MUST exist in the releasing organisation (the coordination-authority AND
--    organisation-isolation gate), and — the OWNERSHIP gate — the coordination MUST carry an active claim in that
--    organisation HELD BY THE RELEASING OPERATOR. CONFLICT-GUARDED: ON CONFLICT (coordination_id) DO NOTHING — a repeat
--    by the owner returns the existing release id (idempotent). Returns the release id, or NULL when there is nothing
--    the operator may release (no claim, or a claim held by someone else) — the "prevent invalid releases" refusal.
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
  -- coordination in the RELEASING organisation. The Coordination Engine stays authoritative over what a coordination
  -- is; this primitive refuses to record the relinquishing of anything that is not a recorded coordination the org
  -- owns. A cross-tenant release (org B naming org A's coordination) names no coordination in org B and is refused here —
  -- organisation isolation is structural, not a matter of discipline.
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
  -- claim to release, or when the claim is held by a DIFFERENT operator. This is the "prevent invalid releases" guard,
  -- enforced where ownership is visible.
  select id, operator_id into v_claim_id, v_claim_operator
    from public.receptionist_conversation_claims
    where coordination_id = p_coordination_id
      and org_id = p_org_id;

  if v_claim_id is null then
    return null; -- nothing to release: the item carries no active claim in this organisation
  end if;

  if v_claim_operator is distinct from p_operator_id then
    return null; -- the claim is held by a DIFFERENT operator: this operator may not release it
  end if;

  -- CONFLICT-GUARDED INSERT — at most one release per coordination. A repeat performs nothing. The releasing operator
  -- has been proven to own the claim above, so a conflict here can only be this same owner re-releasing.
  insert into public.receptionist_conversation_claim_releases (
    org_id, coordination_id, claim_id, conversation_id, correlation_id, operator_id, operator_email,
    release_type, release_outcome, metadata
  ) values (
    p_org_id, p_coordination_id, v_claim_id, p_conversation_id, p_correlation_id, p_operator_id, p_operator_email,
    p_release_type, p_release_outcome, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (coordination_id) do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row when the coordination was already released. This is an idempotent re-release
  -- by the same owner (ownership was proven above) — return the EXISTING release id so the caller sees success without
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
