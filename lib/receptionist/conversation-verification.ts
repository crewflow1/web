// =====================================================================
// THE CONVERSATION VERIFICATION ENGINE — PURE CORE (CEO Directive #018; R31: CONVERSATION VERIFICATION ENGINE).
//
// R17–R25 built the DERIVING stack; R26 RESOLVES an outcome, R27 PREPARES an action, R28 DECIDES an execution's
// eligibility, R29 DETERMINES whether that decided execution requires APPROVAL, and R30 PERFORMS the approved
// internal business operation (booking fulfilment). R31 is the NEXT — and, in this stack, the FIRST engine that
// VERIFIES: the single, canonical authority over a TWELFTH question, one derived from the Fulfilment Decision
// above it AND the durable record of what was actually performed beside it — "given a fulfilment the stack decided
// to perform, did it complete CORRECTLY — is the recorded operation CONSISTENT with the decision, or is it MISSING
// or INCONSISTENT?" — the VERIFICATION DECISION. Fulfilment reconciliation is the FIRST verification type expressed
// here — `verify_booking_fulfilment`, the reconciliation of a decided booking fulfilment against the internal
// record R30 filed — but it is one member of the verification vocabulary, not the engine's purpose.
//
// IT VERIFIES WORK — IT NEVER PERFORMS IT. Unlike R30 (whose decision is the GO-AHEAD to carry out an approved
// operation), the Verification Engine's decision performs NO business action: it RECONCILES a decision against a
// record and reports the {@link VerificationIntegrity} it found. It reaches no provider, writes no tenant row and
// executes no further fulfilment. It is the independent check ON R30 — the layer that turns R30's best-effort
// bookkeeping write into an observable, auditable INTEGRITY signal.
//
// THE FULFILMENT ENGINE REMAINS AUTHORITATIVE — THE VERIFICATION ENGINE CONSUMES ITS DECISION, IT NEVER RE-DERIVES
// IT. {@link resolveVerification} takes the R30 {@link FulfilmentDecision} and the RECORDED
// {@link RecordedFulfilmentSnapshot} (or its ABSENCE) as its ONLY inputs, and its FIRST gate DEFERS: when the
// Fulfilment Engine rendered NO decision (an abstention — nothing was to be performed), the Verification Engine
// stands down (`no_fulfilment_decision`) — there is nothing to verify. Because a decided fulfilment only exists
// when R30 emitted an APPROVED go-ahead (which only happens for an approved R29 authorisation, which needs the R28
// execution, the R27 action and the R26 outcome to abstain), deferring to the Fulfilment Engine here TRANSITIVELY
// preserves the Authorisation, Execution, Action and Outcome Engines' authority too. The EXPECTED shape is NEVER
// re-modelled here: it is the decided fulfilment's own payload, handed in — this engine READS the decision, it
// never re-decides what should have been performed. No duplicate fulfilment logic; no duplicate verification logic.
//
// HUMAN REVIEW & POLICY STAY MANDATORY — TRANSITIVELY, THROUGH THE FULFILMENT IT CONSUMES. A decided fulfilment
// exists ONLY for an APPROVED authorisation (R30's load-bearing gate), which arises ONLY from the EXISTING Human
// Review architecture (R14's `receptionist_review_resolutions`, a `sent` resolution, folded to `approved` by R29)
// and can NEVER exist for a policy-blocked booking (foreclosed at R29, never revivable). So the Verification Engine
// verifies ONLY human-approved, policy-cleared operations — by construction, without importing a policy module or
// recording a grant. This engine imports NO policy surface and names NO guardrail decision function.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING AND VERIFIES NOTHING ITSELF. Like R26–R30, the verification
// DECISION is a TOTAL, DETERMINISTIC function of already-computed inputs — the R30 fulfilment decision and the
// recorded snapshot. The pure core adds NO column and NO migration, reaches NO provider, NO ledger, NO DB, NO
// clock, NO RNG, NO org lookup, NO env read and — the cardinal rule shared with the whole stack — NO MODEL: the
// same (fulfilment, recorded) pair always yields the same verification decision. WHETHER a verification is
// performed (the reconciliation reader run and the record filed) and IDEMPOTENTLY recorded is the server runtime's
// job, behind its own append-only, service-role-only, idempotent ledger. The pure core names the integrity and
// stops.
//
// EXPLICIT R31 NON-GOALS no layer here performs: AI scheduling, quote fulfilment, customer promotion, memory
// retrieval, customer-portal conversations, voice / WhatsApp / email, retry orchestration and receipt
// reconciliation. The "verification" R31 performs is the INTERNAL reconciliation of a decided fulfilment against
// the internal record R30 filed — the durable, auditable determination that a human-approved operation completed
// correctly (or the observable detection that it is MISSING or INCONSISTENT) — which is the signal future,
// explicitly-authorised fulfilment capabilities read and act on.
// =====================================================================

import {
  isFulfilmentDecided,
  type FulfilmentDecision,
  type FulfilBookingDecision,
  type FulfilmentBooking,
  type ConversationFulfilmentType,
} from "@/lib/receptionist/conversation-fulfilment";

// ---------------------------------------------------------------------
// The VERIFICATION vocabulary — the closed set of verification types, performed outcomes and integrity verdicts.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of VERIFICATION TYPES — the kinds of fulfilment this engine can verify. R31 ships exactly
 * ONE:
 *   • verify_booking_fulfilment — the reconciliation of a decided `fulfil_booking` fulfilment against the internal
 *                                 record R30 filed. It performs the INTERNAL reconciliation; it never re-performs
 *                                 the booking, schedules, promotes a customer or reaches a comms provider (all
 *                                 EXPLICIT R31 non-goals).
 * Quote-fulfilment verification, scheduling-fulfilment verification and every future verification type are EXPLICIT
 * R31 non-goals, so their verification types are deliberately ABSENT — a future increment ADDS them here (and to
 * the ledger's CHECK) as an explicit, reviewable act. A closed const tuple, so {@link ConversationVerificationType}
 * is exactly these members and a consumer can switch exhaustively.
 */
export const VERIFICATION_TYPES = ["verify_booking_fulfilment"] as const;

/** One verification type the engine can perform. */
export type ConversationVerificationType = (typeof VERIFICATION_TYPES)[number];

/**
 * The closed vocabulary of VERIFICATION OUTCOMES — the PERFORMED result of running a verification. R31 ships
 * exactly ONE:
 *   • fulfilment_reconciled — the decided fulfilment was reconciled against the recorded operation. This is the
 *                             INTERNAL operation R31 performs: the durable record that a reconciliation was carried
 *                             out. The VERDICT of that reconciliation (was it consistent, missing or inconsistent?)
 *                             is the separate {@link VerificationIntegrity}. The outcome says "a verification
 *                             happened"; the integrity says "what it found".
 * A closed union so a consumer can switch exhaustively over every performed result.
 */
export type VerificationOutcome = "fulfilment_reconciled";

/**
 * The closed vocabulary of INTEGRITY VERDICTS — the RESULT of reconciling a decided fulfilment against the record:
 *   • consistent   — a fulfilment WAS recorded, and it matches the decision (same type, outcome, approval, status
 *                    and booking payload). The approved operation completed correctly.
 *   • missing      — the fulfilment was decided (an approved operation the stack said to perform) but NO record
 *                    exists. This is the observable detection of R30's best-effort gap — an approved-but-unrecorded
 *                    operation.
 *   • inconsistent — a fulfilment WAS recorded, but it does NOT match the decision (a drifted payload, a wrong
 *                    outcome). The record contradicts what was decided.
 * A closed union so the integrity verdict is exhaustive. This is the reconciliation's finding — NOT an abstention:
 * a verification record is produced for ALL three verdicts (detecting `missing`/`inconsistent` is the whole point).
 */
export type VerificationIntegrity = "consistent" | "missing" | "inconsistent";

/**
 * The fulfilment-type → verification-type mapping — which VERIFICATION TYPE each decided
 * {@link ConversationFulfilmentType} is verified as, or `null` when the fulfilment type has no R31 verification.
 * TOTAL over the whole fulfilment vocabulary — the `Record` type makes the exhaustiveness a COMPILE-TIME guarantee,
 * so this map and the R30 fulfilment vocabulary can never drift (a new fulfilment type cannot be added without
 * deciding its verification here). R30 ships `fulfil_booking`, which maps to `verify_booking_fulfilment`; a future
 * fulfilment type maps to its own verification type (or `null` until one is added) as an explicit, reviewable act.
 */
export const FULFILMENT_VERIFICATION: Readonly<
  Record<ConversationFulfilmentType, ConversationVerificationType | null>
> = {
  fulfil_booking: "verify_booking_fulfilment",
};

// ---------------------------------------------------------------------
// The RECORDED SNAPSHOT — the internal record R30 filed, as the runtime read it back, that this engine reconciles.
// ---------------------------------------------------------------------

/**
 * The RECORDED fulfilment the engine reconciles a decision against — the R30
 * `receptionist_conversation_fulfilments` row projected to the fields that identify the performed operation, as the
 * runtime's reconciliation reader read them back. Every field is the RAW recorded value (typed `string`, not the
 * narrowed literal), so the reconciliation is a genuine, meaningful field-by-field comparison of what was RECORDED
 * against what was DECIDED — not a tautology over already-narrowed types. Its ABSENCE (a `null` where a snapshot is
 * expected) is the `missing` verdict: the operation was decided but never recorded.
 */
export type RecordedFulfilmentSnapshot = {
  /** The recorded fulfilment type (expected: the decided fulfilment's `kind`). */
  readonly fulfilment_type: string;
  /** The recorded performed outcome (expected: the decided fulfilment's `outcome`). */
  readonly fulfilment_outcome: string;
  /** The recorded grant (expected: `approved` — R30 records nothing else). */
  readonly approval_state: string;
  /** The recorded performed status (expected: `fulfilled` — R30 records nothing else). */
  readonly status: string;
  /** The recorded booking trade (expected: the decided booking's `job_type`). */
  readonly job_type: string;
  /** The recorded booking place (expected: the decided booking's `postcode`). */
  readonly postcode: string;
  /** The recorded booking number (expected: the decided booking's `phone_number`). */
  readonly phone_number: string;
};

// ---------------------------------------------------------------------
// The VERIFICATION model — the resolved verification decision for a fulfilment.
// ---------------------------------------------------------------------

/**
 * The VERIFY-BOOKING-FULFILMENT decision — the first (and only R31) verification decision. It is the auditable
 * finding of reconciling a decided booking fulfilment against its record, carrying the performed
 * {@link VerificationOutcome} (`fulfilment_reconciled`), the {@link VerificationIntegrity} verdict it found
 * (`consistent` / `missing` / `inconsistent`) and the EXPECTED {@link FulfilmentBooking} payload (the decided
 * fulfilment's own booking — what SHOULD have been recorded), so the decision is self-describing for the
 * verification ledger. It is emitted ONLY for a DECIDED `fulfil_booking` fulfilment — it can carry no other
 * fulfilment, and it cannot exist without an approved operation to verify.
 */
export type VerifyBookingDecision = {
  readonly kind: "verify_booking_fulfilment";
  readonly outcome: VerificationOutcome;
  readonly integrity: VerificationIntegrity;
  readonly booking: FulfilmentBooking;
};

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the engine performed NO verification. An abstention is not an
 * error; it is the honest "nothing to verify here" for the overwhelming majority of fulfilments:
 *   • no_fulfilment_decision  — the R30 Fulfilment Engine rendered NO decision (an abstention — the authorisation
 *                               was not approved, or there was nothing to fulfil). There is nothing to verify, so
 *                               the Verification Engine defers. This is the FIRST gate — the Fulfilment Engine (and
 *                               transitively Authorisation, Execution, Action and Outcome) stays authoritative.
 *   • unsupported_fulfilment  — a fulfilment WAS decided, but its type maps to no R31 verification type (defence in
 *                               depth: R30 ships only `fulfil_booking`, which maps to `verify_booking_fulfilment`,
 *                               so this is unreachable today; it becomes live only if a future fulfilment type is
 *                               added to R30 without a matching verification type here).
 * A closed union so {@link VerificationDecision}'s abstention arm is exhaustive. NOTE: `missing` and `inconsistent`
 * are NOT abstentions — they are integrity VERDICTS on a produced verification decision.
 */
export type VerificationAbstention = "no_fulfilment_decision" | "unsupported_fulfilment";

/**
 * The conversational VERIFICATION DECISION — a discriminated union the runtime reads:
 *   • a DECIDED arm ({@link VerifyBookingDecision}, and future verification types) — the auditable finding of a
 *     reconciliation, carrying the {@link VerificationIntegrity} verdict. Its `kind` IS its
 *     {@link ConversationVerificationType}. A decided arm is produced for a CONSISTENT, a MISSING and an
 *     INCONSISTENT reconciliation alike — the verdict differs, not the presence of a record.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no verification, tagged with WHY
 *     ({@link VerificationAbstention}). The overwhelmingly common case (every fulfilment that was not a decided
 *     booking fulfilment).
 * Every field is a total, deterministic function of the fulfilment decision and the recorded snapshot; the whole
 * object is derived, never persisted or performed by this core.
 */
export type VerificationDecision =
  | VerifyBookingDecision
  | { readonly kind: "none"; readonly reason: VerificationAbstention };

// ---------------------------------------------------------------------
// RESOLUTION — the single derived verification decision. Defers to the fulfilment; total over the inputs.
// ---------------------------------------------------------------------

/** The abstention decision for a reason — the single shape of "no verification". */
function abstain(reason: VerificationAbstention): VerificationDecision {
  return { kind: "none", reason };
}

/**
 * Whether a RECORDED snapshot is CONSISTENT with a decided booking fulfilment — a genuine field-by-field
 * reconciliation of what was RECORDED against what was DECIDED. Every recorded value is compared to the decision's
 * own expectation: the type and outcome must equal the decision's, the grant and status must be the values R30
 * records for a performed operation (`approved` / `fulfilled`), and the booking payload (trade, place, number) must
 * equal the decided booking. Any divergence is `inconsistent`; a total match is `consistent`.
 */
function isConsistent(fulfilment: FulfilBookingDecision, recorded: RecordedFulfilmentSnapshot): boolean {
  return (
    recorded.fulfilment_type === fulfilment.kind &&
    recorded.fulfilment_outcome === fulfilment.outcome &&
    recorded.approval_state === "approved" &&
    recorded.status === "fulfilled" &&
    recorded.job_type === fulfilment.booking.job_type &&
    recorded.postcode === fulfilment.booking.postcode &&
    recorded.phone_number === fulfilment.booking.phone_number
  );
}

/**
 * The INTEGRITY verdict for a decided booking fulfilment and the record found for it — the reconciliation itself.
 * A `null` snapshot (no record for a decided operation) is `missing`; a present-but-divergent record is
 * `inconsistent`; a present-and-matching record is `consistent`.
 */
function integrityOf(
  fulfilment: FulfilBookingDecision,
  recorded: RecordedFulfilmentSnapshot | null,
): VerificationIntegrity {
  if (recorded === null) return "missing";
  return isConsistent(fulfilment, recorded) ? "consistent" : "inconsistent";
}

/**
 * Resolve the VERIFICATION DECISION for a fulfilment — THE single entry point the runtime reads. Consumes the two
 * already-computed inputs it verifies over: the R30 `fulfilment` decision (the DEFERRAL gate — when the Fulfilment
 * Engine rendered no decision, the Verification Engine stands down) and the `recorded` snapshot the runtime read
 * back from the R30 ledger (or `null` when no record exists — the `missing` verdict).
 *
 * Pure, TOTAL over any (fulfilment, recorded) pair, and DETERMINISTIC — the same pair always yields the same
 * verification decision. The Fulfilment Engine stays AUTHORITATIVE: the FIRST gate defers to it (and transitively to
 * Authorisation, Execution, Action and Outcome). Human Review and Policy stay MANDATORY: a decided fulfilment only
 * exists for a human-approved, policy-cleared operation, so this engine verifies nothing else — without importing a
 * policy module or recording a grant. Persists NOTHING and verifies NOTHING itself — the runtime runs the
 * reconciliation read and IDEMPOTENTLY records the decision. THE single source of truth for whether an approved
 * fulfilment completed correctly — every consumer resolves it through this function and no other way; no feature
 * implements independent verification logic.
 */
export function resolveVerification(
  fulfilment: FulfilmentDecision,
  recorded: RecordedFulfilmentSnapshot | null,
): VerificationDecision {
  // THE FULFILMENT ENGINE IS AUTHORITATIVE. If R30 rendered NO decision (an abstention — nothing was approved to be
  // performed), there is nothing to verify and the Verification Engine defers. This is the first thing the engine
  // checks — it CONSUMES the fulfilment decision, it never overrides it. Because a decided fulfilment exists ONLY
  // when R30 emitted an approved go-ahead (which needs the approved R29 authorisation, the R28 execution, the R27
  // action and the R26 outcome), deferring here transitively preserves the whole stack's authority.
  if (!isFulfilmentDecided(fulfilment)) return abstain("no_fulfilment_decision");

  // The decided fulfilment selects its verification type. R30 ships only `fulfil_booking` (→
  // `verify_booking_fulfilment`); a null here would mean a future fulfilment type reached this engine before its
  // verification type was added — defence in depth, unreachable today, but keeps the map and the vocabulary honest.
  const verificationType = FULFILMENT_VERIFICATION[fulfilment.kind];
  if (verificationType === null) return abstain("unsupported_fulfilment");

  // Render the reconciliation — the WORK this engine performs. A closed switch keeps this exhaustive as the
  // vocabulary grows: adding a VERIFICATION_TYPE without a case here fails `tsc`. The integrity verdict
  // (`consistent` / `missing` / `inconsistent`) is the finding; the decision is produced for ALL three — detecting
  // a `missing` or `inconsistent` fulfilment is the whole purpose of the engine.
  switch (verificationType) {
    case "verify_booking_fulfilment": {
      // The EXPECTED booking is the decided fulfilment's own payload, carried through by reference — so the
      // verification record is self-describing about what SHOULD have been performed, and can never drift from the
      // decision it verifies.
      return {
        kind: "verify_booking_fulfilment",
        outcome: "fulfilment_reconciled",
        integrity: integrityOf(fulfilment, recorded),
        booking: fulfilment.booking,
      };
    }
  }
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a decision the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a decision is DECIDED (a produced reconciliation finding), as opposed to an abstention. A type guard: it
 * narrows a {@link VerificationDecision} to its decided arms, so the runtime records ONLY a real finding and an
 * abstention is a total no-op. THE predicate the runtime gates the record on — there is no other "should we
 * verify?" rule. NOTE: a decided verification may carry ANY integrity verdict (including `missing`); "decided"
 * means "a reconciliation was performed", not "the fulfilment was consistent".
 */
export function isVerificationDecided(decision: VerificationDecision): decision is VerifyBookingDecision {
  return decision.kind !== "none";
}

/**
 * The {@link ConversationVerificationType} of a decision (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the decided arm's `kind` IS its verification type, so the mapping is the identity on
 * the decided arms and `null` on the abstention.
 */
export function verificationTypeOf(decision: VerificationDecision): ConversationVerificationType | null {
  return decision.kind === "none" ? null : decision.kind;
}

/**
 * The {@link VerificationOutcome} of a decision (for audit/persistence keying), or `null` for an abstention. Pure
 * and total — the performed result the runtime folds onto the ledger row alongside the verification type.
 */
export function verificationOutcomeOf(decision: VerificationDecision): VerificationOutcome | null {
  return decision.kind === "none" ? null : decision.outcome;
}

/**
 * The {@link VerificationIntegrity} verdict of a decision (for audit/persistence keying and reconciliation
 * reporting), or `null` for an abstention. Pure and total — the finding the runtime folds onto the ledger row, and
 * the signal future fulfilment capabilities read to detect a `missing` or `inconsistent` operation.
 */
export function verificationIntegrityOf(decision: VerificationDecision): VerificationIntegrity | null {
  return decision.kind === "none" ? null : decision.integrity;
}
