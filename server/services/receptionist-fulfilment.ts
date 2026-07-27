import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveFulfilment,
  isFulfilmentDecided,
  type ConversationFulfilmentType,
  type FulfilmentOutcome,
} from "@/lib/receptionist/conversation-fulfilment";
import {
  deriveAuthorisationState,
  type ApproveBookingAuthorisation,
  type AuthorisationOpeningState,
  type AuthorisationRequirement,
  type AuthorisationState,
} from "@/lib/receptionist/conversation-authorisation";
import type { ExecutionEligibility } from "@/lib/receptionist/conversation-execution";

// =====================================================================
// THE CONVERSATION FULFILMENT ENGINE — SERVER RUNTIME (CEO Directive #018, R30: CONVERSATION FULFILMENT ENGINE).
//
// The pure core (lib/receptionist/conversation-fulfilment.ts) RESOLVES a fulfilment DECISION from an
// already-decided R29 authorisation AND its already-derived terminal grant — it emits the go-ahead to carry out
// an approved booking ONLY when the grant is `approved`, but it deliberately PERSISTS NOTHING and reaches NO I/O.
// This module is the engine's SERVER RUNTIME, and it does exactly ONE thing: when a human APPROVES a held booking
// confirmation (a `sent` resolution in the EXISTING Human Review inbox), it CARRIES OUT the approved internal
// business operation — it MATERIALISES the approved booking as one durable, append-only, IDEMPOTENT record — and
// STOPS.
//
// IT PERFORMS APPROVED WORK — AND IT IS DRIVEN BY THE HUMAN'S GRANT, NOT BY A TURN. Unlike the R26–R29 runtimes
// (each files a turn-time DECISION during the reply pipeline), this runtime is invoked from the Human Review SEND
// path ({@link import("@/server/services/receptionist-review").resolveReviewSend}), AFTER a human's `sent`
// resolution on the held reply is durable. That placement is the structural guarantee that Human Review can NEVER
// be bypassed: there is no other caller, and there is no path here that is not downstream of a human's grant.
//
// IT RE-DERIVES NOTHING — IT READS THE AUTHORISATION AND FOLDS THE GRANT THROUGH R29'S BRIDGE. It resolves the
// PENDING `approve_booking` authorisation behind the held reply through the single service-role-only reader
// `find_receptionist_pending_booking_authorisation` (which reads ONLY the R29
// `receptionist_conversation_authorisations` ledger), reconstructs the R29 {@link ApproveBookingAuthorisation}
// from that row, and folds the human's `sent` resolution to the terminal grant through R29's OWN
// {@link deriveAuthorisationState} — it never re-decides approval, re-authorises, re-executes, re-prepares the
// action or re-runs policy. The grant is R29's to derive; this runtime consumes it and hands (authorisation,
// grant) to the pure {@link resolveFulfilment}. No duplicate approval logic; no duplicate fulfilment logic.
//
// THE LEDGER ROW IS BOTH THE PERFORMED OPERATION AND ITS AUDIT — AND IT IS IDEMPOTENT BY CONSTRUCTION. When the
// pure core decides `fulfil_booking`, this runtime files exactly ONE row into the append-only
// `receptionist_conversation_fulfilments` ledger through the single service-role-only SECURITY DEFINER primitive
// `record_receptionist_conversation_fulfilment` — threaded to the authorisation it fulfils (`authorisation_id`,
// UNIQUE), to the held reply a human approved (`review_audit_id`), to the reply that carried the approval
// (`sent_audit_id`), and to the human's resolution itself (`review_resolution_id`). The primitive inserts ON
// CONFLICT (authorisation_id) DO NOTHING and returns the existing id, so re-driving the same approved
// authorisation (a retried review-send, a double-fire) performs the booking AT MOST ONCE. Idempotency is NOT
// retry: this runtime attempts the write once and lets the ledger make a repeat a no-op; it orchestrates no
// re-attempt (retry is an explicit R30 non-goal).
//
// IT REACHES NO EXTERNAL SYSTEM — THE "INTERNAL BUSINESS OPERATION" IS THE INTERNAL RECORD. It never writes a
// calendar, never schedules, never generates a quote, never promotes a lead, never places a call, never reaches a
// comms provider, never retries and never reconciles a receipt — every one is an EXPLICIT R30 non-goal. The
// confirmation the customer received is STILL produced and audited by the UNCHANGED reply pipeline, and the
// human's grant is STILL recorded by the UNCHANGED Human Review architecture; this runtime records the PERFORMED
// internal operation ALONGSIDE them.
//
// IT IS BEST-EFFORT — A BOOKKEEPING WRITE NEVER UNDOES A HUMAN-APPROVED REPLY. Like the outcome (R26), action
// (R27), execution (R28) and authorisation (R29) writes, every step here is wrapped and swallowed on failure
// (logged, never thrown): a durable, audited, human-approved confirmation reply must never be undone because a
// fulfilment row could not be filed. A missing pending authorisation (the held reply was an ordinary review, not
// a booking approval), an unrecognised vocabulary, an absent booking payload or a failed ledger write all return
// null — the send still succeeds; the fulfilment simply went unrecorded, which is observable in the logs.
// =====================================================================

/**
 * The inputs {@link fulfilApprovedBooking} needs to carry out an approved booking: the organisation and the full
 * Human Review provenance a human just produced by SENDING a held booking confirmation — the held reply they
 * approved (`review_audit_id`, the JOIN to the pending authorisation), the reply that carried the approval
 * (`sent_audit_id`) and the human's resolution row (`review_resolution_id`, the grant). Everything else — the
 * authorisation, the booking payload, the correlation id and the conversation anchors — is resolved from the R29
 * ledger by the reader, so the caller supplies only what the SEND path already holds.
 */
export type FulfilmentTrigger = {
  /** The organisation the approved booking belongs to. */
  org_id: string;
  /** The held reply's `ai_reply_audits` id a human approved — the JOIN to the pending `approve_booking` row. */
  review_audit_id: string;
  /** The `ai_reply_audits` id of the reply that CARRIED the human's approval to the customer. */
  sent_audit_id: string;
  /** The `receptionist_review_resolutions` id of the human's `sent` resolution — the grant that authorised this. */
  review_resolution_id: string;
};

/** The durable reference to a performed fulfilment — the ledger row id, its type and its performed outcome. */
export type RecordedFulfilment = {
  /** The id of the append-only `receptionist_conversation_fulfilments` row (stable across idempotent repeats). */
  fulfilment_id: string;
  /** The fulfilment type that was carried out. */
  fulfilment_type: ConversationFulfilmentType;
  /** The performed outcome (`booking_recorded`). */
  fulfilment_outcome: FulfilmentOutcome;
};

/**
 * One row from the `find_receptionist_pending_booking_authorisation` reader — the PENDING `approve_booking`
 * authorisation behind a held reply, projected from the R29 ledger. The enum fields arrive as `text` (the reader
 * is a service-role SECURITY DEFINER function outside the generated types); this runtime narrows them defensively
 * before reconstructing the authorisation.
 */
type PendingBookingAuthorisationRow = {
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
};

// The two primitives are service-role-only and not in the generated Database types — cast past the typed client,
// the same `as unknown as` convention as `record_receptionist_conversation_authorisation` and the reply ledgers.
// The reader is a TABLE-returning function, so its `data` is a row ARRAY.
type FindPendingBookingAuthorisationRpc = (
  fn: "find_receptionist_pending_booking_authorisation",
  args: Record<string, unknown>,
) => Promise<{ data: PendingBookingAuthorisationRow[] | null; error: { message: string } | null }>;
type RecordFulfilmentRpc = (
  fn: "record_receptionist_conversation_fulfilment",
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
 * Carry out the approved booking behind a held reply a human just SENT — THE single entry point the Human Review
 * SEND path calls after a `sent` resolution is durable. Resolves the PENDING `approve_booking` authorisation for
 * `(org_id, review_audit_id)` through the service-role-only reader, reconstructs the R29
 * {@link ApproveBookingAuthorisation}, folds the human's `sent` resolution to the terminal grant through R29's OWN
 * {@link deriveAuthorisationState} (never re-deciding approval), and hands (authorisation, grant) to the pure
 * {@link resolveFulfilment}. When — and only when — the pure core decides `fulfil_booking` (which happens only for
 * an APPROVED authorisation), it files ONE idempotent row into the append-only fulfilment ledger through the
 * service-role-only SECURITY DEFINER primitive.
 *
 * BEST-EFFORT: every failure path returns null and never throws — a durable, human-approved confirmation reply is
 * never undone by a bookkeeping write. Returns null when there is no pending booking authorisation behind the held
 * reply (the common case: an ordinary review reply, not a booking approval), when the ledger vocabulary or booking
 * payload is unrecognised, or when the ledger write could not be recorded. Returns the {@link RecordedFulfilment}
 * (with a STABLE id across idempotent repeats) when the approved booking was materialised.
 */
export async function fulfilApprovedBooking(
  input: FulfilmentTrigger,
): Promise<RecordedFulfilment | null> {
  const admin = createAdminClient();

  try {
    // Resolve the PENDING approve_booking authorisation behind the held reply (service-role reader; reads only the
    // R29 ledger, never writes). No row ⇒ the held reply was not a booking approval — nothing to fulfil.
    const finder = admin.rpc.bind(admin) as unknown as FindPendingBookingAuthorisationRpc;
    const { data: rows, error: findError } = await finder(
      "find_receptionist_pending_booking_authorisation",
      { p_org_id: input.org_id, p_review_audit_id: input.review_audit_id },
    );
    if (findError) {
      console.error("[receptionist] fulfilment: pending authorisation lookup failed", findError.message);
      return null;
    }
    const row = rows?.[0];
    if (!row) return null;

    // Narrow the ledger vocabulary defensively (the columns are CHECK-constrained in the R29 ledger, so these
    // always succeed for a real row; an unrecognised value means a schema drift we refuse to fulfil over).
    const state = asOpeningState(row.authorisation_state);
    const requirement = asRequirement(row.requirement);
    const eligibility = asEligibility(row.execution_eligibility);
    if (state === null || requirement === null || eligibility === null) {
      console.error("[receptionist] fulfilment: unrecognised authorisation vocabulary", {
        authorisation_state: row.authorisation_state,
        requirement: row.requirement,
        execution_eligibility: row.execution_eligibility,
      });
      return null;
    }

    // A booking cannot be materialised without its payload — the trade, the place and the number to ring. The
    // reader carries them through from the R29 ledger; a null here means an incomplete authorisation we refuse.
    const { job_type: jobType, postcode, phone_number: phoneNumber } = row;
    if (!jobType || !postcode || !phoneNumber) {
      console.error("[receptionist] fulfilment: pending booking authorisation missing booking payload", {
        authorisation_id: row.authorisation_id,
      });
      return null;
    }

    // Reconstruct the R29 authorisation the whole stack decided over — self-describing, so the fulfilment can
    // never drift from the decision it fulfils.
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

    // Fold the human's `sent` resolution to the terminal grant through R29's OWN bridge — the Authorisation Engine
    // stays authoritative over approval; this runtime never re-decides it. A `pending` authorisation + `sent`
    // yields `approved`; anything else would NOT (and the pure core would then abstain).
    const approval: AuthorisationState = deriveAuthorisationState(state, "sent");

    // THE PURE DECISION — the go-ahead to carry out the booking, emitted ONLY for an APPROVED authorisation. An
    // abstention here (a non-approved grant, or an unsupported authorisation) is a total no-op.
    const decision = resolveFulfilment(authorisation, approval);
    if (!isFulfilmentDecided(decision)) return null;

    // PERFORM the approved internal business operation — file ONE idempotent fulfilment row through the
    // service-role-only SECURITY DEFINER primitive. ON CONFLICT (authorisation_id) DO NOTHING makes a repeat a
    // no-op returning the existing id, so the booking is materialised AT MOST ONCE.
    const writer = admin.rpc.bind(admin) as unknown as RecordFulfilmentRpc;
    const { data, error } = await writer("record_receptionist_conversation_fulfilment", {
      p_org_id: input.org_id,
      p_authorisation_id: row.authorisation_id,
      p_fulfilment_type: decision.kind,
      p_fulfilment_outcome: decision.outcome,
      p_approval_state: approval,
      p_correlation_id: row.correlation_id,
      p_review_audit_id: input.review_audit_id,
      p_sent_audit_id: input.sent_audit_id,
      p_review_resolution_id: input.review_resolution_id,
      p_conversation_id: row.conversation_id,
      p_enquiry_id: row.enquiry_id,
      p_lead_id: row.lead_id,
      p_customer_ref: row.customer_ref,
      p_action_id: row.action_id,
      p_execution_id: row.execution_id,
      // The booking payload — read straight from the DECISION (which carried it through from the authorisation),
      // so the ledger row can never drift from what was fulfilled.
      p_job_type: decision.booking.job_type,
      p_postcode: decision.booking.postcode,
      p_phone_number: decision.booking.phone_number,
      p_metadata: {},
    });
    if (error || !data) {
      console.error("[receptionist] conversation fulfilment ledger write failed", error?.message ?? null);
      return null;
    }
    return { fulfilment_id: data, fulfilment_type: decision.kind, fulfilment_outcome: decision.outcome };
  } catch (e) {
    console.error("[receptionist] conversation fulfilment threw", e);
    return null;
  }
}
