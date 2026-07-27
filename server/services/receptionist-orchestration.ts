import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveConversationOrchestration,
  isOrchestrationDecided,
  type ConversationOrchestrationType,
  type OrchestrationOutcome,
  type OrchestrationRoute,
  type OrchestrationTarget,
} from "@/lib/receptionist/conversation-orchestration";
import {
  type GovernResolutionLifecycleDecision,
  type ConversationLifecycleType,
  type LifecycleOutcome,
  type LifecycleTransition,
  type LifecycleState,
} from "@/lib/receptionist/conversation-lifecycle";
import { type ResolutionState } from "@/lib/receptionist/conversation-resolution";

// =====================================================================
// THE CONVERSATION ORCHESTRATION ENGINE — SERVER RUNTIME (CEO Directive #018, R35: CONVERSATION ORCHESTRATION ENGINE).
//
// The pure core (lib/receptionist/conversation-orchestration.ts) ROUTES an orchestration DECISION from an already-governed
// R34 lifecycle — it ROUTES the lifecycle disposition to the platform capability that should RESPOND (conclude / recover
// / escalate) and the target it routes to (conversation_conclusion / recovery_handling / human_attention), and reports
// WHETHER the conversation's orchestration is concluded and WHETHER an active capability response is routed, but it
// deliberately PERSISTS NOTHING and reaches NO I/O. This module is the engine's SERVER RUNTIME, and it does exactly ONE
// thing: when a human APPROVES a held booking confirmation (a `sent` resolution in the EXISTING Human Review inbox),
// AFTER the Fulfilment Engine (R30) has performed the approved booking, the Verification Engine (R31) has VERIFIED it,
// the Recovery Engine (R32) has DETERMINED its recovery, the Resolution Engine (R33) has DETERMINED its resolution and
// the Lifecycle Engine (R34) has GOVERNED its lifecycle, it ORCHESTRATES the conversation's response — it reads R34's
// RECORDED lifecycle disposition, routes it, and files one durable, append-only, IDEMPOTENT orchestration — and STOPS.
//
// IT ROUTES WORK — IT NEVER EXECUTES WORK. Unlike the R30 runtime (which MATERIALISES an approved booking as an internal
// record), this runtime concludes nothing, recovers nothing, escalates nothing, enqueues nothing, notifies no one,
// re-books nothing, retries nothing, schedules nothing, reaches NO provider and pages NO one. It ROUTES a lifecycle
// disposition to the capability that should respond and records the {@link OrchestrationTarget} it routes to. It is the
// layer that turns R34's governed LIFECYCLE state into an auditable, single-authority ROUTING verdict — the routing a
// future, explicitly-authorised operational capability (a queue, a dashboard, an automation) reads to know which
// capability should respond to a conversation. Human work queues, dashboard UI, notification sending, automatic retries
// and automatic scheduling are EXPLICIT R35 non-goals; NOTHING here performs them.
//
// THE LIFECYCLE ENGINE REMAINS AUTHORITATIVE — THIS RUNTIME CONSUMES ITS RECORDED DECISION, IT NEVER RE-DERIVES IT.
// It resolves, in ONE read through the single service-role-only ORCHESTRATION-CONTEXT READER
// `find_receptionist_orchestration_context`, R34's RECORDED lifecycle disposition behind the held reply (from the R34
// `receptionist_conversation_lifecycles` ledger). It RECONSTRUCTS the R34 {@link GovernResolutionLifecycleDecision}
// verbatim from the recorded columns — the type, the outcome, the TRANSITION, the STATE, the `closed` and `ongoing`
// flags, the source resolution state and the EXPECTED booking payload — and hands it to the pure
// {@link resolveConversationOrchestration}. It NEVER re-governs, re-resolves, re-recovers, re-verifies, re-reconciles,
// re-derives the fulfilment, re-folds the authorisation or re-runs policy: the disposition is R34's, recorded, and this
// runtime reads it. No duplicate lifecycle logic; no duplicate orchestration logic.
//
// IT IS DRIVEN BY THE HUMAN'S GRANT, NOT BY A TURN — AND IT RUNS ALONGSIDE R30 + R31 + R32 + R33 + R34, ON SEND. Like
// the R30, R31, R32, R33 and R34 runtimes, it is invoked from the Human Review SEND path
// ({@link import("@/server/services/receptionist-review").resolveReviewSend}), STRICTLY AFTER a human's `sent`
// resolution is durable, AFTER {@link import("@/server/services/receptionist-fulfilment").fulfilApprovedBooking} has
// performed the booking, AFTER {@link import("@/server/services/receptionist-verification").verifyApprovedFulfilment}
// has recorded its verdict, AFTER {@link import("@/server/services/receptionist-recovery").recoverVerifiedFulfilment}
// has determined its recovery, AFTER
// {@link import("@/server/services/receptionist-resolution").resolveConversationCompletion} has determined its
// resolution and AFTER {@link import("@/server/services/receptionist-lifecycle").governConversationLifecycle} has
// governed its lifecycle. That placement is the structural guarantee that Human Review can NEVER be bypassed: there is
// no other caller, and there is no path here that is not downstream of a human's grant and a recorded lifecycle.
//
// THE LEDGER ROW IS BOTH THE ORCHESTRATION ROUTE AND ITS AUDIT — AND IT IS IDEMPOTENT BY CONSTRUCTION. When the pure
// core decides `orchestrate_lifecycle_response` (which it does for a decided lifecycle, whatever the disposition), this
// runtime files exactly ONE row into the append-only `receptionist_conversation_orchestrations` ledger through the
// single service-role-only SECURITY DEFINER primitive `record_receptionist_conversation_orchestration` — carrying the
// ROUTE (conclude / recover / escalate), the TARGET (conversation_conclusion / recovery_handling / human_attention), the
// `concluded` and `active` flags and threaded to the lifecycle it was routed from (`lifecycle_id`, NOT NULL and UNIQUE),
// the resolution that lifecycle was governed from (`resolution_id`), the recovery that resolution was determined from
// (`recovery_id`), the authorisation that recovery traced (`authorisation_id`), the verification that recovery
// classified (`verification_id`), the fulfilment that verification reconciled (`fulfilment_id`, NULL when
// retained/MISSING), the held reply a human approved (`review_audit_id`), the reply that carried the approval
// (`sent_audit_id`), and the human's resolution itself (`review_resolution_id`). The primitive inserts ON CONFLICT
// (lifecycle_id) DO NOTHING and returns the existing id, so re-driving the same governed lifecycle (a retried
// review-send, a double-fire) orchestrates AT MOST ONCE. Idempotency is NOT retry: this runtime attempts the write once
// and lets the ledger make a repeat a no-op; it orchestrates no re-attempt (retry is an explicit R35 non-goal).
//
// IT REACHES NO EXTERNAL SYSTEM — THE "ORCHESTRATION" IS THE INTERNAL ROUTING. It never writes a booking, never
// re-books, never schedules, never reconciles a record, never enqueues, never notifies, never generates a quote, never
// promotes a lead, never places a call, never reaches a comms provider and never retries — every one is an EXPLICIT R35
// non-goal. The confirmation the customer received is STILL produced and audited by the UNCHANGED reply pipeline, the
// human's grant is STILL recorded by the UNCHANGED Human Review architecture, the booking is STILL performed by the
// UNCHANGED R30 runtime, verified by the UNCHANGED R31 runtime, its recovery determined by the UNCHANGED R32 runtime,
// its resolution determined by the UNCHANGED R33 runtime and its lifecycle governed by the UNCHANGED R34 runtime; this
// runtime records the ORCHESTRATION route ALONGSIDE them.
//
// IT IS BEST-EFFORT — AN ORCHESTRATION WRITE NEVER UNDOES A HUMAN-APPROVED REPLY, ITS FULFILMENT, ITS VERIFICATION, ITS
// RECOVERY, ITS RESOLUTION OR ITS LIFECYCLE. Like the outcome (R26), action (R27), execution (R28), authorisation (R29),
// fulfilment (R30), verification (R31), recovery (R32), resolution (R33) and lifecycle (R34) writes, every step here is
// wrapped and swallowed on failure (logged, never thrown): a durable, audited, human-approved confirmation reply — and
// the booking R30 performed, the verdict R31 recorded, the recovery R32 determined, the resolution R33 determined and
// the lifecycle R34 governed — must never be undone because an orchestration row could not be filed. A missing lifecycle
// (the held reply was not a booking approval, or R34 recorded nothing), an unrecognised vocabulary, an absent expected
// payload or a failed ledger write all return null — the send still succeeds; the orchestration simply went unrouted,
// which is observable in the logs.
// =====================================================================

/**
 * The inputs {@link orchestrateConversationLifecycle} needs to route the orchestration for an approved booking's governed
 * lifecycle: the organisation and the full Human Review provenance a human just produced by SENDING a held booking
 * confirmation — the held reply they approved (`review_audit_id`, the JOIN to the recorded lifecycle), the reply that
 * carried the approval (`sent_audit_id`) and the human's resolution row (`review_resolution_id`, the grant). Everything
 * else — the lifecycle, the resolution, the recovery, the authorisation, the verification, the fulfilment, the expected
 * booking, the correlation id and the conversation anchors — is resolved from the R34 lifecycle ledger by the
 * orchestration-context reader, so the caller supplies only what the SEND path already holds. (Structurally identical to
 * R30's `FulfilmentTrigger`, R31's `VerificationTrigger`, R32's `RecoveryTrigger`, R33's `ResolutionTrigger` and R34's
 * `LifecycleTrigger` — the SEND path passes the SAME provenance to all six engines.)
 */
export type OrchestrationTrigger = {
  /** The organisation the approved booking belongs to. */
  org_id: string;
  /** The held reply's `ai_reply_audits` id a human approved — the JOIN to the recorded lifecycle. */
  review_audit_id: string;
  /** The `ai_reply_audits` id of the reply that CARRIED the human's approval to the customer. */
  sent_audit_id: string;
  /** The `receptionist_review_resolutions` id of the human's `sent` resolution — the grant that authorised this. */
  review_resolution_id: string;
};

/** The durable reference to a recorded orchestration — the ledger row id, its type, its outcome, its route, its target and flags. */
export type RecordedOrchestration = {
  /** The id of the append-only `receptionist_conversation_orchestrations` row (stable across idempotent repeats). */
  orchestration_id: string;
  /** The orchestration type that was routed. */
  orchestration_type: ConversationOrchestrationType;
  /** The orchestrated outcome (`conversation_response_orchestrated`). */
  orchestration_outcome: OrchestrationOutcome;
  /** The ROUTE by which the conversation is routed (`conclude` / `recover` / `escalate`). */
  orchestration_route: OrchestrationRoute;
  /** The TARGET capability the conversation is routed to (`conversation_conclusion` / `recovery_handling` / `human_attention`). */
  orchestration_target: OrchestrationTarget;
  /** Whether the conversation's orchestration is concluded (true iff the route is `conclude`). */
  concluded: boolean;
  /** Whether an active capability response is routed (true iff the route is not `conclude`). */
  active: boolean;
  /** The SOURCE lifecycle state the orchestration routed (`closed` / `retained` / `escalated`). */
  lifecycle_state: LifecycleState;
};

/**
 * One row from the `find_receptionist_orchestration_context` reader — R34's RECORDED lifecycle disposition behind a held
 * reply, so the runtime can reconstruct the {@link GovernResolutionLifecycleDecision} verbatim and route it. The enum
 * fields arrive as `text` (the reader is a service-role SECURITY DEFINER function outside the generated types); this
 * runtime narrows them defensively before reconstructing the decision. `fulfilment_id` is NULL exactly when the governed
 * lifecycle was MISSING (the lifecycle state is `retained`).
 */
type OrchestrationContextRow = {
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
  lifecycle_type: string;
  lifecycle_outcome: string;
  lifecycle_transition: string;
  lifecycle_state: string;
  closed: boolean;
  ongoing: boolean;
  resolution_state: string;
  approval_state: string;
  job_type: string | null;
  postcode: string | null;
  phone_number: string | null;
};

// The two primitives are service-role-only and not in the generated Database types — cast past the typed client, the
// same `as unknown as` convention as `record_receptionist_conversation_lifecycle` and the reply ledgers. The
// orchestration-context reader is a TABLE-returning function, so its `data` is a row ARRAY.
type FindOrchestrationContextRpc = (
  fn: "find_receptionist_orchestration_context",
  args: Record<string, unknown>,
) => Promise<{ data: OrchestrationContextRow[] | null; error: { message: string } | null }>;
type RecordOrchestrationRpc = (
  fn: "record_receptionist_conversation_orchestration",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/** Narrow a ledger `text` to the {@link ConversationLifecycleType}, or null if unrecognised. */
function asLifecycleType(value: string): ConversationLifecycleType | null {
  return value === "govern_resolution_lifecycle" ? value : null;
}

/** Narrow a ledger `text` to a {@link LifecycleOutcome}, or null if unrecognised. */
function asLifecycleOutcome(value: string): LifecycleOutcome | null {
  return value === "conversation_lifecycle_governed" ? value : null;
}

/** Narrow a ledger `text` to a {@link LifecycleTransition}, or null if unrecognised. */
function asLifecycleTransition(value: string): LifecycleTransition | null {
  return value === "close" || value === "retain" || value === "escalate" ? value : null;
}

/** Narrow a ledger `text` to a {@link LifecycleState}, or null if unrecognised. */
function asLifecycleState(value: string): LifecycleState | null {
  return value === "closed" || value === "retained" || value === "escalated" ? value : null;
}

/** Narrow a ledger `text` to a {@link ResolutionState}, or null if unrecognised. */
function asResolutionState(value: string): ResolutionState | null {
  return value === "terminal" || value === "recoverable" || value === "unresolved" ? value : null;
}

/**
 * Route the orchestration for the governed lifecycle of the approved booking behind a held reply a human just SENT —
 * THE single entry point the Human Review SEND path calls after a `sent` resolution is durable, R30 has performed the
 * booking, R31 has recorded its verdict, R32 has determined its recovery, R33 has determined its resolution and R34 has
 * governed its lifecycle. Resolves, in ONE read through the service-role-only orchestration-context reader, R34's
 * RECORDED lifecycle disposition for `(org_id, review_audit_id)`; reconstructs the R34
 * {@link GovernResolutionLifecycleDecision} verbatim from the recorded columns (never re-governing, never re-resolving,
 * never re-recovering, never re-verifying, never re-deriving the fulfilment or re-folding the authorisation), and hands
 * it to the pure {@link resolveConversationOrchestration}. When — and only when — the pure core decides
 * `orchestrate_lifecycle_response` (which happens for a decided lifecycle, which happens only for an APPROVED, verified,
 * recovered, resolved, governed operation), it files ONE idempotent orchestration into the append-only orchestration
 * ledger through the service-role-only SECURITY DEFINER primitive.
 *
 * BEST-EFFORT: every failure path returns null and never throws — a durable, human-approved confirmation reply, the
 * booking R30 already performed, the verdict R31 already recorded, the recovery R32 already determined, the resolution
 * R33 already determined and the lifecycle R34 already governed are never undone by an orchestration write. Returns null
 * when there is no recorded lifecycle behind the held reply (the common case: an ordinary review reply, or a booking
 * whose lifecycle has not been governed), when the ledger vocabulary or expected payload is unrecognised, or when the
 * ledger write could not be recorded. Returns the {@link RecordedOrchestration} (with a STABLE id across idempotent
 * repeats, and the ROUTE — which may be `recover` or `escalate`) when the orchestration was routed.
 */
export async function orchestrateConversationLifecycle(
  input: OrchestrationTrigger,
): Promise<RecordedOrchestration | null> {
  const admin = createAdminClient();

  try {
    // Resolve R34's RECORDED lifecycle disposition behind the held reply in one read (service-role reader; reads only
    // the R34 lifecycle ledger, never writes). No row ⇒ the held reply had no governed lifecycle — nothing to
    // orchestrate.
    const finder = admin.rpc.bind(admin) as unknown as FindOrchestrationContextRpc;
    const { data: rows, error: findError } = await finder("find_receptionist_orchestration_context", {
      p_org_id: input.org_id,
      p_review_audit_id: input.review_audit_id,
    });
    if (findError) {
      console.error("[receptionist] orchestration: lifecycle context lookup failed", findError.message);
      return null;
    }
    const row = rows?.[0];
    if (!row) return null;

    // Narrow the recorded lifecycle vocabulary defensively (the columns are CHECK-constrained in the R34 ledger, so
    // these always succeed for a real row; an unrecognised value means a schema drift we refuse to route over).
    const lifecycleType = asLifecycleType(row.lifecycle_type);
    const lifecycleOutcome = asLifecycleOutcome(row.lifecycle_outcome);
    const lifecycleTransition = asLifecycleTransition(row.lifecycle_transition);
    const lifecycleState = asLifecycleState(row.lifecycle_state);
    const resolutionState = asResolutionState(row.resolution_state);
    if (
      lifecycleType === null ||
      lifecycleOutcome === null ||
      lifecycleTransition === null ||
      lifecycleState === null ||
      resolutionState === null
    ) {
      console.error("[receptionist] orchestration: unrecognised lifecycle vocabulary", {
        lifecycle_type: row.lifecycle_type,
        lifecycle_outcome: row.lifecycle_outcome,
        lifecycle_transition: row.lifecycle_transition,
        lifecycle_state: row.lifecycle_state,
        resolution_state: row.resolution_state,
      });
      return null;
    }

    // The EXPECTED booking the lifecycle carried (from the R33 resolution, from the R32 recovery, from the R31
    // verification, from the R30 decision) — required to reconstruct the decision. R34 requires all three to govern a
    // lifecycle, so a null here means a schema drift.
    const { job_type: jobType, postcode, phone_number: phoneNumber } = row;
    if (!jobType || !postcode || !phoneNumber) {
      console.error("[receptionist] orchestration: recorded lifecycle missing booking payload", {
        lifecycle_id: row.lifecycle_id,
      });
      return null;
    }

    // Reconstruct the R34 lifecycle DECISION verbatim from the RECORDED disposition — the Lifecycle Engine stays
    // authoritative; this runtime consumes its recorded decision, it never re-governs. The reconstructed decision is
    // self-describing (type, outcome, transition, state, closed/ongoing flags, source resolution state, expected
    // booking), so the orchestration can never drift from the lifecycle it routes.
    const lifecycle: GovernResolutionLifecycleDecision = {
      kind: lifecycleType,
      outcome: lifecycleOutcome,
      transition: lifecycleTransition,
      state: lifecycleState,
      closed: row.closed,
      ongoing: row.ongoing,
      resolution_state: resolutionState,
      booking: { kind: "prepare_booking", job_type: jobType, postcode, phone_number: phoneNumber },
    };

    // THE PURE DECISION — route the lifecycle disposition to the capability that should respond. DEFERS if the lifecycle
    // was not decided (unreachable for a RECORDED row — a lifecycle row exists only for a decided lifecycle — but the
    // gate keeps the pure core authoritative). Otherwise it routes the disposition: `closed` ⇒
    // `conclude`/`conversation_conclusion`, `retained` ⇒ `recover`/`recovery_handling`, `escalated` ⇒
    // `escalate`/`human_attention`. A record is produced for all three.
    const decision = resolveConversationOrchestration(lifecycle);
    if (!isOrchestrationDecided(decision)) return null;

    // RECORD the orchestration — file ONE idempotent row through the service-role-only SECURITY DEFINER primitive. ON
    // CONFLICT (lifecycle_id) DO NOTHING makes a repeat a no-op returning the existing id, so the orchestration is
    // routed AT MOST ONCE. Every anchor is threaded from the RECORDED lifecycle (not the trigger), so the
    // orchestration's provenance exactly matches the lifecycle it was routed from; `p_fulfilment_id` is the joined
    // fulfilment id (null when retained/MISSING) — the storage-layer coherence CHECK binds it to the source state.
    const writer = admin.rpc.bind(admin) as unknown as RecordOrchestrationRpc;
    const { data, error } = await writer("record_receptionist_conversation_orchestration", {
      p_org_id: input.org_id,
      p_lifecycle_id: row.lifecycle_id,
      p_resolution_id: row.resolution_id,
      p_recovery_id: row.recovery_id,
      p_authorisation_id: row.authorisation_id,
      p_verification_id: row.verification_id,
      p_orchestration_type: decision.kind,
      p_orchestration_outcome: decision.outcome,
      p_orchestration_route: decision.route,
      p_orchestration_target: decision.target,
      p_concluded: decision.concluded,
      p_active: decision.active,
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
      // lifecycle), so the orchestration row records what the lifecycle concerns, never a recorded drift.
      p_job_type: decision.booking.job_type,
      p_postcode: decision.booking.postcode,
      p_phone_number: decision.booking.phone_number,
      p_metadata: {},
    });
    if (error || !data) {
      console.error("[receptionist] conversation orchestration ledger write failed", error?.message ?? null);
      return null;
    }
    return {
      orchestration_id: data,
      orchestration_type: decision.kind,
      orchestration_outcome: decision.outcome,
      orchestration_route: decision.route,
      orchestration_target: decision.target,
      concluded: decision.concluded,
      active: decision.active,
      lifecycle_state: decision.lifecycle_state,
    };
  } catch (e) {
    console.error("[receptionist] conversation orchestration threw", e);
    return null;
  }
}
