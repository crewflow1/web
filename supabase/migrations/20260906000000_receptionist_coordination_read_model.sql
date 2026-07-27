-- CrewFlow HQ — Voice Receptionist AI: the CONVERSATION COORDINATION READ MODEL
-- (CEO Directive #018, the AI Receptionist Programme — increment R37:
--  CONVERSATION COORDINATION READ MODEL).
--
-- R36 laid the Conversation Coordination Engine: a pure core that COORDINATES a routed R35
-- orchestration into a participation plan (mode / lead participant / requires-human / autonomous),
-- and a server runtime that files ONE idempotent row into the append-only, service-role-only
-- `receptionist_conversation_coordinations` ledger — behind Human Review, downstream of the full
-- Fulfilment → Verification → Recovery → Resolution → Lifecycle → Orchestration stack. Nothing
-- READ that ledger: R36 records coordination decisions, and its ONLY consumer was its own writer.
-- R37 turns that ledger into the canonical coordination READ layer: the single, authorised query
-- surface for recorded Conversation Coordination decisions. No future operational capability rolls
-- its own coordination-reconstruction logic; every consumer (a work queue, a dashboard, an
-- automation) reads THROUGH this read model — which reads coordination decisions ONLY and executes
-- no work.
--
-- IT IS A PROJECTION, NOT BEHAVIOUR. The pure coordination core, the R36 runtime, the canonical
-- Draft → Policy → Audit → Transport → Delivery-Receipt pipeline, the whole R30–R36 decision stack
-- and every append-only ledger are ALL UNTOUCHED. This read model sits BESIDE the Coordination
-- Engine as a shared read surface that resolves linked context AT READ TIME. It stores nothing,
-- duplicates no decision, re-derives no coordination (it never re-folds a mode, never recomputes a
-- lead, never re-classifies a route) and introduces no second source of truth: a coordination row
-- resolves its recorded decision from `receptionist_conversation_coordinations` and its LINKED
-- context from the six sibling ledgers the coordination was threaded to (orchestration → lifecycle
-- → resolution → recovery → verification → fulfilment), ALL BY REFERENCE, keyed off the ledger's
-- own foreign-key pointers. The Coordination Engine remains the sole authority over the decision;
-- this view only exposes, for reading, what the ledger already records.
--
-- Reuses the established projection architecture already in the repository — the shape mirrors,
-- guarantee for guarantee, the R11 conversation read model (public.receptionist_conversation_timeline,
-- 20260820000000) and the R9 delivery-lifecycle view: a `security_invoker = true` VIEW that holds no
-- rows, joins append-only / ledger relations, and is granted SELECT to service_role only. Read-only
-- by THREE structural guarantees, exactly as R11:
--   1. The view joins SEVEN relations (the coordination ledger LEFT JOIN its six sibling ledgers), so
--      it is NOT a simply-updatable view: Postgres refuses INSERT / UPDATE / DELETE through it —
--      there is no write-through, so a reader can never file, amend or delete a coordination.
--   2. `security_invoker = true` runs the view with the QUERYING role's privileges, so it inherits
--      the caller's RLS and can never launder a JWT client past the base tables' RLS deny
--      (receptionist_conversation_coordinations and every sibling ledger have RLS ENABLED with zero
--      policies; only service_role, which is BYPASSRLS, sees rows). Organisation isolation is
--      preserved: the view carries org_id and the reader filters on it, and the base-table RLS is
--      never bypassed by the view.
--   3. Only SELECT is granted, and only to service_role — anon / authenticated get nothing.
--
-- Provably additive (P2): one brand-new VIEW, zero tables, zero functions, zero columns, zero
-- triggers, zero policies. No ledger, engine, or pipeline object is altered. No producer is wired
-- and no outbound path is opened — a read model cannot coordinate, cannot execute, cannot send.
-- Every existing row and code path is byte-for-byte unchanged; the view simply exposes, for reading,
-- the coordination decisions the ledger already holds.

-- ---------------------------------------------------------------------------
-- receptionist_coordination_read_model — one row per recorded coordination, its RECORDED decision
-- (mode / lead participant / participation plan / requires-human / autonomous) surfaced directly from
-- the coordination ledger, and its LINKED context RESOLVED (not copied, not re-derived) at read time
-- from the six sibling ledgers the coordination was threaded to:
--   • orchestration → resolved from public.receptionist_conversation_orchestrations via c.orchestration_id
--                     (R35's routed target + route the coordination was coordinated from);
--   • lifecycle     → resolved from public.receptionist_conversation_lifecycles      via c.lifecycle_id
--                     (R34's governed transition + state);
--   • resolution    → resolved from public.receptionist_conversation_resolutions     via c.resolution_id
--                     (R33's determined completion state + recovery classification);
--   • recovery      → resolved from public.receptionist_conversation_recoveries      via c.recovery_id
--                     (R32's determined recovery classification + integrity);
--   • verification  → resolved from public.receptionist_conversation_verifications   via c.verification_id
--                     (R31's integrity verdict);
--   • fulfilment    → resolved from public.receptionist_conversation_fulfilments     via c.fulfilment_id
--                     (R30's performed booking — NULL exactly when the lifecycle was `retained`/MISSING).
--
-- Every join is on the sibling's PRIMARY KEY (id) via the coordination ledger's own foreign key, so a
-- coordination resolves to EXACTLY ONE row of each sibling — the read model is deterministic, one row
-- per coordination, always reconstructing identically. The joins are LEFT so a coordination is never
-- dropped if a sibling is somehow absent (fulfilment legitimately is, when retained); the linked
-- context is simply NULL. The view carries NO ORDER BY: the canonical order (newest coordination
-- first, then a stable tiebreak on coordination id) is applied by the read layer, so ordering is
-- defined in exactly ONE place and cannot be silently dropped when the view is wrapped.
-- ---------------------------------------------------------------------------
create or replace view public.receptionist_coordination_read_model
  with (security_invoker = true) as
select
  -- Identity + full provenance chain (the coordination and every ledger it was threaded to).
  c.id                          as coordination_id,
  c.org_id,
  c.conversation_id,
  c.enquiry_id,
  c.lead_id,
  c.customer_ref,
  c.correlation_id,
  c.action_id,
  c.execution_id,
  c.orchestration_id,
  c.lifecycle_id,
  c.resolution_id,
  c.recovery_id,
  c.authorisation_id,
  c.verification_id,
  c.fulfilment_id,
  c.review_audit_id,
  c.sent_audit_id,
  c.review_resolution_id,

  -- The RECORDED coordination decision — surfaced verbatim from the ledger (NEVER re-derived here).
  c.coordination_type,
  c.coordination_outcome,
  c.coordination_mode,
  c.lead_participant,
  c.participant_count,
  c.requires_human,
  c.autonomous,
  c.orchestration_route,
  c.lifecycle_state,
  c.approval_state,
  c.status                      as coordination_status,
  c.job_type,
  c.postcode,
  c.phone_number,
  c.created_at                  as coordination_at,

  -- Linked ORCHESTRATION context (R35) — the routed disposition the coordination coordinated.
  o.orchestration_type,
  o.orchestration_outcome,
  o.orchestration_target,
  o.concluded                   as orchestration_concluded,
  o.active                      as orchestration_active,
  o.status                      as orchestration_status,
  o.created_at                  as orchestration_at,

  -- Linked LIFECYCLE context (R34) — the governed transition the orchestration routed.
  l.lifecycle_type,
  l.lifecycle_outcome,
  l.lifecycle_transition,
  l.closed                      as lifecycle_closed,
  l.ongoing                     as lifecycle_ongoing,
  l.status                      as lifecycle_status,
  l.created_at                  as lifecycle_at,

  -- Linked RESOLUTION context (R33) — the completion state the lifecycle was governed from.
  r.resolution_type,
  r.resolution_outcome,
  r.resolution_state,
  r.terminal                    as resolution_terminal,
  r.intervention_required       as resolution_intervention_required,
  r.recovery_classification     as resolution_recovery_classification,
  r.status                      as resolution_status,
  r.created_at                  as resolution_at,

  -- Linked RECOVERY context (R32) — the recovery classification the resolution was determined from.
  rc.recovery_type,
  rc.recovery_outcome,
  rc.recovery_classification,
  rc.recovery_required,
  rc.integrity                  as recovery_integrity,
  rc.status                     as recovery_status,
  rc.created_at                 as recovery_at,

  -- Linked VERIFICATION context (R31) — the integrity verdict the recovery classified.
  v.verification_type,
  v.verification_outcome,
  v.integrity                   as verification_integrity,
  v.status                      as verification_status,
  v.created_at                  as verification_at,

  -- Linked FULFILMENT context (R30) — the performed booking the verification reconciled. NULL columns
  -- exactly when the coordination's lifecycle was `retained` (fulfilment_id is null / MISSING).
  f.fulfilment_type,
  f.fulfilment_outcome,
  f.status                      as fulfilment_status,
  f.created_at                  as fulfilment_at
from public.receptionist_conversation_coordinations c
  left join public.receptionist_conversation_orchestrations o
    on o.id = c.orchestration_id
  left join public.receptionist_conversation_lifecycles l
    on l.id = c.lifecycle_id
  left join public.receptionist_conversation_resolutions r
    on r.id = c.resolution_id
  left join public.receptionist_conversation_recoveries rc
    on rc.id = c.recovery_id
  left join public.receptionist_conversation_verifications v
    on v.id = c.verification_id
  left join public.receptionist_conversation_fulfilments f
    on f.id = c.fulfilment_id;

-- Read-only, service_role-only (guarantee 3). anon / authenticated get nothing; service_role
-- (BYPASSRLS) is the sole reader, exactly as the R11 conversation read model and the R9 lifecycle
-- projection.
revoke all on public.receptionist_coordination_read_model
  from public, anon, authenticated, service_role;
grant select on public.receptionist_coordination_read_model to service_role;
