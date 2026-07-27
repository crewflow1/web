import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveConversationLifecycle,
  isLifecycleDecided,
  type ConversationLifecycleType,
  type LifecycleOutcome,
  type LifecycleTransition,
  type LifecycleState,
} from "@/lib/receptionist/conversation-lifecycle";
import {
  type ResolveBookingRecoveryDecision,
  type ConversationResolutionType,
  type ResolutionOutcome,
  type ResolutionState,
} from "@/lib/receptionist/conversation-resolution";
import { type RecoveryClassification } from "@/lib/receptionist/conversation-recovery";

// =====================================================================
// THE CONVERSATION LIFECYCLE ENGINE — SERVER RUNTIME (CEO Directive #018, R34: CONVERSATION LIFECYCLE ENGINE).
//
// The pure core (lib/receptionist/conversation-lifecycle.ts) GOVERNS a lifecycle DECISION from an already-decided R33
// resolution — it GOVERNS the resolution disposition into the conversation-lifecycle transition it undergoes (close /
// retain / escalate) and the state it comes to rest in (closed / retained / escalated), and reports WHETHER the
// conversation is closed and WHETHER it remains ongoing, but it deliberately PERSISTS NOTHING and reaches NO I/O. This
// module is the engine's SERVER RUNTIME, and it does exactly ONE thing: when a human APPROVES a held booking
// confirmation (a `sent` resolution in the EXISTING Human Review inbox), AFTER the Fulfilment Engine (R30) has
// performed the approved booking, the Verification Engine (R31) has VERIFIED it, the Recovery Engine (R32) has
// DETERMINED its recovery and the Resolution Engine (R33) has DETERMINED its resolution, it GOVERNS the conversation's
// lifecycle — it reads R33's RECORDED resolution disposition, governs it, and files one durable, append-only,
// IDEMPOTENT lifecycle governance — and STOPS.
//
// IT GOVERNS THE LIFECYCLE — IT NEVER EXECUTES BUSINESS ACTIONS. Unlike the R30 runtime (which MATERIALISES an approved
// booking as an internal record), this runtime closes nothing, retains nothing, escalates nothing, re-books nothing,
// retries nothing, reconciles nothing, schedules nothing, reaches NO provider and pages NO one. It GOVERNS a resolution
// disposition into the lifecycle transition it implies and records the {@link LifecycleState} it comes to rest in. It
// is the layer that turns R33's actionable RESOLUTION disposition into an auditable, single-authority
// CONVERSATION-LIFECYCLE verdict — the transition a future, explicitly-authorised operational capability reads to know
// what becomes of a conversation. Recovery execution, automatic retries and automatic scheduling are EXPLICIT R34
// non-goals; NOTHING here performs them.
//
// THE RESOLUTION ENGINE REMAINS AUTHORITATIVE — THIS RUNTIME CONSUMES ITS RECORDED DECISION, IT NEVER RE-DERIVES IT.
// It resolves, in ONE read through the single service-role-only LIFECYCLE-CONTEXT READER
// `find_receptionist_lifecycle_context`, R33's RECORDED resolution disposition behind the held reply (from the R33
// `receptionist_conversation_resolutions` ledger). It RECONSTRUCTS the R33 {@link ResolveBookingRecoveryDecision}
// verbatim from the recorded columns — the type, the outcome, the STATE, the `terminal` and `intervention_required`
// flags, the source recovery classification and the EXPECTED booking payload — and hands it to the pure
// {@link resolveConversationLifecycle}. It NEVER re-resolves, re-recovers, re-verifies, re-reconciles, re-derives the
// fulfilment, re-folds the authorisation or re-runs policy: the disposition is R33's, recorded, and this runtime reads
// it. No duplicate resolution logic; no duplicate lifecycle logic.
//
// IT IS DRIVEN BY THE HUMAN'S GRANT, NOT BY A TURN — AND IT RUNS ALONGSIDE R30 + R31 + R32 + R33, ON SEND. Like the
// R30, R31, R32 and R33 runtimes, it is invoked from the Human Review SEND path
// ({@link import("@/server/services/receptionist-review").resolveReviewSend}), STRICTLY AFTER a human's `sent`
// resolution is durable, AFTER {@link import("@/server/services/receptionist-fulfilment").fulfilApprovedBooking} has
// performed the booking, AFTER {@link import("@/server/services/receptionist-verification").verifyApprovedFulfilment}
// has recorded its verdict, AFTER
// {@link import("@/server/services/receptionist-recovery").recoverVerifiedFulfilment} has determined its recovery and
// AFTER {@link import("@/server/services/receptionist-resolution").resolveConversationCompletion} has determined its
// resolution. That placement is the structural guarantee that Human Review can NEVER be bypassed: there is no other
// caller, and there is no path here that is not downstream of a human's grant and a recorded resolution.
//
// THE LEDGER ROW IS BOTH THE LIFECYCLE STATE AND ITS AUDIT — AND IT IS IDEMPOTENT BY CONSTRUCTION. When the pure core
// decides `govern_resolution_lifecycle` (which it does for a decided resolution, whatever the disposition), this
// runtime files exactly ONE row into the append-only `receptionist_conversation_lifecycles` ledger through the single
// service-role-only SECURITY DEFINER primitive `record_receptionist_conversation_lifecycle` — carrying the TRANSITION
// (close / retain / escalate), the STATE (closed / retained / escalated), the `closed` and `ongoing` flags and threaded
// to the resolution it was governed from (`resolution_id`, NOT NULL and UNIQUE), the recovery that resolution was
// determined from (`recovery_id`), the authorisation that recovery traced (`authorisation_id`), the verification that
// recovery classified (`verification_id`), the fulfilment that verification reconciled (`fulfilment_id`, NULL when
// recoverable/MISSING), the held reply a human approved (`review_audit_id`), the reply that carried the approval
// (`sent_audit_id`), and the human's resolution itself (`review_resolution_id`). The primitive inserts ON CONFLICT
// (resolution_id) DO NOTHING and returns the existing id, so re-driving the same determined resolution (a retried
// review-send, a double-fire) governs the lifecycle AT MOST ONCE. Idempotency is NOT retry: this runtime attempts the
// write once and lets the ledger make a repeat a no-op; it orchestrates no re-attempt (retry is an explicit R34
// non-goal).
//
// IT REACHES NO EXTERNAL SYSTEM — THE "GOVERNANCE" IS THE INTERNAL DETERMINATION. It never writes a booking, never
// re-books, never schedules, never reconciles a record, never generates a quote, never promotes a lead, never places a
// call, never reaches a comms provider and never retries — every one is an EXPLICIT R34 non-goal. The confirmation the
// customer received is STILL produced and audited by the UNCHANGED reply pipeline, the human's grant is STILL recorded
// by the UNCHANGED Human Review architecture, the booking is STILL performed by the UNCHANGED R30 runtime, verified by
// the UNCHANGED R31 runtime, its recovery determined by the UNCHANGED R32 runtime and its resolution determined by the
// UNCHANGED R33 runtime; this runtime records the LIFECYCLE state ALONGSIDE them.
//
// IT IS BEST-EFFORT — A LIFECYCLE WRITE NEVER UNDOES A HUMAN-APPROVED REPLY, ITS FULFILMENT, ITS VERIFICATION, ITS
// RECOVERY OR ITS RESOLUTION. Like the outcome (R26), action (R27), execution (R28), authorisation (R29), fulfilment
// (R30), verification (R31), recovery (R32) and resolution (R33) writes, every step here is wrapped and swallowed on
// failure (logged, never thrown): a durable, audited, human-approved confirmation reply — and the booking R30
// performed, the verdict R31 recorded, the recovery R32 determined and the resolution R33 determined — must never be
// undone because a lifecycle row could not be filed. A missing resolution (the held reply was not a booking approval,
// or R33 recorded nothing), an unrecognised vocabulary, an absent expected payload or a failed ledger write all return
// null — the send still succeeds; the lifecycle simply went ungoverned, which is observable in the logs.
// =====================================================================

/**
 * The inputs {@link governConversationLifecycle} needs to govern the lifecycle for an approved booking's determined
 * resolution: the organisation and the full Human Review provenance a human just produced by SENDING a held booking
 * confirmation — the held reply they approved (`review_audit_id`, the JOIN to the recorded resolution), the reply that
 * carried the approval (`sent_audit_id`) and the human's resolution row (`review_resolution_id`, the grant). Everything
 * else — the resolution, the recovery, the authorisation, the verification, the fulfilment, the expected booking, the
 * correlation id and the conversation anchors — is resolved from the R33 resolution ledger by the lifecycle-context
 * reader, so the caller supplies only what the SEND path already holds. (Structurally identical to R30's
 * `FulfilmentTrigger`, R31's `VerificationTrigger`, R32's `RecoveryTrigger` and R33's `ResolutionTrigger` — the SEND
 * path passes the SAME provenance to all five engines.)
 */
export type LifecycleTrigger = {
  /** The organisation the approved booking belongs to. */
  org_id: string;
  /** The held reply's `ai_reply_audits` id a human approved — the JOIN to the recorded resolution. */
  review_audit_id: string;
  /** The `ai_reply_audits` id of the reply that CARRIED the human's approval to the customer. */
  sent_audit_id: string;
  /** The `receptionist_review_resolutions` id of the human's `sent` resolution — the grant that authorised this. */
  review_resolution_id: string;
};

/** The durable reference to a recorded lifecycle — the ledger row id, its type, its outcome, its transition, its state and flags. */
export type RecordedLifecycle = {
  /** The id of the append-only `receptionist_conversation_lifecycles` row (stable across idempotent repeats). */
  lifecycle_id: string;
  /** The lifecycle type that was governed. */
  lifecycle_type: ConversationLifecycleType;
  /** The governed outcome (`conversation_lifecycle_governed`). */
  lifecycle_outcome: LifecycleOutcome;
  /** The TRANSITION the conversation undergoes (`close` / `retain` / `escalate`). */
  lifecycle_transition: LifecycleTransition;
  /** The STATE the conversation comes to rest in (`closed` / `retained` / `escalated`). */
  lifecycle_state: LifecycleState;
  /** Whether the conversation is closed (true iff the state is `closed`). */
  closed: boolean;
  /** Whether the conversation remains ongoing (true iff the state is not `closed`). */
  ongoing: boolean;
};

/**
 * One row from the `find_receptionist_lifecycle_context` reader — R33's RECORDED resolution disposition behind a held
 * reply, so the runtime can reconstruct the {@link ResolveBookingRecoveryDecision} verbatim and govern it. The enum
 * fields arrive as `text` (the reader is a service-role SECURITY DEFINER function outside the generated types); this
 * runtime narrows them defensively before reconstructing the decision. `fulfilment_id` is NULL exactly when the
 * resolved operation was MISSING (the resolution state is `recoverable`).
 */
type LifecycleContextRow = {
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
  resolution_type: string;
  resolution_outcome: string;
  resolution_state: string;
  terminal: boolean;
  intervention_required: boolean;
  recovery_classification: string;
  approval_state: string;
  job_type: string | null;
  postcode: string | null;
  phone_number: string | null;
};

// The two primitives are service-role-only and not in the generated Database types — cast past the typed client, the
// same `as unknown as` convention as `record_receptionist_conversation_resolution` and the reply ledgers. The
// lifecycle-context reader is a TABLE-returning function, so its `data` is a row ARRAY.
type FindLifecycleContextRpc = (
  fn: "find_receptionist_lifecycle_context",
  args: Record<string, unknown>,
) => Promise<{ data: LifecycleContextRow[] | null; error: { message: string } | null }>;
type RecordLifecycleRpc = (
  fn: "record_receptionist_conversation_lifecycle",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/** Narrow a ledger `text` to the {@link ConversationResolutionType}, or null if unrecognised. */
function asResolutionType(value: string): ConversationResolutionType | null {
  return value === "resolve_booking_recovery" ? value : null;
}

/** Narrow a ledger `text` to a {@link ResolutionOutcome}, or null if unrecognised. */
function asResolutionOutcome(value: string): ResolutionOutcome | null {
  return value === "conversation_resolution_determined" ? value : null;
}

/** Narrow a ledger `text` to a {@link ResolutionState}, or null if unrecognised. */
function asResolutionState(value: string): ResolutionState | null {
  return value === "terminal" || value === "recoverable" || value === "unresolved" ? value : null;
}

/** Narrow a ledger `text` to a {@link RecoveryClassification}, or null if unrecognised. */
function asRecoveryClassification(value: string): RecoveryClassification | null {
  return value === "none" || value === "reinstate" || value === "reconcile" ? value : null;
}

/**
 * Govern the lifecycle for the determined resolution of the approved booking behind a held reply a human just SENT —
 * THE single entry point the Human Review SEND path calls after a `sent` resolution is durable, R30 has performed the
 * booking, R31 has recorded its verdict, R32 has determined its recovery and R33 has determined its resolution.
 * Resolves, in ONE read through the service-role-only lifecycle-context reader, R33's RECORDED resolution disposition
 * for `(org_id, review_audit_id)`; reconstructs the R33 {@link ResolveBookingRecoveryDecision} verbatim from the
 * recorded columns (never re-resolving, never re-recovering, never re-verifying, never re-deriving the fulfilment or
 * re-folding the authorisation), and hands it to the pure {@link resolveConversationLifecycle}. When — and only when —
 * the pure core decides `govern_resolution_lifecycle` (which happens for a decided resolution, which happens only for
 * an APPROVED, verified, recovered, resolved operation), it files ONE idempotent governance into the append-only
 * lifecycle ledger through the service-role-only SECURITY DEFINER primitive.
 *
 * BEST-EFFORT: every failure path returns null and never throws — a durable, human-approved confirmation reply, the
 * booking R30 already performed, the verdict R31 already recorded, the recovery R32 already determined and the
 * resolution R33 already determined are never undone by a lifecycle write. Returns null when there is no recorded
 * resolution behind the held reply (the common case: an ordinary review reply, or a booking whose resolution has not
 * been recorded), when the ledger vocabulary or expected payload is unrecognised, or when the ledger write could not be
 * recorded. Returns the {@link RecordedLifecycle} (with a STABLE id across idempotent repeats, and the STATE — which
 * may be `retained` or `escalated`) when the lifecycle was governed.
 */
export async function governConversationLifecycle(
  input: LifecycleTrigger,
): Promise<RecordedLifecycle | null> {
  const admin = createAdminClient();

  try {
    // Resolve R33's RECORDED resolution disposition behind the held reply in one read (service-role reader; reads only
    // the R33 resolution ledger, never writes). No row ⇒ the held reply had no recorded resolution — nothing to govern.
    const finder = admin.rpc.bind(admin) as unknown as FindLifecycleContextRpc;
    const { data: rows, error: findError } = await finder("find_receptionist_lifecycle_context", {
      p_org_id: input.org_id,
      p_review_audit_id: input.review_audit_id,
    });
    if (findError) {
      console.error("[receptionist] lifecycle: resolution context lookup failed", findError.message);
      return null;
    }
    const row = rows?.[0];
    if (!row) return null;

    // Narrow the recorded resolution vocabulary defensively (the columns are CHECK-constrained in the R33 ledger, so
    // these always succeed for a real row; an unrecognised value means a schema drift we refuse to govern over).
    const resolutionType = asResolutionType(row.resolution_type);
    const resolutionOutcome = asResolutionOutcome(row.resolution_outcome);
    const resolutionState = asResolutionState(row.resolution_state);
    const classification = asRecoveryClassification(row.recovery_classification);
    if (resolutionType === null || resolutionOutcome === null || resolutionState === null || classification === null) {
      console.error("[receptionist] lifecycle: unrecognised resolution vocabulary", {
        resolution_type: row.resolution_type,
        resolution_outcome: row.resolution_outcome,
        resolution_state: row.resolution_state,
        recovery_classification: row.recovery_classification,
      });
      return null;
    }

    // The EXPECTED booking the resolution carried (from the R32 recovery, from the R31 verification, from the R30
    // decision) — required to reconstruct the decision. R33 requires all three to record a resolution, so a null here
    // means a schema drift.
    const { job_type: jobType, postcode, phone_number: phoneNumber } = row;
    if (!jobType || !postcode || !phoneNumber) {
      console.error("[receptionist] lifecycle: recorded resolution missing booking payload", {
        resolution_id: row.resolution_id,
      });
      return null;
    }

    // Reconstruct the R33 resolution DECISION verbatim from the RECORDED disposition — the Resolution Engine stays
    // authoritative; this runtime consumes its recorded decision, it never re-resolves. The reconstructed decision is
    // self-describing (type, outcome, state, terminal/intervention flags, source classification, expected booking), so
    // the lifecycle can never drift from the resolution it governs.
    const resolution: ResolveBookingRecoveryDecision = {
      kind: resolutionType,
      outcome: resolutionOutcome,
      state: resolutionState,
      terminal: row.terminal,
      intervention_required: row.intervention_required,
      classification,
      booking: { kind: "prepare_booking", job_type: jobType, postcode, phone_number: phoneNumber },
    };

    // THE PURE DECISION — govern the resolution disposition into the lifecycle transition it implies. DEFERS if the
    // resolution was not decided (unreachable for a RECORDED row — a resolution row exists only for a decided
    // resolution — but the gate keeps the pure core authoritative). Otherwise it governs the disposition: `terminal` ⇒
    // `close`/`closed`, `recoverable` ⇒ `retain`/`retained`, `unresolved` ⇒ `escalate`/`escalated`. A record is
    // produced for all three.
    const decision = resolveConversationLifecycle(resolution);
    if (!isLifecycleDecided(decision)) return null;

    // RECORD the lifecycle governance — file ONE idempotent row through the service-role-only SECURITY DEFINER
    // primitive. ON CONFLICT (resolution_id) DO NOTHING makes a repeat a no-op returning the existing id, so the
    // lifecycle is governed AT MOST ONCE. Every anchor is threaded from the RECORDED resolution (not the trigger), so
    // the lifecycle's provenance exactly matches the resolution it was governed from; `p_fulfilment_id` is the joined
    // fulfilment id (null when recoverable/MISSING) — the storage-layer coherence CHECK binds it to the source state.
    const writer = admin.rpc.bind(admin) as unknown as RecordLifecycleRpc;
    const { data, error } = await writer("record_receptionist_conversation_lifecycle", {
      p_org_id: input.org_id,
      p_resolution_id: row.resolution_id,
      p_recovery_id: row.recovery_id,
      p_authorisation_id: row.authorisation_id,
      p_verification_id: row.verification_id,
      p_lifecycle_type: decision.kind,
      p_lifecycle_outcome: decision.outcome,
      p_lifecycle_transition: decision.transition,
      p_lifecycle_state: decision.state,
      p_closed: decision.closed,
      p_ongoing: decision.ongoing,
      p_resolution_state: decision.resolution_state,
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
      // resolution), so the lifecycle row records what the resolution concerns, never a recorded drift.
      p_job_type: decision.booking.job_type,
      p_postcode: decision.booking.postcode,
      p_phone_number: decision.booking.phone_number,
      p_metadata: {},
    });
    if (error || !data) {
      console.error("[receptionist] conversation lifecycle ledger write failed", error?.message ?? null);
      return null;
    }
    return {
      lifecycle_id: data,
      lifecycle_type: decision.kind,
      lifecycle_outcome: decision.outcome,
      lifecycle_transition: decision.transition,
      lifecycle_state: decision.state,
      closed: decision.closed,
      ongoing: decision.ongoing,
    };
  } catch (e) {
    console.error("[receptionist] conversation lifecycle threw", e);
    return null;
  }
}
