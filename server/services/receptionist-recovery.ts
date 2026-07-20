import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveRecovery,
  isRecoveryDecided,
  type ConversationRecoveryType,
  type RecoveryOutcome,
  type RecoveryClassification,
} from "@/lib/receptionist/conversation-recovery";
import {
  type VerifyBookingDecision,
  type ConversationVerificationType,
  type VerificationOutcome,
  type VerificationIntegrity,
} from "@/lib/receptionist/conversation-verification";

// =====================================================================
// THE CONVERSATION RECOVERY ENGINE — SERVER RUNTIME (CEO Directive #018, R32: CONVERSATION RECOVERY ENGINE).
//
// The pure core (lib/receptionist/conversation-recovery.ts) RESOLVES a recovery DECISION from an already-decided R31
// verification — it CLASSIFIES the integrity verdict into the recovery it warrants (none / reinstate / reconcile) and
// reports WHETHER recovery is required, but it deliberately PERSISTS NOTHING and reaches NO I/O. This module is the
// engine's SERVER RUNTIME, and it does exactly ONE thing: when a human APPROVES a held booking confirmation (a `sent`
// resolution in the EXISTING Human Review inbox), AFTER the Fulfilment Engine (R30) has performed the approved
// booking and the Verification Engine (R31) has VERIFIED it, it DETERMINES the recovery for that verified operation —
// it reads R31's RECORDED verification verdict, classifies it, and files one durable, append-only, IDEMPOTENT
// recovery determination — and STOPS.
//
// IT DETERMINES RECOVERY — IT NEVER EXECUTES IT. Unlike the R30 runtime (which MATERIALISES an approved booking as an
// internal record), this runtime re-books nothing, retries nothing, schedules nothing, reaches NO provider and
// corrects NO record. It CLASSIFIES a verification verdict into the recovery it warrants and records the
// {@link RecoveryClassification} it found. It is the layer that turns R31's observable INTEGRITY signal into an
// auditable, actionable RECOVERY disposition — the determination a future, explicitly-authorised operational
// capability reads and acts on. Automatic retries, automatic booking recreation and automatic scheduling are EXPLICIT
// R32 non-goals; NOTHING here performs them.
//
// THE VERIFICATION ENGINE REMAINS AUTHORITATIVE — THIS RUNTIME CONSUMES ITS RECORDED DECISION, IT NEVER RE-DERIVES IT.
// It resolves, in ONE read through the single service-role-only RECOVERY-CONTEXT READER
// `find_receptionist_recovery_context`, R31's RECORDED verification verdict behind the held reply (from the R31
// `receptionist_conversation_verifications` ledger). It RECONSTRUCTS the R31 {@link VerifyBookingDecision} verbatim
// from the recorded columns — the type, the outcome, the INTEGRITY verdict and the EXPECTED booking payload — and
// hands it to the pure {@link resolveRecovery}. It NEVER re-verifies, re-reconciles, re-derives the fulfilment,
// re-folds the authorisation or re-runs policy: the verdict is R31's, recorded, and this runtime reads it. No
// duplicate verification logic; no duplicate recovery logic.
//
// IT IS DRIVEN BY THE HUMAN'S GRANT, NOT BY A TURN — AND IT RUNS ALONGSIDE R30 + R31, ON SEND. Like the R30 and R31
// runtimes, it is invoked from the Human Review SEND path
// ({@link import("@/server/services/receptionist-review").resolveReviewSend}), STRICTLY AFTER a human's `sent`
// resolution is durable, AFTER {@link import("@/server/services/receptionist-fulfilment").fulfilApprovedBooking} has
// performed the booking, and AFTER
// {@link import("@/server/services/receptionist-verification").verifyApprovedFulfilment} has recorded its verdict.
// That placement is the structural guarantee that Human Review can NEVER be bypassed: there is no other caller, and
// there is no path here that is not downstream of a human's grant and a recorded verification.
//
// THE LEDGER ROW IS BOTH THE RECOVERY DISPOSITION AND ITS AUDIT — AND IT IS IDEMPOTENT BY CONSTRUCTION. When the pure
// core decides `recover_booking_fulfilment` (which it does for a decided verification, whatever the verdict), this
// runtime files exactly ONE row into the append-only `receptionist_conversation_recoveries` ledger through the single
// service-role-only SECURITY DEFINER primitive `record_receptionist_conversation_recovery` — carrying the
// DISPOSITION (none / reinstate / reconcile), the `recovery_required` flag and threaded to the verification it was
// determined from (`verification_id`, NOT NULL), the authorisation that verification verified (`authorisation_id`,
// UNIQUE), the fulfilment that verification reconciled (`fulfilment_id`, NULL when MISSING), the held reply a human
// approved (`review_audit_id`), the reply that carried the approval (`sent_audit_id`), and the human's resolution
// itself (`review_resolution_id`). The primitive inserts ON CONFLICT (authorisation_id) DO NOTHING and returns the
// existing id, so re-driving the same approved authorisation (a retried review-send, a double-fire) determines
// recovery AT MOST ONCE. Idempotency is NOT retry: this runtime attempts the write once and lets the ledger make a
// repeat a no-op; it orchestrates no re-attempt (retry is an explicit R32 non-goal).
//
// IT REACHES NO EXTERNAL SYSTEM — THE "RECOVERY" IS THE INTERNAL DETERMINATION. It never writes a booking, never
// re-books, never schedules, never generates a quote, never promotes a lead, never places a call, never reaches a
// comms provider, never retries and never reconciles a receipt — every one is an EXPLICIT R32 non-goal. The
// confirmation the customer received is STILL produced and audited by the UNCHANGED reply pipeline, the human's grant
// is STILL recorded by the UNCHANGED Human Review architecture, the booking is STILL performed by the UNCHANGED R30
// runtime and verified by the UNCHANGED R31 runtime; this runtime records the RECOVERY disposition ALONGSIDE them.
//
// IT IS BEST-EFFORT — A RECOVERY WRITE NEVER UNDOES A HUMAN-APPROVED REPLY, ITS FULFILMENT OR ITS VERIFICATION. Like
// the outcome (R26), action (R27), execution (R28), authorisation (R29), fulfilment (R30) and verification (R31)
// writes, every step here is wrapped and swallowed on failure (logged, never thrown): a durable, audited,
// human-approved confirmation reply — and the booking R30 performed, and the verdict R31 recorded — must never be
// undone because a recovery row could not be filed. A missing verification (the held reply was not a booking approval,
// or R31 recorded nothing), an unrecognised vocabulary, an absent expected payload or a failed ledger write all
// return null — the send still succeeds; the recovery simply went undetermined, which is observable in the logs.
// =====================================================================

/**
 * The inputs {@link recoverVerifiedFulfilment} needs to determine recovery for an approved booking's verified
 * fulfilment: the organisation and the full Human Review provenance a human just produced by SENDING a held booking
 * confirmation — the held reply they approved (`review_audit_id`, the JOIN to the recorded verification), the reply
 * that carried the approval (`sent_audit_id`) and the human's resolution row (`review_resolution_id`, the grant).
 * Everything else — the verification, the authorisation, the fulfilment, the expected booking, the correlation id and
 * the conversation anchors — is resolved from the R31 verification ledger by the recovery-context reader, so the
 * caller supplies only what the SEND path already holds. (Structurally identical to R30's `FulfilmentTrigger` and
 * R31's `VerificationTrigger` — the SEND path passes the SAME provenance to all three engines.)
 */
export type RecoveryTrigger = {
  /** The organisation the approved booking belongs to. */
  org_id: string;
  /** The held reply's `ai_reply_audits` id a human approved — the JOIN to the recorded verification. */
  review_audit_id: string;
  /** The `ai_reply_audits` id of the reply that CARRIED the human's approval to the customer. */
  sent_audit_id: string;
  /** The `receptionist_review_resolutions` id of the human's `sent` resolution — the grant that authorised this. */
  review_resolution_id: string;
};

/** The durable reference to a recorded recovery — the ledger row id, its type, its outcome, its disposition and flag. */
export type RecordedRecovery = {
  /** The id of the append-only `receptionist_conversation_recoveries` row (stable across idempotent repeats). */
  recovery_id: string;
  /** The recovery type that was determined. */
  recovery_type: ConversationRecoveryType;
  /** The determined outcome (`fulfilment_recovery_determined`). */
  recovery_outcome: RecoveryOutcome;
  /** The DISPOSITION the verdict classified to (`none` / `reinstate` / `reconcile`). */
  recovery_classification: RecoveryClassification;
  /** Whether recovery is required (true iff the classification is not `none`). */
  recovery_required: boolean;
};

/**
 * One row from the `find_receptionist_recovery_context` reader — R31's RECORDED verification verdict behind a held
 * reply, so the runtime can reconstruct the {@link VerifyBookingDecision} verbatim and classify it. The enum fields
 * arrive as `text` (the reader is a service-role SECURITY DEFINER function outside the generated types); this runtime
 * narrows them defensively before reconstructing the decision. `fulfilment_id` is NULL exactly when the verified
 * operation was MISSING (the integrity is `missing`).
 */
type RecoveryContextRow = {
  verification_id: string;
  authorisation_id: string;
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
  verification_type: string;
  verification_outcome: string;
  integrity: string;
  approval_state: string;
  job_type: string | null;
  postcode: string | null;
  phone_number: string | null;
};

// The two primitives are service-role-only and not in the generated Database types — cast past the typed client, the
// same `as unknown as` convention as `record_receptionist_conversation_verification` and the reply ledgers. The
// recovery-context reader is a TABLE-returning function, so its `data` is a row ARRAY.
type FindRecoveryContextRpc = (
  fn: "find_receptionist_recovery_context",
  args: Record<string, unknown>,
) => Promise<{ data: RecoveryContextRow[] | null; error: { message: string } | null }>;
type RecordRecoveryRpc = (
  fn: "record_receptionist_conversation_recovery",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/** Narrow a ledger `text` to the {@link ConversationVerificationType}, or null if unrecognised. */
function asVerificationType(value: string): ConversationVerificationType | null {
  return value === "verify_booking_fulfilment" ? value : null;
}

/** Narrow a ledger `text` to a {@link VerificationOutcome}, or null if unrecognised. */
function asVerificationOutcome(value: string): VerificationOutcome | null {
  return value === "fulfilment_reconciled" ? value : null;
}

/** Narrow a ledger `text` to a {@link VerificationIntegrity} verdict, or null if unrecognised. */
function asVerificationIntegrity(value: string): VerificationIntegrity | null {
  return value === "consistent" || value === "missing" || value === "inconsistent" ? value : null;
}

/**
 * Determine the recovery for the verified fulfilment of the approved booking behind a held reply a human just SENT —
 * THE single entry point the Human Review SEND path calls after a `sent` resolution is durable, R30 has performed the
 * booking and R31 has recorded its verdict. Resolves, in ONE read through the service-role-only recovery-context
 * reader, R31's RECORDED verification verdict for `(org_id, review_audit_id)`; reconstructs the R31
 * {@link VerifyBookingDecision} verbatim from the recorded columns (never re-verifying, never re-deriving the
 * fulfilment or re-folding the authorisation), and hands it to the pure {@link resolveRecovery}. When — and only when
 * — the pure core decides `recover_booking_fulfilment` (which happens for a decided verification, which happens only
 * for an APPROVED, verified operation), it files ONE idempotent determination into the append-only recovery ledger
 * through the service-role-only SECURITY DEFINER primitive.
 *
 * BEST-EFFORT: every failure path returns null and never throws — a durable, human-approved confirmation reply, the
 * booking R30 already performed and the verdict R31 already recorded are never undone by a recovery write. Returns
 * null when there is no recorded verification behind the held reply (the common case: an ordinary review reply, or a
 * booking whose verification has not been recorded), when the ledger vocabulary or expected payload is unrecognised,
 * or when the ledger write could not be recorded. Returns the {@link RecordedRecovery} (with a STABLE id across
 * idempotent repeats, and the DISPOSITION — which may be `reinstate` or `reconcile`) when the recovery was determined.
 */
export async function recoverVerifiedFulfilment(
  input: RecoveryTrigger,
): Promise<RecordedRecovery | null> {
  const admin = createAdminClient();

  try {
    // Resolve R31's RECORDED verification verdict behind the held reply in one read (service-role reader; reads only
    // the R31 verification ledger, never writes). No row ⇒ the held reply had no recorded verification — nothing to
    // recover.
    const finder = admin.rpc.bind(admin) as unknown as FindRecoveryContextRpc;
    const { data: rows, error: findError } = await finder("find_receptionist_recovery_context", {
      p_org_id: input.org_id,
      p_review_audit_id: input.review_audit_id,
    });
    if (findError) {
      console.error("[receptionist] recovery: verification context lookup failed", findError.message);
      return null;
    }
    const row = rows?.[0];
    if (!row) return null;

    // Narrow the recorded verification vocabulary defensively (the columns are CHECK-constrained in the R31 ledger, so
    // these always succeed for a real row; an unrecognised value means a schema drift we refuse to classify over).
    const verificationType = asVerificationType(row.verification_type);
    const verificationOutcome = asVerificationOutcome(row.verification_outcome);
    const integrity = asVerificationIntegrity(row.integrity);
    if (verificationType === null || verificationOutcome === null || integrity === null) {
      console.error("[receptionist] recovery: unrecognised verification vocabulary", {
        verification_type: row.verification_type,
        verification_outcome: row.verification_outcome,
        integrity: row.integrity,
      });
      return null;
    }

    // The EXPECTED booking the verification carried (from the R30 decision, from the R29 authorisation) — required to
    // reconstruct the decision. R31 requires all three to record a verification, so a null here means a schema drift.
    const { job_type: jobType, postcode, phone_number: phoneNumber } = row;
    if (!jobType || !postcode || !phoneNumber) {
      console.error("[receptionist] recovery: recorded verification missing booking payload", {
        verification_id: row.verification_id,
      });
      return null;
    }

    // Reconstruct the R31 verification DECISION verbatim from the RECORDED verdict — the Verification Engine stays
    // authoritative; this runtime consumes its recorded decision, it never re-verifies. The reconstructed decision is
    // self-describing (type, outcome, integrity, expected booking), so the recovery can never drift from the
    // verification it classifies.
    const verification: VerifyBookingDecision = {
      kind: verificationType,
      outcome: verificationOutcome,
      integrity,
      booking: { kind: "prepare_booking", job_type: jobType, postcode, phone_number: phoneNumber },
    };

    // THE PURE DECISION — classify the verification verdict into the recovery it warrants. DEFERS if the verification
    // was not decided (unreachable for a RECORDED row — a verification row exists only for a decided verification —
    // but the gate keeps the pure core authoritative). Otherwise it classifies the verdict: `consistent` ⇒ `none`
    // (no recovery required), `missing` ⇒ `reinstate`, `inconsistent` ⇒ `reconcile`. A record is produced for all
    // three.
    const decision = resolveRecovery(verification);
    if (!isRecoveryDecided(decision)) return null;

    // RECORD the recovery determination — file ONE idempotent row through the service-role-only SECURITY DEFINER
    // primitive. ON CONFLICT (authorisation_id) DO NOTHING makes a repeat a no-op returning the existing id, so the
    // recovery is determined AT MOST ONCE. Every anchor is threaded from the RECORDED verification (not the trigger),
    // so the recovery's provenance exactly matches the verification it was determined from; `p_fulfilment_id` is the
    // joined fulfilment id (null when MISSING) — the storage-layer coherence CHECK binds it to the verdict.
    const writer = admin.rpc.bind(admin) as unknown as RecordRecoveryRpc;
    const { data, error } = await writer("record_receptionist_conversation_recovery", {
      p_org_id: input.org_id,
      p_authorisation_id: row.authorisation_id,
      p_verification_id: row.verification_id,
      p_recovery_type: decision.kind,
      p_recovery_outcome: decision.outcome,
      p_recovery_classification: decision.classification,
      p_recovery_required: decision.recovery_required,
      p_integrity: decision.integrity,
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
      // verification), so the recovery row records what SHOULD have been performed, never a recorded drift.
      p_job_type: decision.booking.job_type,
      p_postcode: decision.booking.postcode,
      p_phone_number: decision.booking.phone_number,
      p_metadata: {},
    });
    if (error || !data) {
      console.error("[receptionist] conversation recovery ledger write failed", error?.message ?? null);
      return null;
    }
    return {
      recovery_id: data,
      recovery_type: decision.kind,
      recovery_outcome: decision.outcome,
      recovery_classification: decision.classification,
      recovery_required: decision.recovery_required,
    };
  } catch (e) {
    console.error("[receptionist] conversation recovery threw", e);
    return null;
  }
}
