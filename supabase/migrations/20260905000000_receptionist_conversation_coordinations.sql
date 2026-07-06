-- CrewFlow HQ — Voice Receptionist AI: the canonical conversation COORDINATION ledger
-- (CEO Directive #018, the AI Receptionist Programme — increment R36:
--  CONVERSATION COORDINATION ENGINE).
--
-- R17–R25 built the DERIVING stack; R26 RESOLVES an outcome; R27 PREPARES an action; R28 DECIDES an execution's
-- eligibility; R29 DETERMINES whether that decided execution requires APPROVAL; R30 PERFORMS the approved internal
-- business operation (booking fulfilment) and records it; R31 VERIFIES that performed operation — reconciling the
-- decision against the record and recording an INTEGRITY verdict (consistent / missing / inconsistent); R32 DETERMINES
-- the RECOVERY that verdict warrants (none / reinstate / reconcile) and records it; R33 DETERMINES the RESOLUTION that
-- recovery implies — classifying the conversation into a TERMINAL, RECOVERABLE or UNRESOLVED completion state — and
-- records it; R34 GOVERNS the LIFECYCLE that resolution comes to rest in — closing, retaining or escalating the
-- conversation — and records it; R35 ORCHESTRATES that governed lifecycle — ROUTING it to the platform capability that
-- should RESPOND — and records it. R36 is the NEXT layer — and, in this stack, the SIXTH that does not perform: the
-- Coordination Engine takes a ROUTED orchestration and determines HOW the platform's capabilities should be COORDINATED
-- to respond and WHICH should PARTICIPATE, recording an auditable COORDINATION here. This migration is that
-- coordination's durable, append-only, IDEMPOTENT home. Lifecycle-response coordination is the FIRST coordination type;
-- the record captures WHAT coordination was performed (`coordination_type` + `coordination_outcome`), the MODE by which
-- the response is coordinated (`coordination_mode`), the LEAD capability it centres on (`lead_participant`), the
-- PARTICIPANT COUNT of the plan (`participant_count`), WHETHER the response requires a human (`requires_human`), WHETHER
-- it is autonomous (`autonomous`), the SOURCE orchestration route it coordinated (`orchestration_route`), the SOURCE
-- lifecycle state (`lifecycle_state`), the EXPECTED booking payload (what the orchestration concerns), the grant that
-- authorised the underlying operation (`approval_state = 'approved'`), and the anchors that thread it to the
-- orchestration it was coordinated from (`orchestration_id`, NOT NULL and UNIQUE — R36's load-bearing anchor AND
-- idempotency key), to the lifecycle that orchestration was routed from (`lifecycle_id`), to the resolution that
-- lifecycle was governed from (`resolution_id`), to the recovery that resolution was determined from (`recovery_id`), to
-- the authorisation that recovery traced (`authorisation_id`), to the verification that recovery classified
-- (`verification_id`), to the fulfilment the verification reconciled (`fulfilment_id`, NULL when the source lifecycle is
-- RETAINED/MISSING), to the held reply a human approved (`review_audit_id`), to the reply that carried the human's
-- approval (`sent_audit_id`), and to the human's resolution itself in the EXISTING Human Review ledger
-- (`review_resolution_id`).
--
-- IT COORDINATES THE RESPONSE FOR APPROVED WORK — AND IT CANNOT COORDINATE A RESPONSE FOR UNAPPROVED WORK. The
-- `approval_state` column is CHECK-pinned to the single value 'approved' (inherited transitively from R35 → R34 → R33 →
-- R32 → R31 → R30, whose orchestration, lifecycle, resolution, recovery, verification and fulfilment can exist ONLY for
-- an approved authorisation): a coordination row can exist ONLY for an operation a human GRANTED. The grant lives in the
-- EXISTING Human Review ledger (`receptionist_review_resolutions`, R14, a `sent` resolution) and is folded to 'approved'
-- by R29's `deriveAuthorisationState`; this ledger records the COORDINATION of the conversation that grant set in motion,
-- threaded to the coordination row (`review_resolution_id`) and the held reply (`review_audit_id`) so the whole chain —
-- held reply → human grant → performed booking → verified integrity → determined recovery → resolved completion →
-- governed lifecycle → orchestrated response → coordinated participation — joins. R36's law ("coordinate the response for
-- approved, orchestrated work; never bypass Human Review") is made storage: a row here can NEVER represent an
-- un-approved, un-reviewed, or autonomous-of-Human-Review coordination.
--
-- IT COORDINATES WORK — IT NEVER EXECUTES WORK. Unlike R30 (whose row is a PERFORMED business operation), a coordination
-- row is a PLAN: it concludes nothing, recovers nothing, escalates nothing, enqueues nothing, notifies no one, re-books
-- nothing, retries nothing, schedules nothing, reaches no provider and pages no one. It records that a participation plan
-- was coordinated (`coordination_outcome = 'conversation_response_coordinated'`) and the `lead_participant` capability the
-- response centres on. It is the layer that turns R35's ROUTED orchestration into an auditable, single-authority
-- COORDINATION plan — the coordination a future, explicitly-authorised operational capability (a queue, a dashboard, an
-- automation) reads to know how the platform's capabilities should be coordinated to respond to a conversation.
-- Operational work queues, dashboard UI, notification delivery, automatic retries and automatic scheduling are EXPLICIT
-- R36 non-goals; NOTHING in this ledger performs them.
--
-- A COORDINATION MODE IS A PLAN, NOT AN ABSTENTION — A ROW IS FILED FOR ALL THREE. `coordination_mode` is CHECK-pinned to
-- the closed set (finalising / remediating / escalating). A coordination row is produced for EVERY routed orchestration:
-- `finalising` (the orchestration routed `conclude`; the conversation is complete, so the response is coordinated to
-- finalise — but the plan "considered and coordinated to finalise" is still filed), `remediating` (the orchestration
-- routed `recover`; there is a clear recovery path, so the response is coordinated to remediate) and `escalating` (the
-- orchestration routed `escalate`; the record is ambiguous, so the response is coordinated to escalate to a human).
-- Coordinating `remediating` and `escalating` is the WHOLE PURPOSE of the engine, so they are first-class modes on a
-- filed row — never silent.
--
-- THE MODE IS COHERENT WITH ITS PARTICIPATION FLAGS — enforced by the database. Two CHECKs pin the coherent companions:
-- (`requires_human`) = (`lead_participant = 'human_attention'`) and (`autonomous`) = (`lead_participant <>
-- 'human_attention'`). The coordinated response requires a human IFF the lead is `human_attention`, and it is autonomous
-- IFF it is NOT. These are Directive #018 R36's two distinct questions — "does the coordinated response require a human?"
-- and "is the coordinated response autonomous?" — made first-class, coherence-pinned columns. No writer — not even
-- service_role with a direct insert — can file a coordination whose participation flags contradict the lead it records.
--
-- THE LEAD IS A DETERMINISTIC TWO-STAGE FOLD OF THE ORCHESTRATION — enforced by the database. Two CHECKs pin the exact
-- fold. STAGE 1 (the mode fold): the SOURCE orchestration route folds to the coordination mode — `conclude` ⇒
-- `finalising`, `recover` ⇒ `remediating`, `escalate` ⇒ `escalating`. STAGE 2 (the lead fold): the mode folds to the lead
-- capability — `finalising` ⇒ `conversation_conclusion`, `remediating` ⇒ `recovery_handling`, `escalating` ⇒
-- `human_attention`. The lead is CONSUMED from R35's routed target; these CHECKs guarantee the consumed lead is coherent
-- with the folded mode. No writer can file a coordination whose mode contradicts the orchestration route it coordinates,
-- or whose lead contradicts its mode. Combined with the fulfilment-presence coherence CHECK (inherited transitively from
-- R35/R34/R33/R32/R31, `retained` iff no `fulfilment_id`), the whole row is deterministic by construction.
--
-- THE FOLD IS ENFORCED BY THE DATABASE — the operation is DETERMINISTIC by construction. A CHECK pins
-- (`coordination_type`, `coordination_outcome`) to the exact fold (coordinate_lifecycle_response ⇒
-- conversation_response_coordinated), `participant_count` to the single-capability plan of the first implementation
-- (`= 1`), and `approval_state` to 'approved' and `status` to 'coordinated'. No writer can file a coordination whose
-- outcome contradicts its type, whose plan is not single-capability, whose approval is anything but granted, or whose
-- status claims anything but coordinated.
--
-- IT IS IDEMPOTENT BY CONSTRUCTION — a routed orchestration's response is coordinated AT MOST ONCE. `orchestration_id` is
-- UNIQUE: one coordination per orchestration. The write primitive inserts ON CONFLICT (orchestration_id) DO NOTHING and
-- returns the EXISTING row's id on a repeat, so re-driving the same routed orchestration (a retried review-send, a
-- double-fire) never materialises a second coordination. This is the storage-layer guarantee behind R36's deterministic
-- coordination — distinct from RETRY (an explicit R36 non-goal): the ledger does not re-attempt anything, it makes a
-- repeat a no-op.
--
-- Why a DEDICATED ledger and why APPEND-ONLY. A coordination is a fact about one routed orchestration coordinated once,
-- exactly as an orchestration (R35), a lifecycle (R34), a resolution (R33), a recovery (R32), a verification (R31), a
-- fulfilment (R30), an authorisation (R29), an execution (R28), an action (R27) and an outcome (R26) are. It gets the
-- SAME first-class, append-only home — not a mutable status column — so a coordination mode can never be silently
-- rewritten or erased. The confirmation the customer received is STILL produced and audited by the UNCHANGED reply
-- pipeline, the human's GRANT is STILL recorded by the UNCHANGED Human Review architecture (R14), the operation is STILL
-- performed and recorded by the UNCHANGED R30 fulfilment ledger, it is STILL verified by the UNCHANGED R31 verification
-- ledger, its recovery is STILL determined by the UNCHANGED R32 recovery ledger, its resolution is STILL determined by
-- the UNCHANGED R33 resolution ledger, its lifecycle is STILL governed by the UNCHANGED R34 lifecycle ledger, and its
-- response is STILL orchestrated by the UNCHANGED R35 orchestration ledger; this ledger records the COORDINATION plan
-- ALONGSIDE them, threaded to the SAME `correlation_id`, so an auditor can join the coordination to the orchestration it
-- was coordinated from, the lifecycle that orchestration was routed from, the resolution that lifecycle was governed
-- from, the recovery that resolution was determined from, the verification that recovery classified, the fulfilment that
-- verification reconciled, the authorisation it traces, the reply that announced it, and the human who approved it.
--
-- Reuses the existing AUDIT architecture — the hardening mirrors, line for line, the
-- `receptionist_conversation_orchestrations` ledger:
--   • RLS enabled, ZERO policies — service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
--     writers/readers; every JWT client (anon / authenticated) is denied.
--   • APPEND-ONLY — UPDATE and DELETE are rejected by triggers even for service_role.
--   • A single validated SECURITY DEFINER write entry point, plus a single service-role-only SECURITY DEFINER
--     COORDINATION-CONTEXT READER that resolves the RECORDED orchestration disposition behind a held reply (the R35
--     orchestration the runtime coordinates into a plan) — both with EXECUTE revoked from PUBLIC / anon /
--     authenticated and granted only to service_role.
--
-- Provably additive (P2): a brand-new table + two functions + triggers. No tenant table is touched, no existing
-- column is altered, and no producer is wired by this migration (the server runtime wires the store in
-- TypeScript). References to organisation / conversation / enquiry / customer / action / execution / authorisation
-- / verification / fulfilment / recovery / resolution / lifecycle / orchestration / held reply / sent reply / review
-- resolution are carried as DENORMALISED, un-FK'd facts (the append-only rule: a coordination must outlive the rows it
-- describes, so no `on delete cascade` can ever erase coordination history).

-- ---------------------------------------------------------------------------
-- 1. receptionist_conversation_coordinations — one append-only record per COORDINATED response. RLS:hq. Captures WHAT
--    coordination was performed (`coordination_type` + `coordination_outcome`), the MODE by which the response is
--    coordinated (`coordination_mode`), the LEAD capability it centres on (`lead_participant`), the PARTICIPANT COUNT of
--    the plan (`participant_count`), WHETHER the response requires a human (`requires_human`), WHETHER it is autonomous
--    (`autonomous`), the SOURCE `orchestration_route`, the SOURCE `lifecycle_state`, the EXPECTED booking payload, the
--    grant that authorised the underlying operation (`approval_state`), its `status`, and the anchors that thread it to
--    the organisation, conversation, enquiry, customer, prepared action, decided execution and — the load-bearing ones —
--    the orchestration it was coordinated from (`orchestration_id`, NOT NULL, UNIQUE), the lifecycle that orchestration
--    was routed from (`lifecycle_id`), the resolution that lifecycle was governed from (`resolution_id`), the recovery
--    that resolution was determined from (`recovery_id`), the authorisation that recovery traced (`authorisation_id`),
--    the verification that recovery classified (`verification_id`), the fulfilment that verification reconciled
--    (`fulfilment_id`, NULL when retained/MISSING), the held reply a human approved (`review_audit_id`), the reply that
--    carried the approval (`sent_audit_id`) and the human's resolution (`review_resolution_id`).
-- ---------------------------------------------------------------------------
create table if not exists public.receptionist_conversation_coordinations (
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
  -- THE ORCHESTRATION THIS COORDINATION WAS COORDINATED FROM — the R35 `receptionist_conversation_orchestrations` row, a
  -- soft (un-FK'd) reference. NOT NULL: a coordination is ALWAYS coordinated from a specific recorded orchestration
  -- routing (R36 reads R35's RECORDED routing and coordinates it; there is no coordination without an orchestration to
  -- coordinate). UNIQUE: one coordination per orchestration (the idempotency anchor). This is R36's load-bearing anchor —
  -- the storage proof that "the Orchestration Engine remains authoritative".
  orchestration_id uuid      not null,
  -- THE LIFECYCLE THE ORCHESTRATION WAS ROUTED FROM — the R34 `receptionist_conversation_lifecycles` row, a soft (un-FK'd)
  -- reference. NOT NULL: a coordination always traces to the specific lifecycle its orchestration was routed from.
  lifecycle_id   uuid        not null,
  -- THE RESOLUTION THE LIFECYCLE WAS GOVERNED FROM — the R33 `receptionist_conversation_resolutions` row, a soft (un-FK'd)
  -- reference. NOT NULL: a coordination always traces to the specific resolution its lifecycle was governed from.
  resolution_id  uuid        not null,
  -- THE RECOVERY THE RESOLUTION WAS DETERMINED FROM — the R32 `receptionist_conversation_recoveries` row, a soft (un-FK'd)
  -- reference. NOT NULL: a coordination always traces to the specific recovery its resolution was determined from.
  recovery_id    uuid        not null,
  -- THE AUTHORISATION THE RECOVERY TRACED — the R29 `receptionist_conversation_authorisations` row, a soft (un-FK'd)
  -- reference. NOT NULL: a coordination always traces to the specific approved authorisation its recovery traced.
  authorisation_id uuid      not null,
  -- THE VERIFICATION THE RECOVERY CLASSIFIED — the R31 `receptionist_conversation_verifications` row, a soft (un-FK'd)
  -- reference. NOT NULL: a coordination always traces to the specific verification its recovery classified.
  verification_id uuid       not null,
  -- THE FULFILMENT THE VERIFICATION RECONCILED — the R30 `receptionist_conversation_fulfilments` row, a soft (un-FK'd)
  -- reference. NULLABLE: it is NULL exactly when the source lifecycle is RETAINED (the operation is MISSING), and NOT NULL
  -- for a finalising or escalating coordination — a coherence CHECK below binds the two (inherited transitively from
  -- R35/R34/R33/R32/R31).
  fulfilment_id  uuid,
  -- THE HUMAN REVIEW CHAIN — the held reply a human approved (`review_audit_id`, the `ai_reply_audits` row the
  -- R14 inbox surfaced), the reply that CARRIED the human's approval to the customer (`sent_audit_id`, the new
  -- `ai_reply_audits` row the send produced) and the human's resolution itself (`review_resolution_id`, the
  -- `receptionist_review_resolutions` row — the grant). All NOT NULL: a coordination is coordinated ONLY downstream of a
  -- human's `sent` resolution, so the full provenance always exists. This is how "never bypass Human Review" is threaded
  -- structurally.
  review_audit_id     uuid   not null,
  sent_audit_id       uuid   not null,
  review_resolution_id uuid  not null,
  -- WHAT coordination was performed.
  coordination_type    text  not null
                             check (coordination_type in ('coordinate_lifecycle_response')),
  -- The COORDINATED result of running the coordination — CHECK-pinned to the closed set; folded from the coordination
  -- type below. This is the operation R36 performs (a participation plan was coordinated); the MODE and LEAD of that plan
  -- are `coordination_mode` + `lead_participant`, not this.
  coordination_outcome text not null
                             check (coordination_outcome in ('conversation_response_coordinated')),
  -- THE COORDINATION MODE — CHECK-pinned to the closed set. The "manner" by which the platform's capabilities are
  -- coordinated to respond: `finalising` (from a `conclude` route), `remediating` (from a `recover` route), `escalating`
  -- (from an `escalate` route). This is the operative disposition future operational capabilities read to know how a
  -- response is coordinated. R36 records the mode; it carries none of it out.
  coordination_mode    text  not null
                             check (coordination_mode in ('finalising', 'remediating', 'escalating')),
  -- THE LEAD PARTICIPANT — CHECK-pinned to the closed set. The capability the coordinated response centres on, CONSUMED
  -- from R35's routed target. A row is filed for ALL three: `conversation_conclusion` (the orchestration routed
  -- `conclude`; the conclusion capability leads), `recovery_handling` (the orchestration routed `recover`; recovery
  -- handling leads), `human_attention` (the orchestration routed `escalate`; a human leads). This is the auditable
  -- capability future operational capabilities read to determine which capability leads the coordinated response.
  lead_participant     text  not null
                             check (lead_participant in ('conversation_conclusion', 'recovery_handling', 'human_attention')),
  -- THE PARTICIPANT COUNT — the cardinality of the participation plan. CHECK-pinned to 1 by the single-capability CHECK
  -- below: the FIRST, lifecycle implementation coordinates EXACTLY ONE capability (the lead participates). A future
  -- coordination type that coordinates several capabilities relaxes this as an explicit, reviewable act.
  participant_count    integer not null,
  -- WHETHER THE COORDINATED RESPONSE REQUIRES A HUMAN — the coherent companion of the lead (true IFF the lead is
  -- `human_attention`). Bound to the lead by the requires-human-coherence CHECK below so it can never drift. This answers
  -- Directive #018 R36's question "does the coordinated response require a human?".
  requires_human boolean     not null,
  -- WHETHER THE COORDINATED RESPONSE IS AUTONOMOUS — the coherent companion of the lead (true IFF the lead is NOT
  -- `human_attention`). Bound to the lead by the autonomous-coherence CHECK below so it can never drift. This answers
  -- Directive #018 R36's question "is the coordinated response autonomous?".
  autonomous     boolean     not null,
  -- THE SOURCE ORCHESTRATION ROUTE — the R35 routing this coordination coordinated, CHECK-pinned to the closed set.
  -- Carried for audit + coherence: the mode fold CHECK binds it to `coordination_mode`.
  orchestration_route text    not null
                             check (orchestration_route in ('conclude', 'recover', 'escalate')),
  -- THE SOURCE LIFECYCLE STATE — the R34 disposition the orchestration routed, CHECK-pinned to the closed set. Carried
  -- for the full-chain record: the fulfilment-presence coherence CHECK (inherited transitively) binds it to the presence
  -- of the fulfilment.
  lifecycle_state text       not null
                             check (lifecycle_state in ('closed', 'retained', 'escalated')),
  -- THE GRANT THAT AUTHORISED THE UNDERLYING OPERATION — CHECK-pinned to the single value 'approved', inherited
  -- transitively from R35 → R34 → R33 → R32 → R31 → R30 (an orchestration, and therefore a coordination coordinated from
  -- one, can ONLY exist for an approved authorisation). A pending, rejected or foreclosed authorisation is structurally
  -- un-coordinatable. The grant lives in the EXISTING Human Review ledger; this column records that a grant authorised the
  -- operation this row's coordination concerns.
  approval_state text        not null
                             check (approval_state = 'approved'),
  -- The EXPECTED booking payload — the trade, the place and the number to ring the DECISION concerns (carried through
  -- from the R35 orchestration decision, which carried it from R34, which carried it from R33, which carried it from R32,
  -- which carried it from R31, which carried it from R30). Each bounded in DDL to its R20 shape so the ledger can never
  -- store a malformed expectation. Nullable at the column level (future coordination types may not carry these); the
  -- write primitive REQUIRES all three for a `coordinate_lifecycle_response` coordination, regardless of the mode (the
  -- expectation always exists).
  job_type       text,
  postcode       text        check (postcode is null or postcode ~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'),
  phone_number   text        check (phone_number is null or phone_number ~ '^\+\d{10,15}$'),
  -- COORDINATED BY CONSTRUCTION: a participation plan is COORDINATED, and the row records exactly that. Pinned to the
  -- single value 'coordinated' so the ledger can never claim a partial, pending or executed coordination. (How the
  -- response is coordinated, and which capability leads, is `coordination_mode` + `lead_participant`; a `remediating` /
  -- `escalating` mode is still a fully `coordinated` response — planned, never EXECUTED.)
  status         text        not null default 'coordinated'
                             check (status = 'coordinated'),
  -- Coordination metadata — the participation path, the strategy/goal it derived from, etc.
  metadata       jsonb       not null default '{}',
  created_at     timestamptz not null default now(),
  -- IDEMPOTENCY — one coordination per orchestration. Combined with the primitive's ON CONFLICT DO NOTHING, a routed
  -- orchestration's response is coordinated AT MOST ONCE.
  constraint receptionist_conversation_coordinations_orchestration_unique unique (orchestration_id),
  -- THE FOLD, ENFORCED. (`coordination_type`, `coordination_outcome`) is the exact fold: coordinate_lifecycle_response ⇒
  -- conversation_response_coordinated. No row can contradict its own type, so the coordinated result is deterministic.
  constraint receptionist_conversation_coordinations_outcome_fold check (
    coordination_type = 'coordinate_lifecycle_response' and coordination_outcome = 'conversation_response_coordinated'
  ),
  -- THE KEYSTONE — STAGE 1: MODE FOLD, ENFORCED. The mode is the exact, deterministic fold of the SOURCE orchestration
  -- route: `conclude` ⇒ `finalising`, `recover` ⇒ `remediating`, `escalate` ⇒ `escalating`. No row can contradict the
  -- orchestration route it coordinates. This is the R36 analogue of R35's route fold — the first half of the two-stage
  -- fold at the heart of this engine.
  constraint receptionist_conversation_coordinations_mode_fold check (
    (orchestration_route = 'conclude' and coordination_mode = 'finalising')
    or (orchestration_route = 'recover' and coordination_mode = 'remediating')
    or (orchestration_route = 'escalate' and coordination_mode = 'escalating')
  ),
  -- THE KEYSTONE — STAGE 2: LEAD FOLD, ENFORCED. The lead capability is the exact, deterministic fold of the mode:
  -- `finalising` ⇒ `conversation_conclusion`, `remediating` ⇒ `recovery_handling`, `escalating` ⇒ `human_attention`. The
  -- lead is CONSUMED from R35's routed target; this CHECK guarantees the consumed lead is coherent with the folded mode.
  -- No row can contradict the mode it records. This is the second half of the two-stage fold — together with the mode
  -- fold, the whole `orchestration_route → coordination_mode → lead_participant` chain is enforced.
  constraint receptionist_conversation_coordinations_lead_fold check (
    (coordination_mode = 'finalising' and lead_participant = 'conversation_conclusion')
    or (coordination_mode = 'remediating' and lead_participant = 'recovery_handling')
    or (coordination_mode = 'escalating' and lead_participant = 'human_attention')
  ),
  -- REQUIRES-HUMAN COHERENCE, ENFORCED. `requires_human` is TRUE IFF the lead is `human_attention`. The equivalence binds
  -- the flag to the lead, so the ledger can never claim the response requires a human over a
  -- `conversation_conclusion`/`recovery_handling` lead, or not over a `human_attention` one. This answers Directive #018
  -- R36's question #1, made storage.
  constraint receptionist_conversation_coordinations_requires_human_coherence check (
    requires_human = (lead_participant = 'human_attention')
  ),
  -- AUTONOMOUS COHERENCE, ENFORCED. `autonomous` is TRUE IFF the lead is NOT `human_attention`. The equivalence binds the
  -- flag to the lead, so the ledger can never claim the response is autonomous over a `human_attention` lead, or not
  -- autonomous over a `conversation_conclusion`/`recovery_handling` one. This answers Directive #018 R36's question #2,
  -- made storage.
  constraint receptionist_conversation_coordinations_autonomous_coherence check (
    autonomous = (lead_participant <> 'human_attention')
  ),
  -- SINGLE-CAPABILITY PLAN, ENFORCED. The FIRST, lifecycle implementation coordinates EXACTLY ONE capability (the lead
  -- participates), so `participant_count` is pinned to 1. A future coordination type that coordinates several capabilities
  -- relaxes this as an explicit, reviewable act.
  constraint receptionist_conversation_coordinations_single_capability check (
    participant_count = 1
  ),
  -- FULFILMENT-PRESENCE COHERENCE, ENFORCED (inherited transitively from R35/R34/R33/R32/R31). A `retained` source
  -- lifecycle means — and can ONLY mean — that no fulfilment was recorded (`fulfilment_id` NULL, the operation is
  -- MISSING); any other lifecycle state (`closed` / `escalated`) means a fulfilment WAS recorded (`fulfilment_id` NOT
  -- NULL). The equivalence binds the source state to the presence of the record, so the ledger can never claim `retained`
  -- over a present record or `closed`/`escalated` over an absent one.
  constraint receptionist_conversation_coordinations_fulfilment_coherence check (
    (fulfilment_id is null) = (lifecycle_state = 'retained')
  )
);

create index if not exists receptionist_conversation_coordinations_org_created_idx
  on public.receptionist_conversation_coordinations (org_id, created_at desc);
create index if not exists receptionist_conversation_coordinations_correlation_idx
  on public.receptionist_conversation_coordinations (correlation_id);
create index if not exists receptionist_conversation_coordinations_conversation_idx
  on public.receptionist_conversation_coordinations (conversation_id)
  where conversation_id is not null;
create index if not exists receptionist_conversation_coordinations_execution_idx
  on public.receptionist_conversation_coordinations (execution_id)
  where execution_id is not null;
-- The JOIN back to the R35 orchestration ledger — find the coordination coordinated from an orchestration.
create index if not exists receptionist_conversation_coordinations_orchestration_idx
  on public.receptionist_conversation_coordinations (orchestration_id);
-- The JOIN back to the R34 lifecycle ledger — find the coordination for a governed lifecycle.
create index if not exists receptionist_conversation_coordinations_lifecycle_idx
  on public.receptionist_conversation_coordinations (lifecycle_id);
-- The JOIN back to the R33 resolution ledger — find the coordination for a determined resolution.
create index if not exists receptionist_conversation_coordinations_resolution_idx
  on public.receptionist_conversation_coordinations (resolution_id);
-- The JOIN back to the R32 recovery ledger — find the coordination for a determined recovery.
create index if not exists receptionist_conversation_coordinations_recovery_idx
  on public.receptionist_conversation_coordinations (recovery_id);
-- The JOIN back to the R31 verification ledger — find the coordination for a verified operation.
create index if not exists receptionist_conversation_coordinations_verification_idx
  on public.receptionist_conversation_coordinations (verification_id);
-- The JOIN back to the R30 fulfilment ledger — find the coordination for a performed fulfilment.
create index if not exists receptionist_conversation_coordinations_fulfilment_idx
  on public.receptionist_conversation_coordinations (fulfilment_id)
  where fulfilment_id is not null;
-- The JOIN back to the EXISTING Human Review inbox — find the coordination for a held reply a human resolved.
create index if not exists receptionist_conversation_coordinations_review_audit_idx
  on public.receptionist_conversation_coordinations (review_audit_id);
-- Coordination analytics — how many coordinations of each type/outcome/mode/lead were performed (the participation signal
-- an operator and future operational capabilities watch to find conversations coordinated to finalise, remediate or
-- escalate to a human).
create index if not exists receptionist_conversation_coordinations_plan_idx
  on public.receptionist_conversation_coordinations (coordination_type, coordination_outcome, coordination_mode, lead_participant, participant_count, requires_human, autonomous, orchestration_route, lifecycle_state, status, created_at desc);

-- RLS:hq — enabled, ZERO policies. service_role (BYPASSRLS) and the SECURITY DEFINER primitives are the only
-- paths in; every JWT client (anon / authenticated) is denied because an RLS-enabled table with no policies
-- defaults to deny.
alter table public.receptionist_conversation_coordinations enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Append-only guard — a coordination is a fact about one plan, never updated or deleted. Reject
--    UPDATE/DELETE even under service_role. Mirrors the R35 orchestrations append-only guard.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_conversation_coordinations_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'receptionist_conversation_coordinations is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists receptionist_conversation_coordinations_no_update
  on public.receptionist_conversation_coordinations;
create trigger receptionist_conversation_coordinations_no_update
  before update on public.receptionist_conversation_coordinations
  for each row execute function public.receptionist_conversation_coordinations_block_mutation();

drop trigger if exists receptionist_conversation_coordinations_no_delete
  on public.receptionist_conversation_coordinations;
create trigger receptionist_conversation_coordinations_no_delete
  before delete on public.receptionist_conversation_coordinations
  for each row execute function public.receptionist_conversation_coordinations_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. record_receptionist_conversation_coordination — the single validated write entry point. SECURITY DEFINER,
--    service_role-only (EXECUTE revoked from PUBLIC, anon, authenticated). The server runtime calls this AND ONLY
--    this to record a coordination plan; the write is BEST-EFFORT there (a failure is logged and swallowed so a
--    durable, audited, human-approved confirmation reply is never undone by a coordination write), but the primitive
--    itself validates strictly: the coordination type, outcome, mode, lead and source orchestration route + lifecycle
--    state must be in their vocabularies, the approval MUST be 'approved' (the storage-layer Human Review gate, inherited
--    from R35 → R34 → R33 → R32 → R31 → R30), `requires_human` MUST be COHERENT with the lead (true iff
--    `human_attention`), `autonomous` MUST be COHERENT with the lead (true iff not `human_attention`), the mode MUST be
--    the deterministic fold of the orchestration route, the lead MUST be the deterministic fold of the mode, the
--    `participant_count` MUST be the single-capability plan (`= 1`), the source lifecycle state MUST be COHERENT with the
--    presence of the fulfilment (`retained` iff no `fulfilment_id`, inherited transitively), a
--    `coordinate_lifecycle_response` MUST carry the expected job type plus a well-formed postcode and E.164 number and the
--    full orchestration + Human Review provenance, and the fold CHECK guarantees (type, outcome) match. IDEMPOTENT: ON
--    CONFLICT (orchestration_id) DO NOTHING returns the existing coordination's id, so a repeat coordinates nothing.
--    Returns the coordination id.
-- ---------------------------------------------------------------------------
create or replace function public.record_receptionist_conversation_coordination(
  p_org_id                  uuid,
  p_orchestration_id        uuid,
  p_lifecycle_id            uuid,
  p_resolution_id           uuid,
  p_recovery_id             uuid,
  p_authorisation_id        uuid,
  p_verification_id         uuid,
  p_coordination_type       text,
  p_coordination_outcome    text,
  p_coordination_mode       text,
  p_lead_participant        text,
  p_participant_count       integer,
  p_requires_human          boolean,
  p_autonomous              boolean,
  p_orchestration_route     text,
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
  if p_coordination_type not in ('coordinate_lifecycle_response') then
    raise exception 'receptionist coordination type must be one of coordinate_lifecycle_response, got %', p_coordination_type
      using errcode = 'check_violation';
  end if;

  if p_coordination_outcome not in ('conversation_response_coordinated') then
    raise exception 'receptionist coordination outcome must be one of conversation_response_coordinated, got %', p_coordination_outcome
      using errcode = 'check_violation';
  end if;

  if p_coordination_mode not in ('finalising', 'remediating', 'escalating') then
    raise exception 'receptionist coordination mode must be one of finalising, remediating, escalating, got %', p_coordination_mode
      using errcode = 'check_violation';
  end if;

  if p_lead_participant not in ('conversation_conclusion', 'recovery_handling', 'human_attention') then
    raise exception 'receptionist coordination lead participant must be one of conversation_conclusion, recovery_handling, human_attention, got %', p_lead_participant
      using errcode = 'check_violation';
  end if;

  if p_orchestration_route not in ('conclude', 'recover', 'escalate') then
    raise exception 'receptionist coordination orchestration route must be one of conclude, recover, escalate, got %', p_orchestration_route
      using errcode = 'check_violation';
  end if;

  if p_lifecycle_state not in ('closed', 'retained', 'escalated') then
    raise exception 'receptionist coordination lifecycle state must be one of closed, retained, escalated, got %', p_lifecycle_state
      using errcode = 'check_violation';
  end if;

  -- THE HUMAN REVIEW GATE, AT THE STORAGE LAYER (inherited from R35 → R34 → R33 → R32 → R31 → R30). A coordination is
  -- coordinated ONLY for an APPROVED authorisation. The grant is the human's, recorded in the EXISTING Human Review
  -- ledger; this primitive can only ever file a coordination whose approval is 'approved'. There is no path to
  -- coordinating a response for un-approved work.
  if p_approval_state <> 'approved' then
    raise exception 'receptionist coordination requires an approved authorisation (Human Review may not be bypassed), got approval_state=%', p_approval_state
      using errcode = 'check_violation';
  end if;

  -- REQUIRES-HUMAN COHERENCE. `requires_human` is TRUE iff the lead is `human_attention`. Belt-and-braces with the table
  -- CHECK: a precise error for an incoherent call.
  if p_requires_human <> (p_lead_participant = 'human_attention') then
    raise exception 'receptionist coordination requires_human=% is incoherent with lead=% (requires_human iff lead = human_attention)',
      p_requires_human, p_lead_participant
      using errcode = 'check_violation';
  end if;

  -- AUTONOMOUS COHERENCE. `autonomous` is TRUE iff the lead is NOT `human_attention`. Belt-and-braces with the table
  -- CHECK: a precise error for an incoherent call.
  if p_autonomous <> (p_lead_participant <> 'human_attention') then
    raise exception 'receptionist coordination autonomous=% is incoherent with lead=% (autonomous iff lead <> human_attention)',
      p_autonomous, p_lead_participant
      using errcode = 'check_violation';
  end if;

  -- THE MODE FOLD (stage 1). The mode is the exact, deterministic fold of the source orchestration route: conclude ⇒
  -- finalising, recover ⇒ remediating, escalate ⇒ escalating. Belt-and-braces with the table CHECK: a precise error for a
  -- mode that contradicts the orchestration route it claims to have coordinated.
  if not (
    (p_orchestration_route = 'conclude' and p_coordination_mode = 'finalising')
    or (p_orchestration_route = 'recover' and p_coordination_mode = 'remediating')
    or (p_orchestration_route = 'escalate' and p_coordination_mode = 'escalating')
  ) then
    raise exception 'receptionist coordination mode=% is not the deterministic fold of orchestration route=%',
      p_coordination_mode, p_orchestration_route
      using errcode = 'check_violation';
  end if;

  -- THE LEAD FOLD (stage 2). The lead is the exact, deterministic fold of the mode: finalising ⇒ conversation_conclusion,
  -- remediating ⇒ recovery_handling, escalating ⇒ human_attention. Belt-and-braces with the table CHECK: a precise error
  -- for a lead that contradicts the mode it records.
  if not (
    (p_coordination_mode = 'finalising' and p_lead_participant = 'conversation_conclusion')
    or (p_coordination_mode = 'remediating' and p_lead_participant = 'recovery_handling')
    or (p_coordination_mode = 'escalating' and p_lead_participant = 'human_attention')
  ) then
    raise exception 'receptionist coordination lead=% is not the deterministic fold of mode=%',
      p_lead_participant, p_coordination_mode
      using errcode = 'check_violation';
  end if;

  -- SINGLE-CAPABILITY PLAN. The first, lifecycle implementation coordinates EXACTLY ONE capability. Belt-and-braces with
  -- the table CHECK: a precise error for a plan that is not single-capability.
  if p_participant_count <> 1 then
    raise exception 'receptionist coordination participant_count=% is not the single-capability plan (participant_count = 1)',
      p_participant_count
      using errcode = 'check_violation';
  end if;

  -- FULFILMENT-PRESENCE COHERENCE (inherited transitively from R35/R34/R33/R32/R31). A `retained` source lifecycle means,
  -- and can ONLY mean, that no fulfilment was recorded (no `fulfilment_id`); any other lifecycle state means a fulfilment
  -- WAS recorded (`fulfilment_id` present). Belt-and-braces with the table CHECK: a precise error for an incoherent call.
  if (p_fulfilment_id is null) <> (p_lifecycle_state = 'retained') then
    raise exception 'receptionist coordination lifecycle state=% is incoherent with fulfilment_id=% (retained iff no fulfilment)',
      p_lifecycle_state, coalesce(p_fulfilment_id::text, 'null')
      using errcode = 'check_violation';
  end if;

  -- The orchestration anchor, the lifecycle/resolution/recovery/authorisation/verification anchors and the full Human
  -- Review provenance are MANDATORY — a coordination is ALWAYS coordinated from a specific recorded orchestration,
  -- tracing a specific lifecycle, resolution, recovery, authorisation and verification, downstream of a specific human
  -- `sent` resolution on a specific held reply.
  if p_orchestration_id is null or p_lifecycle_id is null or p_resolution_id is null or p_recovery_id is null or p_authorisation_id is null or p_verification_id is null or p_review_audit_id is null or p_sent_audit_id is null or p_review_resolution_id is null then
    raise exception 'receptionist coordination requires orchestration_id, lifecycle_id, resolution_id, recovery_id, authorisation_id, verification_id, review_audit_id, sent_audit_id and review_resolution_id (the orchestration + Human Review provenance)'
      using errcode = 'check_violation';
  end if;

  -- A coordinate_lifecycle_response coordination MUST carry the three facts that identify the EXPECTED visit — the trade,
  -- the place and the number to ring — each well-formed. This is the decision's expectation, present for every mode
  -- (including `finalising`), so the coordination record is self-describing about what the orchestration concerns.
  if p_coordination_type = 'coordinate_lifecycle_response'
     and (
       p_job_type is null or length(trim(p_job_type)) = 0
       or p_postcode is null or p_postcode !~ '^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$'
       or p_phone_number is null or p_phone_number !~ '^\+\d{10,15}$'
     ) then
    raise exception 'receptionist coordinate_lifecycle_response requires an expected job type, a well-formed postcode and a well-formed E.164 phone number, got job_type=%, postcode=%, phone=%',
      coalesce(p_job_type, 'null'), coalesce(p_postcode, 'null'), coalesce(p_phone_number, 'null')
      using errcode = 'check_violation';
  end if;

  -- The (type, outcome) MUST be the fold. Belt-and-braces with the table CHECK: a precise error for a mismatch.
  if not (p_coordination_type = 'coordinate_lifecycle_response' and p_coordination_outcome = 'conversation_response_coordinated') then
    raise exception 'receptionist coordination (type=%, outcome=%) does not match the deterministic fold',
      p_coordination_type, p_coordination_outcome
      using errcode = 'check_violation';
  end if;

  -- IDEMPOTENT INSERT — one coordination per orchestration. A repeat coordinates nothing; we return the existing id.
  insert into public.receptionist_conversation_coordinations (
    org_id, orchestration_id, lifecycle_id, resolution_id, recovery_id, authorisation_id, verification_id, fulfilment_id,
    coordination_type, coordination_outcome, coordination_mode, lead_participant, participant_count, requires_human,
    autonomous, orchestration_route, lifecycle_state, approval_state,
    correlation_id, review_audit_id, sent_audit_id, review_resolution_id,
    conversation_id, enquiry_id, lead_id, customer_ref, action_id, execution_id,
    job_type, postcode, phone_number, metadata
  ) values (
    p_org_id, p_orchestration_id, p_lifecycle_id, p_resolution_id, p_recovery_id, p_authorisation_id, p_verification_id, p_fulfilment_id,
    p_coordination_type, p_coordination_outcome, p_coordination_mode, p_lead_participant, p_participant_count, p_requires_human,
    p_autonomous, p_orchestration_route, p_lifecycle_state, p_approval_state,
    p_correlation_id, p_review_audit_id, p_sent_audit_id, p_review_resolution_id,
    p_conversation_id, p_enquiry_id, p_lead_id, p_customer_ref, p_action_id, p_execution_id,
    p_job_type, p_postcode, p_phone_number, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (orchestration_id) do nothing
  returning id into v_id;

  -- ON CONFLICT DO NOTHING returns no row when the orchestration's coordination was already coordinated — resolve the
  -- existing coordination's id so the caller always gets a stable id and the operation is a true no-op on repeat.
  if v_id is null then
    select id into v_id
      from public.receptionist_conversation_coordinations
      where orchestration_id = p_orchestration_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.record_receptionist_conversation_coordination(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, integer, boolean, boolean, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_receptionist_conversation_coordination(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, integer, boolean, boolean, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, text, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. find_receptionist_coordination_context — the single service-role-only SECURITY DEFINER COORDINATION-CONTEXT
--    READER the runtime uses to resolve, in ONE read, the RECORDED orchestration routing behind a held reply a human
--    just approved: the ROUTED `orchestrate_lifecycle_response` orchestration (from the R35
--    `receptionist_conversation_orchestrations` ledger — R35's RECORDED routing, so the runtime can reconstruct the
--    OrchestrateLifecycleResponseDecision verbatim and coordinate it through R36's own `resolveConversationCoordination`).
--    It reads ONLY that ledger (no write), scoped by org and the held reply. The actual coordination planning stays in
--    the pure core (R36's `resolveConversationCoordination`); this reader supplies the recorded orchestration, it never
--    coordinates. This centring on R35's orchestration ledger is the storage embodiment of "the Orchestration Engine
--    remains authoritative — the Coordination Engine consumes its RECORDED decision, it never re-derives it". EXECUTE
--    revoked from PUBLIC / anon / authenticated, granted only to service_role.
-- ---------------------------------------------------------------------------
create or replace function public.find_receptionist_coordination_context(
  p_org_id          uuid,
  p_review_audit_id uuid
)
returns table (
  -- The ORCHESTRATION — the R35 row, so the runtime can reconstruct the OrchestrateLifecycleResponseDecision and
  -- coordinate it. Every field is the recorded orchestration's own; the runtime reads them into the decision it
  -- coordinates.
  orchestration_id      uuid,
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
  orchestration_type    text,
  orchestration_outcome text,
  orchestration_route   text,
  orchestration_target  text,
  concluded             boolean,
  active                boolean,
  lifecycle_state       text,
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
    o.id,
    o.lifecycle_id,
    o.resolution_id,
    o.recovery_id,
    o.authorisation_id,
    o.verification_id,
    o.fulfilment_id,
    o.conversation_id,
    o.enquiry_id,
    o.lead_id,
    o.customer_ref,
    o.correlation_id,
    o.action_id,
    o.execution_id,
    o.review_audit_id,
    o.sent_audit_id,
    o.review_resolution_id,
    o.orchestration_type,
    o.orchestration_outcome,
    o.orchestration_route,
    o.orchestration_target,
    o.concluded,
    o.active,
    o.lifecycle_state,
    o.approval_state,
    o.job_type,
    o.postcode,
    o.phone_number
  from public.receptionist_conversation_orchestrations o
  where o.org_id = p_org_id
    and o.review_audit_id = p_review_audit_id
    and o.status = 'orchestrated'
  order by o.created_at desc
  limit 1;
$$;

revoke all on function public.find_receptionist_coordination_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.find_receptionist_coordination_context(uuid, uuid)
  to service_role;
