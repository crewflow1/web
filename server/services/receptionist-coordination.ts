import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveConversationCoordination,
  isCoordinationDecided,
  type ConversationCoordinationType,
  type CoordinationOutcome,
  type CoordinationMode,
  type CoordinationParticipant,
  type CoordinationLifecycleState,
} from "@/lib/receptionist/conversation-coordination";
import {
  type OrchestrateLifecycleResponseDecision,
  type ConversationOrchestrationType,
  type OrchestrationOutcome,
  type OrchestrationRoute,
  type OrchestrationTarget,
} from "@/lib/receptionist/conversation-orchestration";

// =====================================================================
// THE CONVERSATION COORDINATION ENGINE — SERVER RUNTIME (CEO Directive #018, R36: CONVERSATION COORDINATION ENGINE).
//
// The pure core (lib/receptionist/conversation-coordination.ts) COORDINATES a coordination DECISION from an already-routed
// R35 orchestration — it determines the MODE by which the platform's capabilities should be coordinated to respond
// (finalising / remediating / escalating), the lead PARTICIPANT and the participation plan (which capabilities should
// participate), and reports WHETHER the coordinated response requires a human and WHETHER it is autonomous, but it
// deliberately PERSISTS NOTHING and reaches NO I/O. This module is the engine's SERVER RUNTIME, and it does exactly ONE
// thing: when a human APPROVES a held booking confirmation (a `sent` resolution in the EXISTING Human Review inbox),
// AFTER the Fulfilment Engine (R30) has performed the approved booking, the Verification Engine (R31) has VERIFIED it,
// the Recovery Engine (R32) has DETERMINED its recovery, the Resolution Engine (R33) has DETERMINED its resolution, the
// Lifecycle Engine (R34) has GOVERNED its lifecycle and the Orchestration Engine (R35) has ROUTED that lifecycle's
// response, it COORDINATES the conversation's response — it reads R35's RECORDED orchestration routing, coordinates it
// into a participation plan, and files one durable, append-only, IDEMPOTENT coordination — and STOPS.
//
// IT COORDINATES WORK — IT NEVER EXECUTES WORK. Unlike the R30 runtime (which MATERIALISES an approved booking as an
// internal record), this runtime concludes nothing, recovers nothing, escalates nothing, enqueues nothing, notifies no
// one, re-books nothing, retries nothing, schedules nothing, reaches NO provider and pages NO one. It COORDINATES a
// routed orchestration into a participation plan and records the {@link CoordinationMode} and lead
// {@link CoordinationParticipant} it centres on. It is the layer that turns R35's ROUTED orchestration into an auditable,
// single-authority COORDINATION plan — the coordination a future, explicitly-authorised operational capability (a queue,
// a dashboard, an automation) reads to know HOW the platform's capabilities should be coordinated to respond to a
// conversation and WHICH should participate. Operational work queues, dashboard UI, notification delivery, automatic
// retries and automatic scheduling are EXPLICIT R36 non-goals; NOTHING here performs them.
//
// THE ORCHESTRATION ENGINE REMAINS AUTHORITATIVE — THIS RUNTIME CONSUMES ITS RECORDED DECISION, IT NEVER RE-DERIVES IT.
// It resolves, in ONE read through the single service-role-only COORDINATION-CONTEXT READER
// `find_receptionist_coordination_context`, R35's RECORDED orchestration routing behind the held reply (from the R35
// `receptionist_conversation_orchestrations` ledger). It RECONSTRUCTS the R35 {@link OrchestrateLifecycleResponseDecision}
// verbatim from the recorded columns — the type, the outcome, the ROUTE, the TARGET, the `concluded` and `active` flags,
// the source lifecycle state and the EXPECTED booking payload — and hands it to the pure
// {@link resolveConversationCoordination}. It NEVER re-orchestrates, re-governs, re-resolves, re-recovers, re-verifies,
// re-reconciles, re-derives the fulfilment, re-folds the authorisation or re-runs policy: the routing is R35's, recorded,
// and this runtime reads it. No duplicate orchestration logic; no duplicate coordination logic. Crucially, this runtime
// does NOT call `resolveConversationOrchestration` — it reads R35's RECORDED decision, so the orchestration stays the one
// authority over the routing this engine coordinates.
//
// IT IS DRIVEN BY THE HUMAN'S GRANT, NOT BY A TURN — AND IT RUNS ALONGSIDE R30 + R31 + R32 + R33 + R34 + R35, ON SEND.
// Like the R30, R31, R32, R33, R34 and R35 runtimes, it is invoked from the Human Review SEND path
// ({@link import("@/server/services/receptionist-review").resolveReviewSend}), STRICTLY AFTER a human's `sent` resolution
// is durable, AFTER {@link import("@/server/services/receptionist-fulfilment").fulfilApprovedBooking} has performed the
// booking, AFTER {@link import("@/server/services/receptionist-verification").verifyApprovedFulfilment} has recorded its
// verdict, AFTER {@link import("@/server/services/receptionist-recovery").recoverVerifiedFulfilment} has determined its
// recovery, AFTER {@link import("@/server/services/receptionist-resolution").resolveConversationCompletion} has determined
// its resolution, AFTER {@link import("@/server/services/receptionist-lifecycle").governConversationLifecycle} has
// governed its lifecycle and AFTER
// {@link import("@/server/services/receptionist-orchestration").orchestrateConversationLifecycle} has routed its
// orchestration. That placement is the structural guarantee that Human Review can NEVER be bypassed: there is no other
// caller, and there is no path here that is not downstream of a human's grant and a recorded orchestration.
//
// THE LEDGER ROW IS BOTH THE COORDINATION PLAN AND ITS AUDIT — AND IT IS IDEMPOTENT BY CONSTRUCTION. When the pure core
// decides `coordinate_lifecycle_response` (which it does for a decided orchestration, whatever the routing), this runtime
// files exactly ONE row into the append-only `receptionist_conversation_coordinations` ledger through the single
// service-role-only SECURITY DEFINER primitive `record_receptionist_conversation_coordination` — carrying the MODE
// (finalising / remediating / escalating), the lead PARTICIPANT (conversation_conclusion / recovery_handling /
// human_attention), the participation `participant_count`, the `requires_human` and `autonomous` flags, and threaded to
// the orchestration it was coordinated from (`orchestration_id`, NOT NULL and UNIQUE), the lifecycle that orchestration
// routed (`lifecycle_id`), the resolution that lifecycle was governed from (`resolution_id`), the recovery that
// resolution was determined from (`recovery_id`), the authorisation that recovery traced (`authorisation_id`), the
// verification that recovery classified (`verification_id`), the fulfilment that verification reconciled (`fulfilment_id`,
// NULL when retained/MISSING), the held reply a human approved (`review_audit_id`), the reply that carried the approval
// (`sent_audit_id`), and the human's resolution itself (`review_resolution_id`). The primitive inserts ON CONFLICT
// (orchestration_id) DO NOTHING and returns the existing id, so re-driving the same routed orchestration (a retried
// review-send, a double-fire) coordinates AT MOST ONCE. Idempotency is NOT retry: this runtime attempts the write once
// and lets the ledger make a repeat a no-op; it coordinates no re-attempt (retry is an explicit R36 non-goal).
//
// IT REACHES NO EXTERNAL SYSTEM — THE "COORDINATION" IS THE INTERNAL PLAN. It never writes a booking, never re-books,
// never schedules, never reconciles a record, never enqueues, never notifies, never generates a quote, never promotes a
// lead, never places a call, never reaches a comms provider and never retries — every one is an EXPLICIT R36 non-goal.
// The confirmation the customer received is STILL produced and audited by the UNCHANGED reply pipeline, the human's grant
// is STILL recorded by the UNCHANGED Human Review architecture, the booking is STILL performed by the UNCHANGED R30
// runtime, verified by the UNCHANGED R31 runtime, its recovery determined by the UNCHANGED R32 runtime, its resolution
// determined by the UNCHANGED R33 runtime, its lifecycle governed by the UNCHANGED R34 runtime and its orchestration
// routed by the UNCHANGED R35 runtime; this runtime records the COORDINATION plan ALONGSIDE them.
//
// IT IS BEST-EFFORT — A COORDINATION WRITE NEVER UNDOES A HUMAN-APPROVED REPLY, ITS FULFILMENT, ITS VERIFICATION, ITS
// RECOVERY, ITS RESOLUTION, ITS LIFECYCLE OR ITS ORCHESTRATION. Like the outcome (R26), action (R27), execution (R28),
// authorisation (R29), fulfilment (R30), verification (R31), recovery (R32), resolution (R33), lifecycle (R34) and
// orchestration (R35) writes, every step here is wrapped and swallowed on failure (logged, never thrown): a durable,
// audited, human-approved confirmation reply — and the booking R30 performed, the verdict R31 recorded, the recovery R32
// determined, the resolution R33 determined, the lifecycle R34 governed and the orchestration R35 routed — must never be
// undone because a coordination row could not be filed. A missing orchestration (the held reply was not a booking
// approval, or R35 recorded nothing), an unrecognised vocabulary, an absent expected payload or a failed ledger write all
// return null — the send still succeeds; the coordination simply went unplanned, which is observable in the logs.
// =====================================================================

/**
 * The inputs {@link coordinateConversationLifecycle} needs to coordinate the response for an approved booking's routed
 * orchestration: the organisation and the full Human Review provenance a human just produced by SENDING a held booking
 * confirmation — the held reply they approved (`review_audit_id`, the JOIN to the recorded orchestration), the reply that
 * carried the approval (`sent_audit_id`) and the human's resolution row (`review_resolution_id`, the grant). Everything
 * else — the orchestration, the lifecycle, the resolution, the recovery, the authorisation, the verification, the
 * fulfilment, the expected booking, the correlation id and the conversation anchors — is resolved from the R35
 * orchestration ledger by the coordination-context reader, so the caller supplies only what the SEND path already holds.
 * (Structurally identical to R30's `FulfilmentTrigger`, R31's `VerificationTrigger`, R32's `RecoveryTrigger`, R33's
 * `ResolutionTrigger`, R34's `LifecycleTrigger` and R35's `OrchestrationTrigger` — the SEND path passes the SAME
 * provenance to all seven engines.)
 */
export type CoordinationTrigger = {
  /** The organisation the approved booking belongs to. */
  org_id: string;
  /** The held reply's `ai_reply_audits` id a human approved — the JOIN to the recorded orchestration. */
  review_audit_id: string;
  /** The `ai_reply_audits` id of the reply that CARRIED the human's approval to the customer. */
  sent_audit_id: string;
  /** The `receptionist_review_resolutions` id of the human's `sent` resolution — the grant that authorised this. */
  review_resolution_id: string;
};

/** The durable reference to a recorded coordination — the ledger row id, its type, its outcome, its mode, its lead, its plan and flags. */
export type RecordedCoordination = {
  /** The id of the append-only `receptionist_conversation_coordinations` row (stable across idempotent repeats). */
  coordination_id: string;
  /** The coordination type that was coordinated. */
  coordination_type: ConversationCoordinationType;
  /** The coordinated outcome (`conversation_response_coordinated`). */
  coordination_outcome: CoordinationOutcome;
  /** The MODE by which the response is coordinated (`finalising` / `remediating` / `escalating`). */
  coordination_mode: CoordinationMode;
  /** The lead capability the coordinated response centres on (`conversation_conclusion` / `recovery_handling` / `human_attention`). */
  lead_participant: CoordinationParticipant;
  /** The cardinality of the participation plan (1 for the first, lifecycle implementation). */
  participant_count: number;
  /** Whether the coordinated response requires a human (true iff the lead is `human_attention`). */
  requires_human: boolean;
  /** Whether the coordinated response is autonomous (true iff the lead is NOT `human_attention`). */
  autonomous: boolean;
  /** The SOURCE orchestration route the coordination coordinated (`conclude` / `recover` / `escalate`). */
  orchestration_route: OrchestrationRoute;
  /** The SOURCE lifecycle state the coordination coordinated (`closed` / `retained` / `escalated`). */
  lifecycle_state: CoordinationLifecycleState;
};

/**
 * One row from the `find_receptionist_coordination_context` reader — R35's RECORDED orchestration routing behind a held
 * reply, so the runtime can reconstruct the {@link OrchestrateLifecycleResponseDecision} verbatim and coordinate it. The
 * enum fields arrive as `text` (the reader is a service-role SECURITY DEFINER function outside the generated types); this
 * runtime narrows them defensively before reconstructing the decision. `fulfilment_id` is NULL exactly when the governed
 * lifecycle behind the orchestration was MISSING (the lifecycle state is `retained`).
 */
type CoordinationContextRow = {
  orchestration_id: string;
  lifecycle_id: string;
  resolution_id: string;
  recovery_id: string;
  authorisation_id: string;
  verification_id: string;
  fulfilment_id: string | null;
  conversation_id: string | null;
  enquiry_id: string | null;
  lead_id: string | null;
  customer_ref: string | null;
  correlation_id: string;
  action_id: string | null;
  execution_id: string | null;
  review_audit_id: string;
  sent_audit_id: string;
  review_resolution_id: string;
  orchestration_type: string;
  orchestration_outcome: string;
  orchestration_route: string;
  orchestration_target: string;
  concluded: boolean;
  active: boolean;
  lifecycle_state: string;
  approval_state: string;
  job_type: string | null;
  postcode: string | null;
  phone_number: string | null;
};

// The two primitives are service-role-only and not in the generated Database types — cast past the typed client, the
// same `as unknown as` convention as `record_receptionist_conversation_orchestration` and the reply ledgers. The
// coordination-context reader is a TABLE-returning function, so its `data` is a row ARRAY.
type FindCoordinationContextRpc = (
  fn: "find_receptionist_coordination_context",
  args: Record<string, unknown>,
) => Promise<{ data: CoordinationContextRow[] | null; error: { message: string } | null }>;
type RecordCoordinationRpc = (
  fn: "record_receptionist_conversation_coordination",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/** Narrow a ledger `text` to the {@link ConversationOrchestrationType}, or null if unrecognised. */
function asOrchestrationType(value: string): ConversationOrchestrationType | null {
  return value === "orchestrate_lifecycle_response" ? value : null;
}

/** Narrow a ledger `text` to an {@link OrchestrationOutcome}, or null if unrecognised. */
function asOrchestrationOutcome(value: string): OrchestrationOutcome | null {
  return value === "conversation_response_orchestrated" ? value : null;
}

/** Narrow a ledger `text` to an {@link OrchestrationRoute}, or null if unrecognised. */
function asOrchestrationRoute(value: string): OrchestrationRoute | null {
  return value === "conclude" || value === "recover" || value === "escalate" ? value : null;
}

/** Narrow a ledger `text` to an {@link OrchestrationTarget}, or null if unrecognised. */
function asOrchestrationTarget(value: string): OrchestrationTarget | null {
  return value === "conversation_conclusion" || value === "recovery_handling" || value === "human_attention"
    ? value
    : null;
}

/** Narrow a ledger `text` to a {@link CoordinationLifecycleState}, or null if unrecognised. */
function asLifecycleState(value: string): CoordinationLifecycleState | null {
  return value === "closed" || value === "retained" || value === "escalated" ? value : null;
}

/**
 * Coordinate the response for the routed orchestration of the approved booking behind a held reply a human just SENT —
 * THE single entry point the Human Review SEND path calls after a `sent` resolution is durable, R30 has performed the
 * booking, R31 has recorded its verdict, R32 has determined its recovery, R33 has determined its resolution, R34 has
 * governed its lifecycle and R35 has routed its orchestration. Resolves, in ONE read through the service-role-only
 * coordination-context reader, R35's RECORDED orchestration routing behind the held reply for `(org_id, review_audit_id)`;
 * reconstructs the R35 {@link OrchestrateLifecycleResponseDecision} verbatim from the recorded columns (never
 * re-orchestrating, never re-governing, never re-resolving, never re-recovering, never re-verifying, never re-deriving the
 * fulfilment or re-folding the authorisation), and hands it to the pure {@link resolveConversationCoordination}. When —
 * and only when — the pure core decides `coordinate_lifecycle_response` (which happens for a decided orchestration, which
 * happens only for an APPROVED, verified, recovered, resolved, governed, routed operation), it files ONE idempotent
 * coordination into the append-only coordination ledger through the service-role-only SECURITY DEFINER primitive.
 *
 * BEST-EFFORT: every failure path returns null and never throws — a durable, human-approved confirmation reply, the
 * booking R30 already performed, the verdict R31 already recorded, the recovery R32 already determined, the resolution R33
 * already determined, the lifecycle R34 already governed and the orchestration R35 already routed are never undone by a
 * coordination write. Returns null when there is no recorded orchestration behind the held reply (the common case: an
 * ordinary review reply, or a booking whose orchestration has not been routed), when the ledger vocabulary or expected
 * payload is unrecognised, or when the ledger write could not be recorded. Returns the {@link RecordedCoordination} (with
 * a STABLE id across idempotent repeats, and the MODE — which may be `remediating` or `escalating`) when the coordination
 * was planned.
 */
export async function coordinateConversationLifecycle(
  input: CoordinationTrigger,
): Promise<RecordedCoordination | null> {
  const admin = createAdminClient();

  try {
    // Resolve R35's RECORDED orchestration routing behind the held reply in one read (service-role reader; reads only
    // the R35 orchestration ledger, never writes). No row ⇒ the held reply had no routed orchestration — nothing to
    // coordinate.
    const finder = admin.rpc.bind(admin) as unknown as FindCoordinationContextRpc;
    const { data: rows, error: findError } = await finder("find_receptionist_coordination_context", {
      p_org_id: input.org_id,
      p_review_audit_id: input.review_audit_id,
    });
    if (findError) {
      console.error("[receptionist] coordination: orchestration context lookup failed", findError.message);
      return null;
    }
    const row = rows?.[0];
    if (!row) return null;

    // Narrow the recorded orchestration vocabulary defensively (the columns are CHECK-constrained in the R35 ledger, so
    // these always succeed for a real row; an unrecognised value means a schema drift we refuse to coordinate over).
    const orchestrationType = asOrchestrationType(row.orchestration_type);
    const orchestrationOutcome = asOrchestrationOutcome(row.orchestration_outcome);
    const orchestrationRoute = asOrchestrationRoute(row.orchestration_route);
    const orchestrationTarget = asOrchestrationTarget(row.orchestration_target);
    const lifecycleState = asLifecycleState(row.lifecycle_state);
    if (
      orchestrationType === null ||
      orchestrationOutcome === null ||
      orchestrationRoute === null ||
      orchestrationTarget === null ||
      lifecycleState === null
    ) {
      console.error("[receptionist] coordination: unrecognised orchestration vocabulary", {
        orchestration_type: row.orchestration_type,
        orchestration_outcome: row.orchestration_outcome,
        orchestration_route: row.orchestration_route,
        orchestration_target: row.orchestration_target,
        lifecycle_state: row.lifecycle_state,
      });
      return null;
    }

    // The EXPECTED booking the orchestration carried (from the R34 lifecycle, from the R33 resolution, from the R32
    // recovery, from the R31 verification, from the R30 decision) — required to reconstruct the decision. R35 requires
    // all three to route an orchestration, so a null here means a schema drift.
    const { job_type: jobType, postcode, phone_number: phoneNumber } = row;
    if (!jobType || !postcode || !phoneNumber) {
      console.error("[receptionist] coordination: recorded orchestration missing booking payload", {
        orchestration_id: row.orchestration_id,
      });
      return null;
    }

    // Reconstruct the R35 orchestration DECISION verbatim from the RECORDED routing — the Orchestration Engine stays
    // authoritative; this runtime consumes its recorded decision, it never re-orchestrates. The reconstructed decision is
    // self-describing (type, outcome, route, target, concluded/active flags, source lifecycle state, expected booking),
    // so the coordination can never drift from the orchestration it coordinates. NOTE: this runtime does NOT call
    // `resolveConversationOrchestration` — it reads R35's RECORDED decision straight from the ledger.
    const orchestration: OrchestrateLifecycleResponseDecision = {
      kind: orchestrationType,
      outcome: orchestrationOutcome,
      route: orchestrationRoute,
      target: orchestrationTarget,
      concluded: row.concluded,
      active: row.active,
      lifecycle_state: lifecycleState,
      booking: { kind: "prepare_booking", job_type: jobType, postcode, phone_number: phoneNumber },
    };

    // THE PURE DECISION — coordinate the orchestration's routing into a participation plan. DEFERS if the orchestration
    // was not decided (unreachable for a RECORDED row — an orchestration row exists only for a decided orchestration —
    // but the gate keeps the pure core authoritative). Otherwise it coordinates the routing: `conclude` ⇒
    // `finalising`/`conversation_conclusion`, `recover` ⇒ `remediating`/`recovery_handling`, `escalate` ⇒
    // `escalating`/`human_attention`. A record is produced for all three.
    const decision = resolveConversationCoordination(orchestration);
    if (!isCoordinationDecided(decision)) return null;

    // RECORD the coordination — file ONE idempotent row through the service-role-only SECURITY DEFINER primitive. ON
    // CONFLICT (orchestration_id) DO NOTHING makes a repeat a no-op returning the existing id, so the coordination is
    // planned AT MOST ONCE. Every anchor is threaded from the RECORDED orchestration (not the trigger), so the
    // coordination's provenance exactly matches the orchestration it was coordinated from; `p_fulfilment_id` is the
    // joined fulfilment id (null when retained/MISSING) — the storage-layer coherence CHECK binds it to the source state.
    const writer = admin.rpc.bind(admin) as unknown as RecordCoordinationRpc;
    const { data, error } = await writer("record_receptionist_conversation_coordination", {
      p_org_id: input.org_id,
      p_orchestration_id: row.orchestration_id,
      p_lifecycle_id: row.lifecycle_id,
      p_resolution_id: row.resolution_id,
      p_recovery_id: row.recovery_id,
      p_authorisation_id: row.authorisation_id,
      p_verification_id: row.verification_id,
      p_coordination_type: decision.kind,
      p_coordination_outcome: decision.outcome,
      p_coordination_mode: decision.mode,
      p_lead_participant: decision.lead_participant,
      p_participant_count: decision.participant_count,
      p_requires_human: decision.requires_human,
      p_autonomous: decision.autonomous,
      p_orchestration_route: decision.orchestration_route,
      p_lifecycle_state: decision.lifecycle_state,
      p_approval_state: row.approval_state,
      p_correlation_id: row.correlation_id,
      p_review_audit_id: row.review_audit_id,
      p_sent_audit_id: row.sent_audit_id,
      p_review_resolution_id: row.review_resolution_id,
      p_fulfilment_id: row.fulfilment_id,
      p_conversation_id: row.conversation_id,
      p_enquiry_id: row.enquiry_id,
      p_lead_id: row.lead_id,
      p_customer_ref: row.customer_ref,
      p_action_id: row.action_id,
      p_execution_id: row.execution_id,
      // The EXPECTED booking payload — read straight from the DECISION (which carried it through from the recorded
      // orchestration), so the coordination row records what the coordination concerns, never a recorded drift.
      p_job_type: decision.booking.job_type,
      p_postcode: decision.booking.postcode,
      p_phone_number: decision.booking.phone_number,
      p_metadata: {},
    });
    if (error || !data) {
      console.error("[receptionist] conversation coordination ledger write failed", error?.message ?? null);
      return null;
    }
    return {
      coordination_id: data,
      coordination_type: decision.kind,
      coordination_outcome: decision.outcome,
      coordination_mode: decision.mode,
      lead_participant: decision.lead_participant,
      participant_count: decision.participant_count,
      requires_human: decision.requires_human,
      autonomous: decision.autonomous,
      orchestration_route: decision.orchestration_route,
      lifecycle_state: decision.lifecycle_state,
    };
  } catch (e) {
    console.error("[receptionist] conversation coordination threw", e);
    return null;
  }
}
