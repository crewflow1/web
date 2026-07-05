-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation ORCHESTRATION ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R35:
--  CONVERSATION ORCHESTRATION ENGINE).
--
-- R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
-- eligibility; R29 DETERMINES whether that decided execution requires APPROVAL; R30 PERFORMS the approved internal
-- business operation (booking fulfilment) and records it; R31 VERIFIES that performed operation — reconciling the
-- decision against the record and recording an INTEGRITY verdict (consistent / missing / inconsistent); R32 DETERMINES
-- the RECOVERY that verdict warrants (none / reinstate / reconcile) and records it; R33 DETERMINES the RESOLUTION that
-- recovery implies — classifying the conversation into a TERMINAL, RECOVERABLE or UNRESOLVED completion state — and
-- records it; R34 GOVERNS the LIFECYCLE that resolution comes to rest in — closing, retaining or escalating the
-- conversation — and records it. R35 is the NEXT layer — and, in this stack, the FIFTH that does not perform: the
-- Orchestration Engine takes a GOVERNED lifecycle and ROUTES it to the platform capability that should RESPOND to the
-- conversation, recording an auditable ORCHESTRATION here. This migration is that orchestration's durable, append-only,
-- IDEMPOTENT home. Lifecycle-response orchestration is the FIRST orchestration type; the record captures WHAT
-- orchestration was performed (`orchestration_type` + `orchestration_outcome`), the ROUTE by which the conversation is
-- routed (`orchestration_route`), the TARGET capability it is routed to (`orchestration_target`), WHETHER the
-- conversation's orchestration is CONCLUDED (`concluded`), WHETHER an ACTIVE capability response is routed (`active`),
-- the SOURCE lifecycle state it routed (`lifecycle_state`), the EXPECTED booking payload (what the lifecycle concerns),
-- the grant that authorised the underlying operation (`approval_state = 'approved'`), and the anchors that thread it to
-- the lifecycle it was routed from (`lifecycle_id`, NOT NULL and UNIQUE — R35's load-bearing anchor AND idempotency
-- key), to the resolution that lifecycle was governed from (`resolution_id`), to the recovery that resolution was
-- determined from (`recovery_id`), to the authorisation that recovery traced (`authorisation_id`), to the verification
-- that recovery classified (`verification_id`), to the fulfilment the verification reconciled (`fulfilment_id`, NULL
-- when the source lifecycle is RETAINED/MISSING), to the held reply a human approved (`review_audit_id`), to the reply
-- that carried the human's approval (`sent_audit_id`), and to the human's resolution itself in the EXISTING Human Review
-- ledger (`review_resolution_id`).
--
-- IT ROUTES THE RESPONSE FOR APPROVED WORK — AND IT CANNOT ROUTE A RESPONSE FOR UNAPPROVED WORK. The `approval_state`
-- column is CHECK-pinned to the single value 'approved' (inherited transitively from R34 → R33 → R32 → R31 → R30, whose
-- lifecycle, resolution, recovery, verification and fulfilment can exist ONLY for an approved authorisation): an
-- orchestration row can exist ONLY for an operation a human GRANTED. The grant lives in the EXISTING Human Review ledger
-- (`receptionist_review_resolutions`, R14, a `sent` resolution) and is folded to 'approved' by R29's
-- `deriveAuthorisationState`; this ledger records the ORCHESTRATION of the conversation that grant set in motion,
-- threaded to the orchestration row (`review_resolution_id`) and the held reply (`review_audit_id`) so the whole chain —
-- held reply → human grant → performed booking → verified integrity → determined recovery → resolved completion →
-- governed lifecycle → orchestrated response — joins. R35's law ("route the response for approved, governed work; never
-- bypass Human Review") is made storage: a row here can NEVER represent an un-approved, un-reviewed, or autonomous
-- orchestration.
--
-- IT ROUTES WORK — IT NEVER EXECUTES WORK. Unlike R30 (whose row is a PERFORMED business operation), an orchestration
-- row is a ROUTING: it concludes nothing, recovers nothing, escalates nothing, enqueues nothing, notifies no one,
-- re-books nothing, retries nothing, schedules nothing, reaches no provider and pages no one. It records that a
-- responding capability was routed (`orchestration_outcome = 'conversation_response_orchestrated'`) and the
-- {@link orchestration_target} capability the conversation is routed to. It is the layer that turns R34's governed
-- LIFECYCLE state into an auditable, single-authority ROUTING verdict — the routing a future, explicitly-authorised
-- operational capability (a queue, a dashboard, an automation) reads to know which capability should respond to a
-- conversation. Human work queues, dashboard UI, notification sending, automatic retries and automatic scheduling are
-- EXPLICIT R35 non-goals; NOTHING in this ledger performs them.
--
-- AN ORCHESTRATION ROUTE IS A ROUTING, NOT AN ABSTENTION — A ROW IS FILED FOR ALL THREE. `orchestration_route` is
-- CHECK-pinned to the closed set (conclude / recover / escalate). An orchestration row is produced for EVERY governed
-- lifecycle: `conclude` (the lifecycle was `closed`; the operation completed correctly, so the conversation is routed to
-- conclusion — but the routing "considered and routed to conclusion" is still filed), `recover` (the lifecycle was
-- `retained`; there is a clear recovery path, so the conversation is routed to recovery handling) and `escalate` (the
-- lifecycle was `escalated`; the record is ambiguous, so the conversation is routed to human attention). Routing
-- `recover` and `escalate` is the WHOLE PURPOSE of the engine, so they are first-class routes on a filed row — never
-- silent.
--
-- THE ROUTE IS COHERENT WITH ITS ORCHESTRATION FLAGS — enforced by the database. Two CHECKs pin the coherent companions:
-- (`concluded`) = (`orchestration_route = 'conclude'`) and (`active`) = (`orchestration_route <> 'conclude'`). The
-- conversation's orchestration is concluded IFF the route is `conclude`, and an active capability response is routed IFF
-- it is NOT. These are Directive #018 R35's two distinct questions — "has the conversation's orchestration concluded?"
-- and "does an active capability response remain routed?" — made first-class, coherence-pinned columns. No writer — not
-- even service_role with a direct insert — can file an orchestration whose flags contradict the route it records.
--
-- THE TARGET IS A DETERMINISTIC TWO-STAGE FOLD OF THE LIFECYCLE — enforced by the database. Two CHECKs pin the exact
-- fold. STAGE 1 (the route fold): the SOURCE lifecycle state folds to the route — `closed` ⇒ `conclude`, `retained` ⇒
-- `recover`, `escalated` ⇒ `escalate`. STAGE 2 (the target fold): the route folds to the responding capability —
-- `conclude` ⇒ `conversation_conclusion`, `recover` ⇒ `recovery_handling`, `escalate` ⇒ `human_attention`. No writer can
-- file an orchestration whose route contradicts the lifecycle disposition it routes, or whose target contradicts its
-- route. Combined with the fulfilment-presence coherence CHECK (inherited transitively from R34/R33/R32/R31, `retained`
-- iff no `fulfilment_id`), the whole row is deterministic by construction.
--
-- THE FOLD IS ENFORCED BY THE DATABASE — the operation is DETERMINISTIC by construction. A CHECK pins
-- (`orchestration_type`, `orchestration_outcome`) to the exact fold (orchestrate_lifecycle_response ⇒
-- conversation_response_orchestrated), and `approval_state` to 'approved' and `status` to 'orchestrated'. No writer can
-- file an orchestration whose outcome contradicts its type, whose approval is anything but granted, or whose status
-- claims anything but orchestrated.
--
-- IT IS IDEMPOTENT BY CONSTRUCTION — a governed lifecycle's response is orchestrated AT MOST ONCE. `lifecycle_id` is
-- UNIQUE: one orchestration per lifecycle. The write primitive inserts ON CONFLICT (lifecycle_id) DO NOTHING and returns
-- the EXISTING row's id on a repeat, so re-driving the same governed lifecycle (a retried review-send, a double-fire)
-- never materialises a second orchestration. This is the storage-layer guarantee behind R35's deterministic routing —
-- distinct from RETRY (an explicit R35 non-goal): the ledger does not re-attempt anything, it makes a repeat a no-op.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. An orchestration is a fact about one governed lifecycle routed once,
-- exactly as a lifecycle (R34), a resolution (R33), a recovery (R32), a verification (R31), a fulfilment (R30), an
-- authorisation (R29), an execution (R28), an action (R27) and an outcome (R26) are. It gets the SAME first-class,
-- append-only home — not a mutable status column — so an orchestration route can never be silently rewritten or erased.
-- The confirmation the customer received is STILL produced and audited by the UNCHANGED reply pipeline, the human's
-- GRANT is STILL recorded by the UNCHANGED Human Review architecture (R14), the operation is STILL performed and
-- recorded by the UNCHANGED R30 fulfilment ledger, it is STILL verified by the UNCHANGED R31 verification ledger, its
-- recovery is STILL determined by the UNCHANGED R32 recovery ledger, its resolution is STILL determined by the UNCHANGED
-- R33 resolution ledger, and its lifecycle is STILL governed by the UNCHANGED R34 lifecycle ledger; this ledger records
-- the ORCHESTRATION route ALONGSIDE them, threaded to the SAME `correlation_id`, so an auditor can join the orchestration
-- to the lifecycle it was routed from, the resolution that lifecycle was governed from, the recovery that resolution was
-- determined from, the verification that recovery classified, the fulfilment that verification reconciled, the
-- authorisation it traces, the reply that announced it, and the human who approved it.
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the
-- `receptionist_conversation_lifecycles` ledger:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
--     writers/readers; every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role.
--   • A single validated SECURITY DEFINER write entry point, plus a single service-role-only SECURITY DEFINER
--     ORCHESTRATION-CONTEXT READER that resolves the RECORDED lifecycle disposition behind a held reply (the R34
--     lifecycle the runtime routes into an orchestration) — both with EXECUTE revoked from PUBLIC / anon /
--     authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + two functions + triggers. No tenant table is touched, no existing
-- column is altered, and no producer is wired by this migration (the server runtime wires the store in
-- TypeScript). References to organisation / conversation / enquiry / customer / action / execution / authorisation
-- / verification / fulfilment / recovery / resolution / lifecycle / held reply / sent reply / review resolution are
-- carried as DENORMALISED, un-FK'd facts (the append-only rule: an orchestration must outlive the rows it describes,
-- so no `on delete cascade` can ever erase orchestration history).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_orchestrations — one append-only record per ORCHESTRATED response. RLS:hq. Captures WHAT
--    orchestration was performed (`orchestration_type` + `orchestration_outcome`), the ROUTE by which the conversation
--    is routed (`orchestration_route`), the TARGET capability it is routed to (`orchestration_target`), WHETHER the
--    conversation's orchestration is CONCLUDED (`concluded`), WHETHER an ACTIVE capability response is routed
--    (`active`), the SOURCE `lifecycle_state`, the EXPECTED booking payload, the grant that authorised the underlying
--    operation (`approval_state`), its `status`, and the anchors that thread it to the organisation, conversation,
--    enquiry, customer, prepared action, decided execution and — the load-bearing ones — the lifecycle it was routed
--    from (`lifecycle_id`, NOT NULL, UNIQUE), the resolution that lifecycle was governed from (`resolution_id`), the
--    recovery that resolution was determined from (`recovery_id`), the authorisation that recovery traced
--    (`authorisation_id`), the verification that recovery classified (`verification_id`), the fulfilment that
--    verification reconciled (`fulfilment_id`, NULL when retained/MISSING), the held reply a human approved
--    (`review_audit_id`), the reply that carried the approval (`sent_audit_id`) and the human's resolution
--    (`review_resolution_id`).
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_orchestrations (
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
  -- THE LIFECYCLE THIS ORCHESTRATION WAS ROUTED FROM — the R34 `receptionist_conversation_lifecycles` row, a soft
  -- (un-FK'd) reference. NOT NULL: an orchestration is ALWAYS routed from a specific recorded lifecycle disposition (R35
  -- reads R34's RECORDED disposition and routes it; there is no orchestration without a lifecycle to route). UNIQUE: one
  -- orchestration per lifecycle (the idempotency anchor). This is R35's load-bearing anchor — the storage proof that
  -- "the Lifecycle Engine remains authoritative".
  lifecycle_id   uuid        not null,
  -- THE RESOLUTION THE LIFECYCLE WAS GOVERNED FROM — the R33 `receptionist_conversation_resolutions` row, a soft
  -- (un-FK'd) reference. NOT NULL: an orchestration always traces to the specific resolution its lifecycle was governed
  -- from.
  resolution_id  uuid        not null,
  -- THE RECOVERY THE RESOLUTION WAS DETERMINED FROM — the R32 `receptionist_conversation_recoveries` row, a soft
  -- (un-FK'd) reference. NOT NULL: an orchestration always traces to the specific recovery its resolution was determined
  -- from.
  recovery_id    uuid        not null,
  -- THE AUTHORISATION THE RECOVERY TRACED — the R29 `receptionist_conversation_authorisations` row, a soft (un-FK'd)
  -- reference. NOT NULL: an orchestration always traces to the specific approved authorisation its recovery traced.
  authorisation_id uuid      not null,
  -- THE VERIFICATION THE RECOVERY CLASSIFIED — the R31 `receptionist_conversation_verifications` row, a soft (un-FK'd)
  -- reference. NOT NULL: an orchestration always traces to the specific verification its recovery classified.
  verification_id uuid       not null,
  -- THE FULFILMENT THE VERIFICATION RECONCILED — the R30 `receptionist_conversation_fulfilments` row, a soft (un-FK'd)
  -- reference. NULLABLE: it is NULL exactly when the source lifecycle is RETAINED (the operation is MISSING), and NOT
  -- NULL for a concluded or escalated orchestration — a coherence CHECK below binds the two (inherited transitively from
  -- R34/R33/R32/R31).
  fulfilment_id  uuid,
  -- THE HUMAN REVIEW CHAIN — the held reply a human approved (`review_audit_id`, the `ai_reply_audits` row the
  -- R14 inbox surfaced), the reply that CARRIED the human's approval to the customer (`sent_audit_id`, the new
  -- `ai_reply_audits` row the send produced) and the human's resolution itself (`review_resolution_id`, the
  -- `receptionist_review_resolutions` row — the grant). All NOT NULL: an orchestration is routed ONLY downstream of a
  -- human's `sent` resolution, so the full provenance always exists. This is how "never bypass Human Review" is
  -- threaded structurally.
  review_audit_id     uuid   not null,
  sent_audit_id       uuid   not null,
  review_resolution_id uuid  not null,
  -- WHAT orchestration was performed.
  orchestration_type   text  not null
                             check (orchestration_type in ('orchestrate_lifecycle_response')),
  -- The ORCHESTRATED result of running the orchestration — CHECK-pinned to the closed set; folded from the orchestration
  -- type below. This is the operation R35 performs (a responding capability was routed); the ROUTE and TARGET of that
  -- routing are `orchestration_route` + `orchestration_target`, not this.
  orchestration_outcome text not null
                             check (orchestration_outcome in ('conversation_response_orchestrated')),
  -- THE ORCHESTRATION ROUTE — CHECK-pinned to the closed set. The "verb" by which the conversation is routed to the
  -- capability that should respond: `conclude` (from a `closed` lifecycle), `recover` (from a `retained` lifecycle),
  -- `escalate` (from an `escalated` lifecycle). This is the operative disposition future operational capabilities read
  -- to know how a conversation is routed. R35 records the route; it carries none of it out.
  orchestration_route  text  not null
                             check (orchestration_route in ('conclude', 'recover', 'escalate')),
  -- THE ORCHESTRATION TARGET — CHECK-pinned to the closed set. A row is filed for ALL three: `conversation_conclusion`
  -- (the lifecycle was `closed`; the conclusion capability records it complete), `recovery_handling` (the lifecycle was
  -- `retained`; a clear recovery path exists, so recovery handling should act on it), `human_attention` (the lifecycle
  -- was `escalated`; the record is ambiguous, so a human should attend to it). This is the auditable capability future
  -- operational capabilities read to determine which capability should respond to a conversation.
  orchestration_target text  not null
                             check (orchestration_target in ('conversation_conclusion', 'recovery_handling', 'human_attention')),
  -- WHETHER THE ORCHESTRATION IS CONCLUDED — the coherent companion of the route (true IFF the route is `conclude`).
  -- Bound to the route by the concluded-coherence CHECK below so it can never drift. This answers Directive #018 R35's
  -- question "has the conversation's orchestration concluded?".
  concluded      boolean     not null,
  -- WHETHER AN ACTIVE CAPABILITY RESPONSE IS ROUTED — the coherent companion of the route (true IFF the route is NOT
  -- `conclude`). Bound to the route by the active-coherence CHECK below so it can never drift. This answers Directive
  -- #018 R35's question "does an active capability response remain routed?".
  active         boolean     not null,
  -- THE SOURCE LIFECYCLE STATE — the R34 disposition this orchestration routed, CHECK-pinned to the closed set. Carried
  -- for audit + coherence: the route fold CHECK binds it to `orchestration_route`, and the fulfilment-presence coherence
  -- CHECK (inherited transitively) binds it to the presence of the fulfilment.
  lifecycle_state text       not null
                             check (lifecycle_state in ('closed', 'retained', 'escalated')),
  -- THE GRANT THAT AUTHORISED THE UNDERLYING OPERATION — CHECK-pinned to the single value 'approved', inherited
  -- transitively from R34 → R33 → R32 → R31 → R30 (a lifecycle, and therefore an orchestration routed from one, can ONLY
  -- exist for an approved authorisation). A pending, rejected or foreclosed authorisation is structurally un-routable.
  -- The grant lives in the EXISTING Human Review ledger; this column records that a grant authorised the operation this
  -- row's lifecycle concerns.
  approval_state text        not null
                             check (approval_state = 'approved'),
  -- The EXPECTED booking payload — the trade, the place and the number to ring the DECISION concerns (carried through
  -- from the R34 lifecycle decision, which carried it from R33, which carried it from R32, which carried it from R31,
  -- which carried it from R30). Each bounded in DDL to its R20 shape so the ledger can never store a malformed
  -- expectation. Nullable at the column level (future orchestration types may not carry these); the write primitive
  -- REQUIRES all three for an `orchestrate_lifecycle_response` orchestration, regardless of the route (the expectation
  -- always exists).
  job_type       text,
  postcode       text        check (postcode is null or postcode ~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'),
  phone_number   text        check (phone_number is null or phone_number ~ '^\+\d{10,15}$'),
  -- ORCHESTRATED BY CONSTRUCTION: a response is ROUTED, and the row records exactly that. Pinned to the single value
  -- 'orchestrated' so the ledger can never claim a partial, pending or executed orchestration. (Which capability should
  -- respond, and by which route, is `orchestration_target` + `orchestration_route`; a `recover` / `escalate` route is
  -- still a fully `orchestrated` response — routed, never EXECUTED.)
  status         text        not null default 'orchestrated'
                             check (status = 'orchestrated'),
  -- Orchestration metadata — the routing path, the strategy/goal it derived from, etc.
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now(),
  -- IDEMPOTENCY — one orchestration per lifecycle. Combined with the primitive's ON CONFLICT DO NOTHING, a governed
  -- lifecycle's response is orchestrated AT MOST ONCE.
  constraint receptionist_conversation_orchestrations_lifecycle_unique unique (lifecycle_id),
  -- THE FOLD, ENFORCED. (`orchestration_type`, `orchestration_outcome`) is the exact fold: orchestrate_lifecycle_response
  -- ⇒ conversation_response_orchestrated. No row can contradict its own type, so the orchestrated result is
  -- deterministic.
  constraint receptionist_conversation_orchestrations_outcome_fold check (
    orchestration_type = 'orchestrate_lifecycle_response' and orchestration_outcome = 'conversation_response_orchestrated'
  ),
  -- THE KEYSTONE — STAGE 1: ROUTE FOLD, ENFORCED. The route is the exact, deterministic fold of the SOURCE lifecycle
  -- state: `closed` ⇒ `conclude`, `retained` ⇒ `recover`, `escalated` ⇒ `escalate`. No row can contradict the lifecycle
  -- disposition it routes. This is the R35 analogue of R34's transition fold — the first half of the two-stage fold at
  -- the heart of this engine.
  constraint receptionist_conversation_orchestrations_route_fold check (
    (lifecycle_state = 'closed' and orchestration_route = 'conclude')
    or (lifecycle_state = 'retained' and orchestration_route = 'recover')
    or (lifecycle_state = 'escalated' and orchestration_route = 'escalate')
  ),
  -- THE KEYSTONE — STAGE 2: TARGET FOLD, ENFORCED. The responding capability is the exact, deterministic fold of the
  -- route: `conclude` ⇒ `conversation_conclusion`, `recover` ⇒ `recovery_handling`, `escalate` ⇒ `human_attention`. The
  -- route and the target are 1:1 by construction. No row can contradict the route it records. This is the second half of
  -- the two-stage fold — together with the route fold, the whole `lifecycle_state → route → target` chain is enforced.
  constraint receptionist_conversation_orchestrations_target_fold check (
    (orchestration_route = 'conclude' and orchestration_target = 'conversation_conclusion')
    or (orchestration_route = 'recover' and orchestration_target = 'recovery_handling')
    or (orchestration_route = 'escalate' and orchestration_target = 'human_attention')
  ),
  -- CONCLUDED COHERENCE, ENFORCED. `concluded` is TRUE IFF the route is `conclude`. The equivalence binds the flag to the
  -- route, so the ledger can never claim the orchestration is concluded over a `recover`/`escalate` route, or not
  -- concluded over a `conclude` one. This answers Directive #018 R35's question #1, made storage.
  constraint receptionist_conversation_orchestrations_concluded_coherence check (
    concluded = (orchestration_route = 'conclude')
  ),
  -- ACTIVE COHERENCE, ENFORCED. `active` is TRUE IFF the route is NOT `conclude`. The equivalence binds the flag to the
  -- route, so the ledger can never claim an active response is routed over a `conclude` route, or not routed over a
  -- `recover`/`escalate` one. This answers Directive #018 R35's question #2, made storage.
  constraint receptionist_conversation_orchestrations_active_coherence check (
    active = (orchestration_route <> 'conclude')
  ),
  -- FULFILMENT-PRESENCE COHERENCE, ENFORCED (inherited transitively from R34/R33/R32/R31). A `retained` source lifecycle
  -- means — and can ONLY mean — that no fulfilment was recorded (`fulfilment_id` NULL, the operation is MISSING); any
  -- other lifecycle state (`closed` / `escalated`) means a fulfilment WAS recorded (`fulfilment_id` NOT NULL). The
  -- equivalence binds the source state to the presence of the record, so the ledger can never claim `retained` over a
  -- present record or `closed`/`escalated` over an absent one.
  constraint receptionist_conversation_orchestrations_fulfilment_coherence check (
    (fulfilment_id is null) = (lifecycle_state = 'retained')
  )
);

create index if not exists receptionist_conversation_orchestrations_org_created_idx
  on public.receptionist_conversation_orchestrations (org_id, created_at desc);
create index if not exists receptionist_conversation_orchestrations_correlation_idx
  on public.receptionist_conversation_orchestrations (correlation_id);
create index if not exists receptionist_conversation_orchestrations_conversation_idx
  on public.receptionist_conversation_orchestrations (conversation_id)
  where conversation_id is not null;
create index if not exists receptionist_conversation_orchestrations_execution_idx
  on public.receptionist_conversation_orchestrations (execution_id)
  where execution_id is not null;
-- The JOIN back to the R34 lifecycle ledger — find the orchestration routed from a lifecycle.
create index if not exists receptionist_conversation_orchestrations_lifecycle_idx
  on public.receptionist_conversation_orchestrations (lifecycle_id);
-- The JOIN back to the R33 resolution ledger — find the orchestration for a determined resolution.
create index if not exists receptionist_conversation_orchestrations_resolution_idx
  on public.receptionist_conversation_orchestrations (resolution_id);
-- The JOIN back to the R32 recovery ledger — find the orchestration for a determined recovery.
create index if not exists receptionist_conversation_orchestrations_recovery_idx
  on public.receptionist_conversation_orchestrations (recovery_id);
-- The JOIN back to the R31 verification ledger — find the orchestration for a verified operation.
create index if not exists receptionist_conversation_orchestrations_verification_idx
  on public.receptionist_conversation_orchestrations (verification_id);
-- The JOIN back to the R30 fulfilment ledger — find the orchestration for a performed fulfilment.
create index if not exists receptionist_conversation_orchestrations_fulfilment_idx
  on public.receptionist_conversation_orchestrations (fulfilment_id)
  where fulfilment_id is not null;
-- The JOIN back to the EXISTING Human Review inbox — find the orchestration for a held reply a human resolved.
create index if not exists receptionist_conversation_orchestrations_review_audit_idx
  on public.receptionist_conversation_orchestrations (review_audit_id);
-- Orchestration analytics — how many orchestrations of each type/outcome/route/target were performed (the routing signal
-- an operator and future operational capabilities watch to find conversations routed to conclusion, recovery handling or
-- human attention).
create index if not exists receptionist_conversation_orchestrations_route_idx
  on public.receptionist_conversation_orchestrations (orchestration_type, orchestration_outcome, orchestration_route, orchestration_target, concluded, active, lifecycle_state, status, created_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
-- paths in; every JWT client (anon / authenticated) is denied because an RLS-enabled table with no policies
-- defaults to deny.
alter table public.receptionist_conversation_orchestrations enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — an orchestration is a fact about one routing, never updated or deleted. Reject
--    UPDATE/DELETE even under service_role. Mirrors the R34 lifecycles append-only guard.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_orchestrations_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_orchestrations is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_orchestrations_no_update
  on public.receptionist_conversation_orchestrations;
create trigger receptionist_conversation_orchestrations_no_update
  before update on public.receptionist_conversation_orchestrations
  for each row execute function public.receptionist_conversation_orchestrations_block_mutation();

drop trigger if exists receptionist_conversation_orchestrations_no_delete
  on public.receptionist_conversation_orchestrations;
create trigger receptionist_conversation_orchestrations_no_delete
  before delete on public.receptionist_conversation_orchestrations
  for each row execute function public.receptionist_conversation_orchestrations_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_orchestration — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND ONLY
--    this to record an orchestration route; the write is BEST-EFFORT there (a failure is logged and swallowed so a
--    durable, audited, human-approved confirmation reply is never undone by an orchestration write), but the primitive
--    itself validates strictly: the orchestration type, outcome, route, target and source lifecycle state must be in
--    their vocabularies, the approval MUST be 'approved' (the storage-layer Human Review gate, inherited from R34 → R33
--    → R32 → R31 → R30), `concluded` MUST be COHERENT with the route (true iff `conclude`), `active` MUST be COHERENT
--    with the route (true iff not `conclude`), the route MUST be the deterministic fold of the lifecycle state, the
--    target MUST be the deterministic fold of the route, the source lifecycle state MUST be COHERENT with the presence
--    of the fulfilment (`retained` iff no `fulfilment_id`, inherited transitively), an `orchestrate_lifecycle_response`
--    MUST carry the expected job type plus a well-formed postcode and E.164 number and the full lifecycle + Human Review
--    provenance, and the fold CHECK guarantees (type, outcome) match. IDEMPOTENT: ON CONFLICT (lifecycle_id) DO NOTHING
--    returns the existing orchestration's id, so a repeat routes nothing. Returns the orchestration id.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_orchestration(
  p_org_id                  uuid,
  p_lifecycle_id            uuid,
  p_resolution_id           uuid,
  p_recovery_id             uuid,
  p_authorisation_id        uuid,
  p_verification_id         uuid,
  p_orchestration_type      text,
  p_orchestration_outcome   text,
  p_orchestration_route     text,
  p_orchestration_target    text,
  p_concluded               boolean,
  p_active                  boolean,
  p_lifecycle_state         text,
  p_approval_state          text,
  p_correlation_id          uuid,
  p_review_audit_id         uuid,
  p_sent_audit_id           uuid,
  p_review_resolution_id    uuid,
  p_fulfilment_id           uuid    default null,
  p_conversation_id         uuid    default null,
  p_enquiry_id              uuid    default null,
  p_lead_id                 uuid    default null,
  p_customer_ref            text    default null,
  p_action_id               uuid    default null,
  p_execution_id            uuid    default null,
  p_job_type                text    default null,
  p_postcode                text    default null,
  p_phone_number            text    default null,
  p_metadata                jsonb   default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_orchestration_type not in ('orchestrate_lifecycle_response') then
    raise exception 'receptionist orchestration type must be one of orchestrate_lifecycle_response, got %', p_orchestration_type
      using errcode = 'check_violation';
  end if;

  if p_orchestration_outcome not in ('conversation_response_orchestrated') then
    raise exception 'receptionist orchestration outcome must be one of conversation_response_orchestrated, got %', p_orchestration_outcome
      using errcode = 'check_violation';
  end if;

  if p_orchestration_route not in ('conclude', 'recover', 'escalate') then
    raise exception 'receptionist orchestration route must be one of conclude, recover, escalate, got %', p_orchestration_route
      using errcode = 'check_violation';
  end if;

  if p_orchestration_target not in ('conversation_conclusion', 'recovery_handling', 'human_attention') then
    raise exception 'receptionist orchestration target must be one of conversation_conclusion, recovery_handling, human_attention, got %', p_orchestration_target
      using errcode = 'check_violation';
  end if;

  if p_lifecycle_state not in ('closed', 'retained', 'escalated') then
    raise exception 'receptionist orchestration lifecycle state must be one of closed, retained, escalated, got %', p_lifecycle_state
      using errcode = 'check_violation';
  end if;

  -- THE HUMAN REVIEW GATE, AT THE STORAGE LAYER (inherited from R34 → R33 → R32 → R31 → R30). An orchestration is routed
  -- ONLY for an APPROVED authorisation. The grant is the human's, recorded in the EXISTING Human Review ledger; this
  -- primitive can only ever file an orchestration whose approval is 'approved'. There is no path to routing an
  -- orchestration for un-approved work.
  if p_approval_state <> 'approved' then
    raise exception 'receptionist orchestration requires an approved authorisation (Human Review may not be bypassed), got approval_state=%', p_approval_state
      using errcode = 'check_violation';
  end if;

  -- CONCLUDED COHERENCE. `concluded` is TRUE iff the route is `conclude`. Belt-and-braces with the table CHECK: a precise
  -- error for an incoherent call.
  if p_concluded <> (p_orchestration_route = 'conclude') then
    raise exception 'receptionist orchestration concluded=% is incoherent with route=% (concluded iff route = conclude)',
      p_concluded, p_orchestration_route
      using errcode = 'check_violation';
  end if;

  -- ACTIVE COHERENCE. `active` is TRUE iff the route is NOT `conclude`. Belt-and-braces with the table CHECK: a precise
  -- error for an incoherent call.
  if p_active <> (p_orchestration_route <> 'conclude') then
    raise exception 'receptionist orchestration active=% is incoherent with route=% (active iff route <> conclude)',
      p_active, p_orchestration_route
      using errcode = 'check_violation';
  end if;

  -- THE ROUTE FOLD (stage 1). The route is the exact, deterministic fold of the source lifecycle state: closed ⇒
  -- conclude, retained ⇒ recover, escalated ⇒ escalate. Belt-and-braces with the table CHECK: a precise error for a
  -- route that contradicts the lifecycle it claims to have routed.
  if not (
    (p_lifecycle_state = 'closed' and p_orchestration_route = 'conclude')
    or (p_lifecycle_state = 'retained' and p_orchestration_route = 'recover')
    or (p_lifecycle_state = 'escalated' and p_orchestration_route = 'escalate')
  ) then
    raise exception 'receptionist orchestration route=% is not the deterministic fold of lifecycle state=%',
      p_orchestration_route, p_lifecycle_state
      using errcode = 'check_violation';
  end if;

  -- THE TARGET FOLD (stage 2). The target is the exact, deterministic fold of the route: conclude ⇒
  -- conversation_conclusion, recover ⇒ recovery_handling, escalate ⇒ human_attention. Belt-and-braces with the table
  -- CHECK: a precise error for a target that contradicts the route it records.
  if not (
    (p_orchestration_route = 'conclude' and p_orchestration_target = 'conversation_conclusion')
    or (p_orchestration_route = 'recover' and p_orchestration_target = 'recovery_handling')
    or (p_orchestration_route = 'escalate' and p_orchestration_target = 'human_attention')
  ) then
    raise exception 'receptionist orchestration target=% is not the deterministic fold of route=%',
      p_orchestration_target, p_orchestration_route
      using errcode = 'check_violation';
  end if;

  -- FULFILMENT-PRESENCE COHERENCE (inherited transitively from R34/R33/R32/R31). A `retained` source lifecycle means,
  -- and can ONLY mean, that no fulfilment was recorded (no `fulfilment_id`); any other lifecycle state means a fulfilment
  -- WAS recorded (`fulfilment_id` present). Belt-and-braces with the table CHECK: a precise error for an incoherent
  -- call.
  if (p_fulfilment_id is null) <> (p_lifecycle_state = 'retained') then
    raise exception 'receptionist orchestration lifecycle state=% is incoherent with fulfilment_id=% (retained iff no fulfilment)',
      p_lifecycle_state, coalesce(p_fulfilment_id::text, 'null')
      using errcode = 'check_violation';
  end if;

  -- The lifecycle anchor, the resolution/recovery/authorisation/verification anchors and the full Human Review
  -- provenance are MANDATORY — an orchestration is ALWAYS routed from a specific recorded lifecycle, tracing a specific
  -- resolution, recovery, authorisation and verification, downstream of a specific human `sent` resolution on a specific
  -- held reply.
  if p_lifecycle_id is null or p_resolution_id is null or p_recovery_id is null or p_authorisation_id is null or p_verification_id is null or p_review_audit_id is null or p_sent_audit_id is null or p_review_resolution_id is null then
    raise exception 'receptionist orchestration requires lifecycle_id, resolution_id, recovery_id, authorisation_id, verification_id, review_audit_id, sent_audit_id and review_resolution_id (the lifecycle + Human Review provenance)'
      using errcode = 'check_violation';
  end if;

  -- An orchestrate_lifecycle_response orchestration MUST carry the three facts that identify the EXPECTED visit — the
  -- trade, the place and the number to ring — each well-formed. This is the decision's expectation, present for every
  -- route (including `conclude`), so the orchestration record is self-describing about what the lifecycle concerns.
  if p_orchestration_type = 'orchestrate_lifecycle_response'
     and (
       p_job_type is null or length(trim(p_job_type)) = 0
       or p_postcode is null or p_postcode !~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'
       or p_phone_number is null or p_phone_number !~ '^\+\d{10,15}$'
     ) then
    raise exception 'receptionist orchestrate_lifecycle_response requires an expected job type, a well-formed postcode and a well-formed E.164 phone number, got job_type=%, postcode=%, phone=%',
      coalesce(p_job_type, 'null'), coalesce(p_postcode, 'null'), coalesce(p_phone_number, 'null')
      using errcode = 'check_violation';
  end if;

  -- The (type, outcome) MUST be the fold. Belt-and-braces with the table CHECK: a precise error for a mismatch.
  if not (p_orchestration_type = 'orchestrate_lifecycle_response' and p_orchestration_outcome = 'conversation_response_orchestrated') then
    raise exception 'receptionist orchestration (type=%, outcome=%) does not match the deterministic fold',
      p_orchestration_type, p_orchestration_outcome
      using errcode = 'check_violation';
  end if;

  -- IDEMPOTENT INSERT — one orchestration per lifecycle. A repeat routes nothing; we return the existing id.
  insert into public.receptionist_conversation_orchestrations (
    org_id, lifecycle_id, resolution_id, recovery_id, authorisation_id, verification_id, fulfilment_id, orchestration_type,
    orchestration_outcome, orchestration_route, orchestration_target, concluded, active, lifecycle_state, approval_state,
    correlation_id, review_audit_id, sent_audit_id, review_resolution_id,
    conversation_id, enquiry_id, lead_id, customer_ref, action_id, execution_id,
    job_type, postcode, phone_number, metadata
  ) values (
    p_org_id, p_lifecycle_id, p_resolution_id, p_recovery_id, p_authorisation_id, p_verification_id, p_fulfilment_id, p_orchestration_type,
    p_orchestration_outcome, p_orchestration_route, p_orchestration_target, p_concluded, p_active, p_lifecycle_state, p_approval_state,
    p_correlation_id, p_review_audit_id, p_sent_audit_id, p_review_resolution_id,
    p_conversation_id, p_enquiry_id, p_lead_id, p_customer_ref, p_action_id, p_execution_id,
    p_job_type, p_postcode, p_phone_number, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (lifecycle_id) do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row when the lifecycle's orchestration was already routed — resolve the existing
  -- orchestration's id so the caller always gets a stable id and the operation is a true no-op on repeat.
  if v_id is null then
    select id into v_id
      from public.receptionist_conversation_orchestrations
      where lifecycle_id = p_lifecycle_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_orchestration(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, boolean, boolean, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_orchestration(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, boolean, boolean, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. find_receptionist_orchestration_context — the single service-role-only SECURITY DEFINER ORCHESTRATION-CONTEXT
--    READER the runtime uses to resolve, in ONE read, the RECORDED lifecycle disposition behind a held reply a human
--    just approved: the GOVERNED `govern_resolution_lifecycle` lifecycle (from the R34
--    `receptionist_conversation_lifecycles` ledger — R34's RECORDED disposition, so the runtime can reconstruct the
--    GovernResolutionLifecycleDecision verbatim and route it through R35's own `resolveConversationOrchestration`). It
--    reads ONLY that ledger (no write), scoped by org and the held reply. The actual orchestration routing stays in the
--    pure core (R35's `resolveConversationOrchestration`); this reader supplies the recorded lifecycle, it never routes.
--    This centring on R34's lifecycle ledger is the storage embodiment of "the Lifecycle Engine remains authoritative —
--    the Orchestration Engine consumes its RECORDED decision, it never re-derives it". EXECUTE revoked from PUBLIC /
--    anon / authenticated, granted only to service_role.
-- ---------------------------------------------------------------------------
create or replace function public.find_receptionist_orchestration_context(
  p_org_id          uuid,
  p_review_audit_id uuid
)
returns table (
  -- The LIFECYCLE — the R34 row, so the runtime can reconstruct the GovernResolutionLifecycleDecision and route it.
  -- Every field is the recorded lifecycle's own; the runtime reads them into the decision it routes.
  lifecycle_id          uuid,
  resolution_id         uuid,
  recovery_id           uuid,
  authorisation_id      uuid,
  verification_id       uuid,
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
  lifecycle_type        text,
  lifecycle_outcome     text,
  lifecycle_transition  text,
  lifecycle_state       text,
  closed                boolean,
  ongoing               boolean,
  resolution_state      text,
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
    l.id,
    l.resolution_id,
    l.recovery_id,
    l.authorisation_id,
    l.verification_id,
    l.fulfilment_id,
    l.conversation_id,
    l.enquiry_id,
    l.lead_id,
    l.customer_ref,
    l.correlation_id,
    l.action_id,
    l.execution_id,
    l.review_audit_id,
    l.sent_audit_id,
    l.review_resolution_id,
    l.lifecycle_type,
    l.lifecycle_outcome,
    l.lifecycle_transition,
    l.lifecycle_state,
    l.closed,
    l.ongoing,
    l.resolution_state,
    l.approval_state,
    l.job_type,
    l.postcode,
    l.phone_number
  from public.receptionist_conversation_lifecycles l
  where l.org_id = p_org_id
    and l.review_audit_id = p_review_audit_id
    and l.status = 'governed'
  order by l.created_at desc
  limit 1;
$$;

revoke all on function public.find_receptionist_orchestration_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.find_receptionist_orchestration_context(uuid, uuid)
  to service_role;
