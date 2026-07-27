import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveConversationResolution,
  isResolutionDecided,
  type ConversationResolutionType,
  type ResolutionOutcome,
  type ResolutionState,
} from "@/lib/receptionist/conversation-resolution";
import {
  type RecoverBookingDecision,
  type ConversationRecoveryType,
  type RecoveryOutcome,
  type RecoveryClassification,
} from "@/lib/receptionist/conversation-recovery";
import { type VerificationIntegrity } from "@/lib/receptionist/conversation-verification";

// =====================================================================
// THE CONVERSATION RESOLUTION ENGINE — SERVER RUNTIME (CEO Directive #018, R33: CONVERSATION RESOLUTION ENGINE).
//
// The pure core (lib/receptionist/conversation-resolution.ts) RESOLVES a resolution DECISION from an already-decided
// R32 recovery — it CLASSIFIES the recovery disposition into the conversation-completion state it implies (terminal /
// recoverable / unresolved) and reports WHETHER the conversation is terminal and WHETHER further intervention is
// required, but it deliberately PERSISTS NOTHING and reaches NO I/O. This module is the engine's SERVER RUNTIME, and
// it does exactly ONE thing: when a human APPROVES a held booking confirmation (a `sent` resolution in the EXISTING
// Human Review inbox), AFTER the Fulfilment Engine (R30) has performed the approved booking, the Verification Engine
// (R31) has VERIFIED it and the Recovery Engine (R32) has DETERMINED its recovery, it DETERMINES the conversation's
// resolution — it reads R32's RECORDED recovery disposition, classifies it, and files one durable, append-only,
// IDEMPOTENT resolution determination — and STOPS.
//
// IT DETERMINES COMPLETION — IT NEVER EXECUTES RECOVERY OR BUSINESS ACTIONS. Unlike the R30 runtime (which MATERIALISES
// an approved booking as an internal record), this runtime re-books nothing, retries nothing, reconciles nothing,
// schedules nothing, reaches NO provider and corrects NO record. It CLASSIFIES a recovery disposition into the
// completion state it implies and records the {@link ResolutionState} it found. It is the layer that turns R32's
// actionable RECOVERY disposition into an auditable, single-authority CONVERSATION-COMPLETION verdict — the
// determination a future, explicitly-authorised operational capability reads to know whether a conversation is done.
// Recovery execution, automatic retries and automatic scheduling are EXPLICIT R33 non-goals; NOTHING here performs
// them.
//
// THE RECOVERY ENGINE REMAINS AUTHORITATIVE — THIS RUNTIME CONSUMES ITS RECORDED DECISION, IT NEVER RE-DERIVES IT.
// It resolves, in ONE read through the single service-role-only RESOLUTION-CONTEXT READER
// `find_receptionist_resolution_context`, R32's RECORDED recovery disposition behind the held reply (from the R32
// `receptionist_conversation_recoveries` ledger). It RECONSTRUCTS the R32 {@link RecoverBookingDecision} verbatim
// from the recorded columns — the type, the outcome, the CLASSIFICATION, the `recovery_required` flag, the source
// integrity verdict and the EXPECTED booking payload — and hands it to the pure {@link resolveConversationResolution}.
// It NEVER re-recovers, re-verifies, re-reconciles, re-derives the fulfilment, re-folds the authorisation or re-runs
// policy: the disposition is R32's, recorded, and this runtime reads it. No duplicate recovery logic; no duplicate
// resolution logic.
//
// IT IS DRIVEN BY THE HUMAN'S GRANT, NOT BY A TURN — AND IT RUNS ALONGSIDE R30 + R31 + R32, ON SEND. Like the R30, R31
// and R32 runtimes, it is invoked from the Human Review SEND path
// ({@link import("@/server/services/receptionist-review").resolveReviewSend}), STRICTLY AFTER a human's `sent`
// resolution is durable, AFTER {@link import("@/server/services/receptionist-fulfilment").fulfilApprovedBooking} has
// performed the booking, AFTER {@link import("@/server/services/receptionist-verification").verifyApprovedFulfilment}
// has recorded its verdict, and AFTER
// {@link import("@/server/services/receptionist-recovery").recoverVerifiedFulfilment} has determined its recovery.
// That placement is the structural guarantee that Human Review can NEVER be bypassed: there is no other caller, and
// there is no path here that is not downstream of a human's grant and a recorded recovery.
//
// THE LEDGER ROW IS BOTH THE RESOLUTION STATE AND ITS AUDIT — AND IT IS IDEMPOTENT BY CONSTRUCTION. When the pure core
// decides `resolve_booking_recovery` (which it does for a decided recovery, whatever the disposition), this runtime
// files exactly ONE row into the append-only `receptionist_conversation_resolutions` ledger through the single
// service-role-only SECURITY DEFINER primitive `record_receptionist_conversation_resolution` — carrying the STATE
// (terminal / recoverable / unresolved), the `terminal` and `intervention_required` flags and threaded to the recovery
// it was determined from (`recovery_id`, NOT NULL and UNIQUE), the authorisation that recovery traced
// (`authorisation_id`), the verification that recovery classified (`verification_id`), the fulfilment that
// verification reconciled (`fulfilment_id`, NULL when recoverable/MISSING), the held reply a human approved
// (`review_audit_id`), the reply that carried the approval (`sent_audit_id`), and the human's resolution itself
// (`review_resolution_id`). The primitive inserts ON CONFLICT (recovery_id) DO NOTHING and returns the existing id, so
// re-driving the same determined recovery (a retried review-send, a double-fire) determines resolution AT MOST ONCE.
// Idempotency is NOT retry: this runtime attempts the write once and lets the ledger make a repeat a no-op; it
// orchestrates no re-attempt (retry is an explicit R33 non-goal).
//
// IT REACHES NO EXTERNAL SYSTEM — THE "RESOLUTION" IS THE INTERNAL DETERMINATION. It never writes a booking, never
// re-books, never schedules, never reconciles a record, never generates a quote, never promotes a lead, never places a
// call, never reaches a comms provider and never retries — every one is an EXPLICIT R33 non-goal. The confirmation the
// customer received is STILL produced and audited by the UNCHANGED reply pipeline, the human's grant is STILL recorded
// by the UNCHANGED Human Review architecture, the booking is STILL performed by the UNCHANGED R30 runtime, verified by
// the UNCHANGED R31 runtime and its recovery determined by the UNCHANGED R32 runtime; this runtime records the
// RESOLUTION state ALONGSIDE them.
//
// IT IS BEST-EFFORT — A RESOLUTION WRITE NEVER UNDOES A HUMAN-APPROVED REPLY, ITS FULFILMENT, ITS VERIFICATION OR ITS
// RECOVERY. Like the outcome (R26), action (R27), execution (R28), authorisation (R29), fulfilment (R30), verification
// (R31) and recovery (R32) writes, every step here is wrapped and swallowed on failure (logged, never thrown): a
// durable, audited, human-approved confirmation reply — and the booking R30 performed, the verdict R31 recorded and
// the recovery R32 determined — must never be undone because a resolution row could not be filed. A missing recovery
// (the held reply was not a booking approval, or R32 recorded nothing), an unrecognised vocabulary, an absent expected
// payload or a failed ledger write all return null — the send still succeeds; the resolution simply went undetermined,
// which is observable in the logs.
// =====================================================================

/**
 * The inputs {@link resolveConversationCompletion} needs to determine the resolution for an approved booking's
 * determined recovery: the organisation and the full Human Review provenance a human just produced by SENDING a held
 * booking confirmation — the held reply they approved (`review_audit_id`, the JOIN to the recorded recovery), the
 * reply that carried the approval (`sent_audit_id`) and the human's resolution row (`review_resolution_id`, the
 * grant). Everything else — the recovery, the authorisation, the verification, the fulfilment, the expected booking,
 * the correlation id and the conversation anchors — is resolved from the R32 recovery ledger by the resolution-context
 * reader, so the caller supplies only what the SEND path already holds. (Structurally identical to R30's
 * `FulfilmentTrigger`, R31's `VerificationTrigger` and R32's `RecoveryTrigger` — the SEND path passes the SAME
 * provenance to all four engines.)
 */
export type ResolutionTrigger = {
  /** The organisation the approved booking belongs to. */
  org_id: string;
  /** The held reply's `ai_reply_audits` id a human approved — the JOIN to the recorded recovery. */
  review_audit_id: string;
  /** The `ai_reply_audits` id of the reply that CARRIED the human's approval to the customer. */
  sent_audit_id: string;
  /** The `receptionist_review_resolutions` id of the human's `sent` resolution — the grant that authorised this. */
  review_resolution_id: string;
};

/** The durable reference to a recorded resolution — the ledger row id, its type, its outcome, its state and flags. */
export type RecordedResolution = {
  /** The id of the append-only `receptionist_conversation_resolutions` row (stable across idempotent repeats). */
  resolution_id: string;
  /** The resolution type that was determined. */
  resolution_type: ConversationResolutionType;
  /** The determined outcome (`conversation_resolution_determined`). */
  resolution_outcome: ResolutionOutcome;
  /** The completion STATE the recovery classified to (`terminal` / `recoverable` / `unresolved`). */
  resolution_state: ResolutionState;
  /** Whether the conversation is terminal (true iff the state is `terminal`). */
  terminal: boolean;
  /** Whether further intervention is required (true iff the state is not `terminal`). */
  intervention_required: boolean;
};

/**
 * One row from the `find_receptionist_resolution_context` reader — R32's RECORDED recovery disposition behind a held
 * reply, so the runtime can reconstruct the {@link RecoverBookingDecision} verbatim and classify it. The enum fields
 * arrive as `text` (the reader is a service-role SECURITY DEFINER function outside the generated types); this runtime
 * narrows them defensively before reconstructing the decision. `fulfilment_id` is NULL exactly when the recovered
 * operation was MISSING (the recovery classification is `reinstate`).
 */
type ResolutionContextRow = {
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
  recovery_type: string;
  recovery_outcome: string;
  recovery_classification: string;
  recovery_required: boolean;
  integrity: string;
  approval_state: string;
  job_type: string | null;
  postcode: string | null;
  phone_number: string | null;
};

// The two primitives are service-role-only and not in the generated Database types — cast past the typed client, the
// same `as unknown as` convention as `record_receptionist_conversation_recovery` and the reply ledgers. The
// resolution-context reader is a TABLE-returning function, so its `data` is a row ARRAY.
type FindResolutionContextRpc = (
  fn: "find_receptionist_resolution_context",
  args: Record<string, unknown>,
) => Promise<{ data: ResolutionContextRow[] | null; error: { message: string } | null }>;
type RecordResolutionRpc = (
  fn: "record_receptionist_conversation_resolution",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/** Narrow a ledger `text` to the {@link ConversationRecoveryType}, or null if unrecognised. */
function asRecoveryType(value: string): ConversationRecoveryType | null {
  return value === "recover_booking_fulfilment" ? value : null;
}

/** Narrow a ledger `text` to a {@link RecoveryOutcome}, or null if unrecognised. */
function asRecoveryOutcome(value: string): RecoveryOutcome | null {
  return value === "fulfilment_recovery_determined" ? value : null;
}

/** Narrow a ledger `text` to a {@link RecoveryClassification}, or null if unrecognised. */
function asRecoveryClassification(value: string): RecoveryClassification | null {
  return value === "none" || value === "reinstate" || value === "reconcile" ? value : null;
}

/** Narrow a ledger `text` to a {@link VerificationIntegrity} verdict, or null if unrecognised. */
function asVerificationIntegrity(value: string): VerificationIntegrity | null {
  return value === "consistent" || value === "missing" || value === "inconsistent" ? value : null;
}

/**
 * Determine the resolution for the determined recovery of the approved booking behind a held reply a human just SENT —
 * THE single entry point the Human Review SEND path calls after a `sent` resolution is durable, R30 has performed the
 * booking, R31 has recorded its verdict and R32 has determined its recovery. Resolves, in ONE read through the
 * service-role-only resolution-context reader, R32's RECORDED recovery disposition for `(org_id, review_audit_id)`;
 * reconstructs the R32 {@link RecoverBookingDecision} verbatim from the recorded columns (never re-recovering, never
 * re-verifying, never re-deriving the fulfilment or re-folding the authorisation), and hands it to the pure
 * {@link resolveConversationResolution}. When — and only when — the pure core decides `resolve_booking_recovery`
 * (which happens for a decided recovery, which happens only for an APPROVED, verified, recovered operation), it files
 * ONE idempotent determination into the append-only resolution ledger through the service-role-only SECURITY DEFINER
 * primitive.
 *
 * BEST-EFFORT: every failure path returns null and never throws — a durable, human-approved confirmation reply, the
 * booking R30 already performed, the verdict R31 already recorded and the recovery R32 already determined are never
 * undone by a resolution write. Returns null when there is no recorded recovery behind the held reply (the common
 * case: an ordinary review reply, or a booking whose recovery has not been recorded), when the ledger vocabulary or
 * expected payload is unrecognised, or when the ledger write could not be recorded. Returns the
 * {@link RecordedResolution} (with a STABLE id across idempotent repeats, and the STATE — which may be `recoverable` or
 * `unresolved`) when the resolution was determined.
 */
export async function resolveConversationCompletion(
  input: ResolutionTrigger,
): Promise<RecordedResolution | null> {
  const admin = createAdminClient();

  try {
    // Resolve R32's RECORDED recovery disposition behind the held reply in one read (service-role reader; reads only
    // the R32 recovery ledger, never writes). No row ⇒ the held reply had no recorded recovery — nothing to resolve.
    const finder = admin.rpc.bind(admin) as unknown as FindResolutionContextRpc;
    const { data: rows, error: findError } = await finder("find_receptionist_resolution_context", {
      p_org_id: input.org_id,
      p_review_audit_id: input.review_audit_id,
    });
    if (findError) {
      console.error("[receptionist] resolution: recovery context lookup failed", findError.message);
      return null;
    }
    const row = rows?.[0];
    if (!row) return null;

    // Narrow the recorded recovery vocabulary defensively (the columns are CHECK-constrained in the R32 ledger, so
    // these always succeed for a real row; an unrecognised value means a schema drift we refuse to classify over).
    const recoveryType = asRecoveryType(row.recovery_type);
    const recoveryOutcome = asRecoveryOutcome(row.recovery_outcome);
    const classification = asRecoveryClassification(row.recovery_classification);
    const integrity = asVerificationIntegrity(row.integrity);
    if (recoveryType === null || recoveryOutcome === null || classification === null || integrity === null) {
      console.error("[receptionist] resolution: unrecognised recovery vocabulary", {
        recovery_type: row.recovery_type,
        recovery_outcome: row.recovery_outcome,
        recovery_classification: row.recovery_classification,
        integrity: row.integrity,
      });
      return null;
    }

    // The EXPECTED booking the recovery carried (from the R31 verification, from the R30 decision) — required to
    // reconstruct the decision. R32 requires all three to record a recovery, so a null here means a schema drift.
    const { job_type: jobType, postcode, phone_number: phoneNumber } = row;
    if (!jobType || !postcode || !phoneNumber) {
      console.error("[receptionist] resolution: recorded recovery missing booking payload", {
        recovery_id: row.recovery_id,
      });
      return null;
    }

    // Reconstruct the R32 recovery DECISION verbatim from the RECORDED disposition — the Recovery Engine stays
    // authoritative; this runtime consumes its recorded decision, it never re-recovers. The reconstructed decision is
    // self-describing (type, outcome, classification, required flag, integrity, expected booking), so the resolution
    // can never drift from the recovery it classifies.
    const recovery: RecoverBookingDecision = {
      kind: recoveryType,
      outcome: recoveryOutcome,
      classification,
      recovery_required: row.recovery_required,
      integrity,
      booking: { kind: "prepare_booking", job_type: jobType, postcode, phone_number: phoneNumber },
    };

    // THE PURE DECISION — classify the recovery disposition into the completion state it implies. DEFERS if the
    // recovery was not decided (unreachable for a RECORDED row — a recovery row exists only for a decided recovery —
    // but the gate keeps the pure core authoritative). Otherwise it classifies the disposition: `none` ⇒ `terminal`,
    // `reinstate` ⇒ `recoverable`, `reconcile` ⇒ `unresolved`. A record is produced for all three.
    const decision = resolveConversationResolution(recovery);
    if (!isResolutionDecided(decision)) return null;

    // RECORD the resolution determination — file ONE idempotent row through the service-role-only SECURITY DEFINER
    // primitive. ON CONFLICT (recovery_id) DO NOTHING makes a repeat a no-op returning the existing id, so the
    // resolution is determined AT MOST ONCE. Every anchor is threaded from the RECORDED recovery (not the trigger),
    // so the resolution's provenance exactly matches the recovery it was determined from; `p_fulfilment_id` is the
    // joined fulfilment id (null when recoverable/MISSING) — the storage-layer coherence CHECK binds it to the
    // classification.
    const writer = admin.rpc.bind(admin) as unknown as RecordResolutionRpc;
    const { data, error } = await writer("record_receptionist_conversation_resolution", {
      p_org_id: input.org_id,
      p_recovery_id: row.recovery_id,
      p_authorisation_id: row.authorisation_id,
      p_verification_id: row.verification_id,
      p_resolution_type: decision.kind,
      p_resolution_outcome: decision.outcome,
      p_resolution_state: decision.state,
      p_terminal: decision.terminal,
      p_intervention_required: decision.intervention_required,
      p_recovery_classification: decision.classification,
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
      // recovery), so the resolution row records what the recovery concerns, never a recorded drift.
      p_job_type: decision.booking.job_type,
      p_postcode: decision.booking.postcode,
      p_phone_number: decision.booking.phone_number,
      p_metadata: {},
    });
    if (error || !data) {
      console.error("[receptionist] conversation resolution ledger write failed", error?.message ?? null);
      return null;
    }
    return {
      resolution_id: data,
      resolution_type: decision.kind,
      resolution_outcome: decision.outcome,
      resolution_state: decision.state,
      terminal: decision.terminal,
      intervention_required: decision.intervention_required,
    };
  } catch (e) {
    console.error("[receptionist] conversation resolution threw", e);
    return null;
  }
}
