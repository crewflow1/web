import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveVerification,
  isVerificationDecided,
  type ConversationVerificationType,
  type VerificationOutcome,
  type VerificationIntegrity,
  type RecordedFulfilmentSnapshot,
} from "@/lib/receptionist/conversation-verification";
import { resolveFulfilment } from "@/lib/receptionist/conversation-fulfilment";
import {
  deriveAuthorisationState,
  type ApproveBookingAuthorisation,
  type AuthorisationOpeningState,
  type AuthorisationRequirement,
  type AuthorisationState,
} from "@/lib/receptionist/conversation-authorisation";
import type { ExecutionEligibility } from "@/lib/receptionist/conversation-execution";

// =====================================================================
// THE CONVERSATION VERIFICATION ENGINE — SERVER RUNTIME (CEO Directive #018, R31: CONVERSATION VERIFICATION ENGINE).
//
// The pure core (lib/receptionist/conversation-verification.ts) RESOLVES a verification DECISION from an
// already-decided R30 fulfilment AND the recorded operation beside it — it reconciles the two and reports the
// INTEGRITY it found, but it deliberately PERSISTS NOTHING and reaches NO I/O. This module is the engine's SERVER
// RUNTIME, and it does exactly ONE thing: when a human APPROVES a held booking confirmation (a `sent` resolution in
// the EXISTING Human Review inbox), AFTER the Fulfilment Engine (R30) has performed the approved booking, it
// VERIFIES that performed operation — it reconciles the DECIDED fulfilment against the RECORDED one and files one
// durable, append-only, IDEMPOTENT verification verdict — and STOPS.
//
// IT VERIFIES WORK — IT NEVER PERFORMS IT. Unlike the R30 runtime (which MATERIALISES an approved booking as an
// internal record), this runtime writes NO booking, reaches NO provider and carries out NO further fulfilment. It
// RECONCILES a decision against a record and records the {@link VerificationIntegrity} it found. It is the
// independent check ON R30 — the layer that turns R30's best-effort bookkeeping write into an observable, auditable
// INTEGRITY signal.
//
// IT IS DRIVEN BY THE HUMAN'S GRANT, NOT BY A TURN — AND IT RUNS ALONGSIDE R30, ON SEND. Like the R30 runtime, it is
// invoked from the Human Review SEND path
// ({@link import("@/server/services/receptionist-review").resolveReviewSend}), AFTER a human's `sent` resolution on
// the held reply is durable AND after {@link import("@/server/services/receptionist-fulfilment").fulfilApprovedBooking}
// has run. That placement is the structural guarantee that Human Review can NEVER be bypassed: there is no other
// caller, and there is no path here that is not downstream of a human's grant.
//
// IT RE-DERIVES NOTHING — IT READS BOTH SIDES AND RECONCILES THEM. It resolves, in ONE read through the single
// service-role-only RECONCILIATION READER `find_receptionist_fulfilment_reconciliation`, both sides of the
// reconciliation behind the held reply: the PENDING `approve_booking` authorisation (from the R29
// `receptionist_conversation_authorisations` ledger) LEFT JOINed to the fulfilment R30 filed for it (from the R30
// `receptionist_conversation_fulfilments` ledger, or NULLs when the operation is MISSING). It reconstructs the R29
// {@link ApproveBookingAuthorisation}, folds the human's `sent` resolution to the terminal grant through R29's OWN
// {@link deriveAuthorisationState}, and re-derives the EXPECTED fulfilment through R30's OWN {@link resolveFulfilment}
// — it never re-decides approval, re-authorises, re-executes or re-runs policy, and it never re-models what should
// have been performed. The EXPECTED shape is R30's to decide and the grant is R29's to fold; this runtime consumes
// both and hands (expected fulfilment, recorded snapshot) to the pure {@link resolveVerification}. No duplicate
// fulfilment logic; no duplicate verification logic.
//
// THE LEDGER ROW IS BOTH THE VERIFICATION VERDICT AND ITS AUDIT — AND IT IS IDEMPOTENT BY CONSTRUCTION. When the
// pure core decides `verify_booking_fulfilment`, this runtime files exactly ONE row into the append-only
// `receptionist_conversation_verifications` ledger through the single service-role-only SECURITY DEFINER primitive
// `record_receptionist_conversation_verification` — carrying the INTEGRITY verdict and threaded to the authorisation
// it verifies (`authorisation_id`, UNIQUE), the fulfilment it reconciled (`fulfilment_id`, NULL when MISSING), the
// held reply a human approved (`review_audit_id`), the reply that carried the approval (`sent_audit_id`), and the
// human's resolution itself (`review_resolution_id`). The primitive inserts ON CONFLICT (authorisation_id) DO
// NOTHING and returns the existing id, so re-driving the same approved authorisation (a retried review-send, a
// double-fire) verifies AT MOST ONCE. Idempotency is NOT retry: this runtime attempts the write once and lets the
// ledger make a repeat a no-op; it orchestrates no re-attempt (retry is an explicit R31 non-goal).
//
// IT REACHES NO EXTERNAL SYSTEM — THE "VERIFICATION" IS THE INTERNAL RECONCILIATION. It never writes a calendar,
// never schedules, never generates a quote, never promotes a lead, never places a call, never reaches a comms
// provider, never retries and never reconciles a receipt — every one is an EXPLICIT R31 non-goal. The confirmation
// the customer received is STILL produced and audited by the UNCHANGED reply pipeline, the human's grant is STILL
// recorded by the UNCHANGED Human Review architecture, and the booking is STILL performed by the UNCHANGED R30
// runtime; this runtime records the VERIFICATION verdict ALONGSIDE them.
//
// IT IS BEST-EFFORT — A VERIFICATION WRITE NEVER UNDOES A HUMAN-APPROVED REPLY OR ITS FULFILMENT. Like the outcome
// (R26), action (R27), execution (R28), authorisation (R29) and fulfilment (R30) writes, every step here is wrapped
// and swallowed on failure (logged, never thrown): a durable, audited, human-approved confirmation reply — and the
// booking R30 already performed — must never be undone because a verification row could not be filed. A missing
// pending authorisation (the held reply was an ordinary review, not a booking approval), an unrecognised
// vocabulary, an absent expected payload or a failed ledger write all return null — the send still succeeds; the
// verification simply went unrecorded, which is observable in the logs.
// =====================================================================

/**
 * The inputs {@link verifyApprovedFulfilment} needs to verify an approved booking's fulfilment: the organisation
 * and the full Human Review provenance a human just produced by SENDING a held booking confirmation — the held
 * reply they approved (`review_audit_id`, the JOIN to the pending authorisation and its fulfilment), the reply that
 * carried the approval (`sent_audit_id`) and the human's resolution row (`review_resolution_id`, the grant).
 * Everything else — the authorisation, the recorded fulfilment, the expected booking, the correlation id and the
 * conversation anchors — is resolved from the R29 + R30 ledgers by the reconciliation reader, so the caller
 * supplies only what the SEND path already holds. (Structurally identical to R30's `FulfilmentTrigger` — the SEND
 * path passes the SAME provenance to both engines.)
 */
export type VerificationTrigger = {
  /** The organisation the approved booking belongs to. */
  org_id: string;
  /** The held reply's `ai_reply_audits` id a human approved — the JOIN to the pending authorisation + fulfilment. */
  review_audit_id: string;
  /** The `ai_reply_audits` id of the reply that CARRIED the human's approval to the customer. */
  sent_audit_id: string;
  /** The `receptionist_review_resolutions` id of the human's `sent` resolution — the grant that authorised this. */
  review_resolution_id: string;
};

/** The durable reference to a recorded verification — the ledger row id, its type, its outcome and its verdict. */
export type RecordedVerification = {
  /** The id of the append-only `receptionist_conversation_verifications` row (stable across idempotent repeats). */
  verification_id: string;
  /** The verification type that was carried out. */
  verification_type: ConversationVerificationType;
  /** The performed outcome (`fulfilment_reconciled`). */
  verification_outcome: VerificationOutcome;
  /** The INTEGRITY verdict the reconciliation found (`consistent` / `missing` / `inconsistent`). */
  integrity: VerificationIntegrity;
};

/**
 * One row from the `find_receptionist_fulfilment_reconciliation` reader — both sides of the reconciliation behind a
 * held reply: the PENDING `approve_booking` authorisation (from the R29 ledger, so the runtime can reconstruct it
 * and re-derive the EXPECTED fulfilment) LEFT JOINed to the fulfilment R30 filed for it (from the R30 ledger — the
 * `recorded_*` fields, ALL null when the operation is MISSING). The enum fields arrive as `text` (the reader is a
 * service-role SECURITY DEFINER function outside the generated types); this runtime narrows them defensively before
 * reconstructing the authorisation and building the recorded snapshot.
 */
type FulfilmentReconciliationRow = {
  authorisation_id: string;
  conversation_id: string | null;
  enquiry_id: string | null;
  lead_id: string | null;
  customer_ref: string | null;
  correlation_id: string;
  action_id: string | null;
  execution_id: string | null;
  requirement: string;
  authorisation_state: string;
  execution_eligibility: string;
  job_type: string | null;
  postcode: string | null;
  phone_number: string | null;
  // The RECORDED fulfilment (LEFT JOIN) — ALL null together when R30 filed no fulfilment (the MISSING verdict).
  fulfilment_id: string | null;
  recorded_fulfilment_type: string | null;
  recorded_fulfilment_outcome: string | null;
  recorded_approval_state: string | null;
  recorded_status: string | null;
  recorded_job_type: string | null;
  recorded_postcode: string | null;
  recorded_phone_number: string | null;
};

// The two primitives are service-role-only and not in the generated Database types — cast past the typed client,
// the same `as unknown as` convention as `record_receptionist_conversation_fulfilment` and the reply ledgers. The
// reconciliation reader is a TABLE-returning function, so its `data` is a row ARRAY.
type FindFulfilmentReconciliationRpc = (
  fn: "find_receptionist_fulfilment_reconciliation",
  args: Record<string, unknown>,
) => Promise<{ data: FulfilmentReconciliationRow[] | null; error: { message: string } | null }>;
type RecordVerificationRpc = (
  fn: "record_receptionist_conversation_verification",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/** Narrow a ledger `text` to the turn-time {@link AuthorisationOpeningState}, or null if unrecognised. */
function asOpeningState(value: string): AuthorisationOpeningState | null {
  return value === "pending" || value === "foreclosed" ? value : null;
}

/** Narrow a ledger `text` to an {@link AuthorisationRequirement}, or null if unrecognised. */
function asRequirement(value: string): AuthorisationRequirement | null {
  return value === "human_approval_required" || value === "not_required" ? value : null;
}

/** Narrow a ledger `text` to an {@link ExecutionEligibility}, or null if unrecognised. */
function asEligibility(value: string): ExecutionEligibility | null {
  return value === "requires_human_review" || value === "blocked_by_policy" || value === "blocked_by_org"
    ? value
    : null;
}

/**
 * Build the RECORDED snapshot from a reconciliation row — the R30 fulfilment as the reader read it back, or `null`
 * when no fulfilment was recorded (the LEFT JOIN produced NULLs — the MISSING verdict). `fulfilment_id` is the
 * single source of truth for presence: it is non-null exactly when a fulfilment row was joined, so a null there is
 * the MISSING signal and a present id means every recorded field was projected (each raw `string`, coalesced
 * defensively so an unexpected schema null reconciles as `inconsistent`, never crashes).
 */
function recordedSnapshotOf(row: FulfilmentReconciliationRow): RecordedFulfilmentSnapshot | null {
  if (row.fulfilment_id === null) return null;
  return {
    fulfilment_type: row.recorded_fulfilment_type ?? "",
    fulfilment_outcome: row.recorded_fulfilment_outcome ?? "",
    approval_state: row.recorded_approval_state ?? "",
    status: row.recorded_status ?? "",
    job_type: row.recorded_job_type ?? "",
    postcode: row.recorded_postcode ?? "",
    phone_number: row.recorded_phone_number ?? "",
  };
}

/**
 * Verify the fulfilment of the approved booking behind a held reply a human just SENT — THE single entry point the
 * Human Review SEND path calls after a `sent` resolution is durable and R30 has performed the booking. Resolves, in
 * ONE read through the service-role-only reconciliation reader, the PENDING `approve_booking` authorisation for
 * `(org_id, review_audit_id)` AND the fulfilment R30 filed for it; reconstructs the R29
 * {@link ApproveBookingAuthorisation}, folds the human's `sent` resolution to the terminal grant through R29's OWN
 * {@link deriveAuthorisationState} (never re-deciding approval), re-derives the EXPECTED fulfilment through R30's
 * OWN {@link resolveFulfilment} (never re-modelling it), and hands (expected fulfilment, recorded snapshot) to the
 * pure {@link resolveVerification}. When — and only when — the pure core decides `verify_booking_fulfilment` (which
 * happens only for a DECIDED fulfilment, which happens only for an APPROVED authorisation), it files ONE idempotent
 * verdict into the append-only verification ledger through the service-role-only SECURITY DEFINER primitive.
 *
 * BEST-EFFORT: every failure path returns null and never throws — a durable, human-approved confirmation reply and
 * the booking R30 already performed are never undone by a verification write. Returns null when there is no pending
 * booking authorisation behind the held reply (the common case: an ordinary review reply), when the ledger
 * vocabulary or expected payload is unrecognised, or when the ledger write could not be recorded. Returns the
 * {@link RecordedVerification} (with a STABLE id across idempotent repeats, and the INTEGRITY verdict — which may be
 * `missing` or `inconsistent`) when the reconciliation was recorded.
 */
export async function verifyApprovedFulfilment(
  input: VerificationTrigger,
): Promise<RecordedVerification | null> {
  const admin = createAdminClient();

  try {
    // Resolve BOTH sides of the reconciliation behind the held reply in one read (service-role reader; reads only
    // the R29 + R30 ledgers, never writes). No row ⇒ the held reply was not a booking approval — nothing to verify.
    const finder = admin.rpc.bind(admin) as unknown as FindFulfilmentReconciliationRpc;
    const { data: rows, error: findError } = await finder(
      "find_receptionist_fulfilment_reconciliation",
      { p_org_id: input.org_id, p_review_audit_id: input.review_audit_id },
    );
    if (findError) {
      console.error("[receptionist] verification: reconciliation lookup failed", findError.message);
      return null;
    }
    const row = rows?.[0];
    if (!row) return null;

    // Narrow the authorisation vocabulary defensively (the columns are CHECK-constrained in the R29 ledger, so these
    // always succeed for a real row; an unrecognised value means a schema drift we refuse to verify over).
    const state = asOpeningState(row.authorisation_state);
    const requirement = asRequirement(row.requirement);
    const eligibility = asEligibility(row.execution_eligibility);
    if (state === null || requirement === null || eligibility === null) {
      console.error("[receptionist] verification: unrecognised authorisation vocabulary", {
        authorisation_state: row.authorisation_state,
        requirement: row.requirement,
        execution_eligibility: row.execution_eligibility,
      });
      return null;
    }

    // The EXPECTED booking cannot be re-derived without its payload — the trade, the place and the number to ring.
    // The reader carries them through from the R29 ledger; a null here means an incomplete authorisation we refuse.
    const { job_type: jobType, postcode, phone_number: phoneNumber } = row;
    if (!jobType || !postcode || !phoneNumber) {
      console.error("[receptionist] verification: pending booking authorisation missing booking payload", {
        authorisation_id: row.authorisation_id,
      });
      return null;
    }

    // Reconstruct the R29 authorisation the whole stack decided over — self-describing, so the EXPECTED fulfilment
    // can never drift from the decision it verifies.
    const authorisation: ApproveBookingAuthorisation = {
      kind: "approve_booking",
      requirement,
      state,
      execution: {
        kind: "execute_booking",
        eligibility,
        action: { kind: "prepare_booking", job_type: jobType, postcode, phone_number: phoneNumber },
      },
    };

    // Fold the human's `sent` resolution to the terminal grant through R29's OWN bridge, then re-derive the EXPECTED
    // fulfilment through R30's OWN resolver — the Authorisation and Fulfilment Engines stay authoritative; this
    // runtime re-decides neither approval nor what should have been performed. The pair (`pending` + `sent`) folds
    // to `approved`, and an approved `approve_booking` fulfils to a `fulfil_booking` decision.
    const approval: AuthorisationState = deriveAuthorisationState(state, "sent");
    const expected = resolveFulfilment(authorisation, approval);

    // The RECORDED side — the R30 fulfilment as the reader read it back (or null when MISSING). This is the fact the
    // verification reconciles the decision against.
    const recorded = recordedSnapshotOf(row);

    // THE PURE DECISION — reconcile the EXPECTED fulfilment against the RECORDED one. It DEFERS if R30 rendered no
    // decision (nothing approved to perform, so nothing to verify — a total no-op), otherwise it reports the
    // integrity verdict (`consistent` / `missing` / `inconsistent`). A record is produced for all three.
    const decision = resolveVerification(expected, recorded);
    if (!isVerificationDecided(decision)) return null;

    // RECORD the verification verdict — file ONE idempotent row through the service-role-only SECURITY DEFINER
    // primitive. ON CONFLICT (authorisation_id) DO NOTHING makes a repeat a no-op returning the existing id, so the
    // fulfilment is verified AT MOST ONCE. `p_fulfilment_id` is the joined fulfilment id (null when MISSING) — the
    // storage-layer coherence CHECK binds it to the verdict (`missing` iff no fulfilment).
    const writer = admin.rpc.bind(admin) as unknown as RecordVerificationRpc;
    const { data, error } = await writer("record_receptionist_conversation_verification", {
      p_org_id: input.org_id,
      p_authorisation_id: row.authorisation_id,
      p_verification_type: decision.kind,
      p_verification_outcome: decision.outcome,
      p_integrity: decision.integrity,
      p_approval_state: approval,
      p_correlation_id: row.correlation_id,
      p_review_audit_id: input.review_audit_id,
      p_sent_audit_id: input.sent_audit_id,
      p_review_resolution_id: input.review_resolution_id,
      p_fulfilment_id: row.fulfilment_id,
      p_conversation_id: row.conversation_id,
      p_enquiry_id: row.enquiry_id,
      p_lead_id: row.lead_id,
      p_customer_ref: row.customer_ref,
      p_action_id: row.action_id,
      p_execution_id: row.execution_id,
      // The EXPECTED booking payload — read straight from the DECISION (which carried it through from the
      // authorisation), so the verification row records what SHOULD have been performed, never the recorded drift.
      p_job_type: decision.booking.job_type,
      p_postcode: decision.booking.postcode,
      p_phone_number: decision.booking.phone_number,
      p_metadata: {},
    });
    if (error || !data) {
      console.error("[receptionist] conversation verification ledger write failed", error?.message ?? null);
      return null;
    }
    return {
      verification_id: data,
      verification_type: decision.kind,
      verification_outcome: decision.outcome,
      integrity: decision.integrity,
    };
  } catch (e) {
    console.error("[receptionist] conversation verification threw", e);
    return null;
  }
}
