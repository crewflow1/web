// =====================================================================
// THE CONVERSATION RECOVERY ENGINE — PURE CORE (CEO Directive #018; R32: CONVERSATION RECOVERY ENGINE).
//
// R17–R25 built the DERIVING stack; R26 RESOLVES an outcome, R27 PREPARES an action, R28 DECIDES an execution's
// eligibility, R29 DETERMINES whether that decided execution requires APPROVAL, R30 PERFORMS the approved internal
// business operation (booking fulfilment), and R31 VERIFIES that performed operation — reconciling the decision
// against the record and reporting an INTEGRITY verdict (consistent / missing / inconsistent). R32 is the NEXT —
// and, in this stack, the SECOND engine that does not perform: the single, canonical authority over a THIRTEENTH
// question, one derived from the Verification Decision above it — "given a fulfilment the stack VERIFIED, does that
// verdict REQUIRE recovery, and if so, of what KIND?" — the RECOVERY DECISION. Fulfilment recovery is the FIRST
// recovery type expressed here — `recover_booking_fulfilment`, the classification of a verified booking fulfilment's
// verdict into the recovery it warrants — but it is one member of the recovery vocabulary, not the engine's purpose.
//
// IT DETERMINES RECOVERY — IT NEVER EXECUTES IT. Unlike R30 (whose decision is the GO-AHEAD to carry out an approved
// operation), the Recovery Engine's decision performs NO business action: it CLASSIFIES a verification verdict into a
// recovery {@link RecoveryClassification} and reports WHETHER recovery is required. It re-books nothing, retries
// nothing, schedules nothing and reaches no provider. It is the layer that turns R31's observable INTEGRITY signal
// into an auditable, actionable RECOVERY DISPOSITION — the determination a future, explicitly-authorised operational
// capability reads and acts on. Automatic retries, automatic booking recreation and automatic scheduling are EXPLICIT
// R32 non-goals: this engine says WHAT recovery is warranted, never DOES it.
//
// THE VERIFICATION ENGINE REMAINS AUTHORITATIVE — THE RECOVERY ENGINE CONSUMES ITS DECISION, IT NEVER RE-DERIVES IT.
// {@link resolveRecovery} takes the R31 {@link VerificationDecision} as its ONLY input, and its FIRST gate DEFERS:
// when the Verification Engine rendered NO decision (an abstention — nothing was verified, so there is nothing to
// recover), the Recovery Engine stands down (`no_verification_decision`). Because a decided verification only exists
// when R31 reconciled a DECIDED fulfilment (which only exists for an approved R30 go-ahead, which needs the approved
// R29 authorisation, the R28 execution, the R27 action and the R26 outcome), deferring to the Verification Engine
// here TRANSITIVELY preserves the Fulfilment, Authorisation, Execution, Action and Outcome Engines' authority too.
// The INTEGRITY verdict is NEVER recomputed here: it is the verification decision's own finding, handed in — this
// engine READS the verdict, it never re-verifies. No duplicate verification logic; no duplicate recovery logic.
//
// HUMAN REVIEW & POLICY STAY MANDATORY — TRANSITIVELY, THROUGH THE VERIFICATION IT CONSUMES. A decided verification
// exists ONLY for an APPROVED authorisation (R31's inherited gate, R30's keystone), which arises ONLY from the
// EXISTING Human Review architecture (R14's `receptionist_review_resolutions`, a `sent` resolution, folded to
// `approved` by R29) and can NEVER exist for a policy-blocked booking (foreclosed at R29, never revivable). So the
// Recovery Engine determines recovery ONLY for human-approved, policy-cleared, verified operations — by
// construction, without importing a policy module or recording a grant. This engine imports NO policy surface and
// names NO guardrail decision function.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING AND RECOVERS NOTHING ITSELF. Like R26–R31, the recovery
// DECISION is a TOTAL, DETERMINISTIC function of an already-computed input — the R31 verification decision. The pure
// core adds NO column and NO migration, reaches NO provider, NO ledger, NO DB, NO clock, NO RNG, NO org lookup, NO
// env read and — the cardinal rule shared with the whole stack — NO MODEL: the same verification decision always
// yields the same recovery decision. WHETHER a recovery is determined (the verification read and the record filed)
// and IDEMPOTENTLY recorded is the server runtime's job, behind its own append-only, service-role-only, idempotent
// ledger. The pure core names the recovery and stops.
//
// EXPLICIT R32 NON-GOALS no layer here performs: automatic retries, automatic booking recreation, automatic
// scheduling, quote fulfilment, customer promotion, memory retrieval, customer-portal conversations, and voice /
// WhatsApp / email. The "recovery" R32 performs is the INTERNAL determination — the durable, auditable classification
// of a verified verdict into the recovery it warrants (or the observable `none` when the operation was consistent) —
// which is the disposition future, explicitly-authorised operational capabilities read and act on.
// =====================================================================

import {
  isVerificationDecided,
  type VerificationDecision,
  type VerifyBookingDecision,
  type VerificationIntegrity,
  type ConversationVerificationType,
} from "@/lib/receptionist/conversation-verification";

// ---------------------------------------------------------------------
// The RECOVERY vocabulary — the closed set of recovery types, determined outcomes and recovery classifications.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of RECOVERY TYPES — the kinds of verified verdict this engine can determine recovery for. R32
 * ships exactly ONE:
 *   • recover_booking_fulfilment — the classification of a decided `verify_booking_fulfilment` verdict into the
 *                                  recovery it warrants. It DETERMINES the recovery; it never re-books, retries,
 *                                  schedules, promotes a customer or reaches a comms provider (all EXPLICIT R32
 *                                  non-goals).
 * Quote-fulfilment recovery, scheduling-fulfilment recovery and every future recovery type are EXPLICIT R32
 * non-goals, so their recovery types are deliberately ABSENT — a future increment ADDS them here (and to the
 * ledger's CHECK) as an explicit, reviewable act. A closed const tuple, so {@link ConversationRecoveryType} is
 * exactly these members and a consumer can switch exhaustively.
 */
export const RECOVERY_TYPES = ["recover_booking_fulfilment"] as const;

/** One recovery type the engine can determine. */
export type ConversationRecoveryType = (typeof RECOVERY_TYPES)[number];

/**
 * The closed vocabulary of RECOVERY OUTCOMES — the DETERMINED result of running a recovery. R32 ships exactly ONE:
 *   • fulfilment_recovery_determined — a recovery disposition was determined for the verified fulfilment. This is the
 *                                      INTERNAL operation R32 performs: the durable record that a determination was
 *                                      carried out. WHETHER recovery is required and of WHAT kind is the separate
 *                                      {@link RecoveryClassification} + {@link RecoverBookingDecision.recovery_required}.
 *                                      The outcome says "a recovery was determined"; the classification says "what it
 *                                      warrants".
 * A closed union so a consumer can switch exhaustively over every determined result.
 */
export type RecoveryOutcome = "fulfilment_recovery_determined";

/**
 * The closed vocabulary of RECOVERY CLASSIFICATIONS — the KIND of recovery a verified verdict warrants:
 *   • none      — the verification was `consistent`; the approved operation completed correctly, so NO recovery is
 *                 required. A determination is still filed (recovery was considered and found unnecessary).
 *   • reinstate — the verification was `missing` (an approved operation the stack decided to perform, but with NO
 *                 record). The operation must be REINSTATED — but that is a future, explicitly-authorised capability's
 *                 job; R32 only CLASSIFIES it as warranting reinstatement (it re-books nothing).
 *   • reconcile — the verification was `inconsistent` (a record exists but diverges from the decision). The record
 *                 must be RECONCILED — but, again, R32 only CLASSIFIES it as warranting reconciliation (it corrects
 *                 nothing).
 * A closed union so the recovery classification is exhaustive. It is a TOTAL, DETERMINISTIC fold of the R31
 * {@link VerificationIntegrity} verdict — this is the determination, NOT an abstention: a recovery record is produced
 * for ALL three classifications (`none` is the determination "no recovery required", not "nothing to determine").
 */
export type RecoveryClassification = "none" | "reinstate" | "reconcile";

/**
 * The verification-type → recovery-type mapping — which RECOVERY TYPE each decided
 * {@link ConversationVerificationType} is recovered as, or `null` when the verification type has no R32 recovery.
 * TOTAL over the whole verification vocabulary — the `Record` type makes the exhaustiveness a COMPILE-TIME guarantee,
 * so this map and the R31 verification vocabulary can never drift (a new verification type cannot be added without
 * deciding its recovery here). R31 ships `verify_booking_fulfilment`, which maps to `recover_booking_fulfilment`; a
 * future verification type maps to its own recovery type (or `null` until one is added) as an explicit, reviewable
 * act.
 */
export const VERIFICATION_RECOVERY: Readonly<
  Record<ConversationVerificationType, ConversationRecoveryType | null>
> = {
  verify_booking_fulfilment: "recover_booking_fulfilment",
};

// ---------------------------------------------------------------------
// The RECOVERY model — the resolved recovery decision for a verification.
// ---------------------------------------------------------------------

/**
 * The EXPECTED booking a recovery is determined for — carried through, BY REFERENCE, from the R31 verification
 * decision (which itself carried it from the R30 fulfilment decision). Referenced via indexed access so this core's
 * ONLY import stays the verification surface it consumes — the booking type is the verification decision's own,
 * never re-modelled here.
 */
export type RecoveryBooking = VerifyBookingDecision["booking"];

/**
 * The RECOVER-BOOKING-FULFILMENT decision — the first (and only R32) recovery decision. It is the auditable
 * determination of classifying a verified booking fulfilment's verdict into the recovery it warrants, carrying the
 * determined {@link RecoveryOutcome} (`fulfilment_recovery_determined`), the {@link RecoveryClassification} it folded
 * to (`none` / `reinstate` / `reconcile`), the `recovery_required` flag (false iff `none`), the SOURCE
 * {@link VerificationIntegrity} verdict it classified (for audit + coherence) and the EXPECTED {@link RecoveryBooking}
 * payload (what SHOULD have been performed), so the decision is self-describing for the recovery ledger. It is
 * emitted ONLY for a DECIDED `verify_booking_fulfilment` verification — it can carry no other verification, and it
 * cannot exist without a verified operation to recover.
 */
export type RecoverBookingDecision = {
  readonly kind: "recover_booking_fulfilment";
  readonly outcome: RecoveryOutcome;
  readonly classification: RecoveryClassification;
  readonly recovery_required: boolean;
  readonly integrity: VerificationIntegrity;
  readonly booking: RecoveryBooking;
};

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the engine determined NO recovery. An abstention is not an
 * error; it is the honest "nothing to recover here" for the overwhelming majority of turns:
 *   • no_verification_decision  — the R31 Verification Engine rendered NO decision (an abstention — nothing was
 *                                 verified). There is nothing to recover, so the Recovery Engine defers. This is the
 *                                 FIRST gate — the Verification Engine (and transitively Fulfilment, Authorisation,
 *                                 Execution, Action and Outcome) stays authoritative.
 *   • unsupported_verification  — a verification WAS decided, but its type maps to no R32 recovery type (defence in
 *                                 depth: R31 ships only `verify_booking_fulfilment`, which maps to
 *                                 `recover_booking_fulfilment`, so this is unreachable today; it becomes live only if
 *                                 a future verification type is added to R31 without a matching recovery type here).
 * A closed union so {@link RecoveryDecision}'s abstention arm is exhaustive. NOTE: `none` is NOT an abstention — it
 * is a `recovery_required = false` CLASSIFICATION on a produced recovery decision (a consistent verdict warrants no
 * recovery, but the determination is still filed).
 */
export type RecoveryAbstention = "no_verification_decision" | "unsupported_verification";

/**
 * The conversational RECOVERY DECISION — a discriminated union the runtime reads:
 *   • a DECIDED arm ({@link RecoverBookingDecision}, and future recovery types) — the auditable determination of a
 *     recovery, carrying the {@link RecoveryClassification} and the `recovery_required` flag. Its `kind` IS its
 *     {@link ConversationRecoveryType}. A decided arm is produced for a `none`, a `reinstate` and a `reconcile`
 *     classification alike — the classification differs, not the presence of a determination.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no recovery, tagged with WHY ({@link RecoveryAbstention}).
 *     The overwhelmingly common case (every turn that was not a decided verification). NOTE the two distinct uses of
 *     the word "none": the abstention arm's `kind: "none"` means "no determination"; a decided arm's
 *     `classification: "none"` means "a determination that no recovery is required".
 * Every field is a total, deterministic function of the verification decision; the whole object is derived, never
 * persisted or executed by this core.
 */
export type RecoveryDecision =
  | RecoverBookingDecision
  | { readonly kind: "none"; readonly reason: RecoveryAbstention };

// ---------------------------------------------------------------------
// RESOLUTION — the single derived recovery decision. Defers to the verification; total over the input.
// ---------------------------------------------------------------------

/** The abstention decision for a reason — the single shape of "no recovery". */
function abstain(reason: RecoveryAbstention): RecoveryDecision {
  return { kind: "none", reason };
}

/**
 * The RECOVERY CLASSIFICATION for an integrity verdict — the deterministic fold at the heart of the engine. A
 * `consistent` verdict warrants NO recovery (`none`); a `missing` verdict warrants REINSTATEMENT of the unrecorded
 * operation (`reinstate`); an `inconsistent` verdict warrants RECONCILIATION of the divergent record (`reconcile`).
 * A closed switch, so adding a {@link VerificationIntegrity} member without folding it here fails `tsc`.
 */
function classificationOf(integrity: VerificationIntegrity): RecoveryClassification {
  switch (integrity) {
    case "consistent":
      return "none";
    case "missing":
      return "reinstate";
    case "inconsistent":
      return "reconcile";
  }
}

/**
 * Resolve the RECOVERY DECISION for a verification — THE single entry point the runtime reads. Consumes the one
 * already-computed input it determines recovery over: the R31 `verification` decision (the DEFERRAL gate — when the
 * Verification Engine rendered no decision, the Recovery Engine stands down).
 *
 * Pure, TOTAL over any verification decision, and DETERMINISTIC — the same verification always yields the same
 * recovery decision. The Verification Engine stays AUTHORITATIVE: the FIRST gate defers to it (and transitively to
 * Fulfilment, Authorisation, Execution, Action and Outcome). Human Review and Policy stay MANDATORY: a decided
 * verification only exists for a human-approved, policy-cleared operation, so this engine determines recovery for
 * nothing else — without importing a policy module or recording a grant. Persists NOTHING and recovers NOTHING
 * itself — the runtime reads the verification and IDEMPOTENTLY records the determination. THE single source of truth
 * for whether a verified fulfilment requires recovery — every consumer resolves it through this function and no other
 * way; no feature implements independent recovery logic.
 */
export function resolveRecovery(verification: VerificationDecision): RecoveryDecision {
  // THE VERIFICATION ENGINE IS AUTHORITATIVE. If R31 rendered NO decision (an abstention — nothing was verified, so
  // nothing to recover), the Recovery Engine defers. This is the first thing the engine checks — it CONSUMES the
  // verification decision, it never overrides it. Because a decided verification exists ONLY when R31 reconciled a
  // decided fulfilment (which needs the approved R30 go-ahead, the approved R29 authorisation, the R28 execution, the
  // R27 action and the R26 outcome), deferring here transitively preserves the whole stack's authority.
  if (!isVerificationDecided(verification)) return abstain("no_verification_decision");

  // The decided verification selects its recovery type. R31 ships only `verify_booking_fulfilment` (→
  // `recover_booking_fulfilment`); a null here would mean a future verification type reached this engine before its
  // recovery type was added — defence in depth, unreachable today, but keeps the map and the vocabulary honest.
  const recoveryType = VERIFICATION_RECOVERY[verification.kind];
  if (recoveryType === null) return abstain("unsupported_verification");

  // Render the determination — the WORK this engine performs. A closed switch keeps this exhaustive as the vocabulary
  // grows: adding a RECOVERY_TYPE without a case here fails `tsc`. The classification (`none` / `reinstate` /
  // `reconcile`) is the fold of the integrity verdict; the decision is produced for ALL three — determining that a
  // `missing` or `inconsistent` operation warrants recovery (and that a `consistent` one does not) is the whole
  // purpose of the engine.
  switch (recoveryType) {
    case "recover_booking_fulfilment": {
      // The classification is the deterministic fold of the verification's OWN integrity verdict; `recovery_required`
      // is its coherent companion (true iff the classification is a real recovery, i.e. not `none`). The EXPECTED
      // booking is carried through by reference — so the recovery record is self-describing about what SHOULD have
      // been performed, and can never drift from the verification (or the fulfilment) it recovers.
      const classification = classificationOf(verification.integrity);
      return {
        kind: "recover_booking_fulfilment",
        outcome: "fulfilment_recovery_determined",
        classification,
        recovery_required: classification !== "none",
        integrity: verification.integrity,
        booking: verification.booking,
      };
    }
  }
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a decision the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a decision is DECIDED (a produced recovery determination), as opposed to an abstention. A type guard: it
 * narrows a {@link RecoveryDecision} to its decided arms, so the runtime records ONLY a real determination and an
 * abstention is a total no-op. THE predicate the runtime gates the record on — there is no other "should we
 * determine recovery?" rule. NOTE: a decided recovery may carry ANY classification (including `none`); "decided"
 * means "a determination was made", not "recovery is required".
 */
export function isRecoveryDecided(decision: RecoveryDecision): decision is RecoverBookingDecision {
  return decision.kind !== "none";
}

/**
 * The {@link ConversationRecoveryType} of a decision (for audit/persistence keying), or `null` for an abstention.
 * Pure and total — the decided arm's `kind` IS its recovery type, so the mapping is the identity on the decided arms
 * and `null` on the abstention.
 */
export function recoveryTypeOf(decision: RecoveryDecision): ConversationRecoveryType | null {
  return decision.kind === "none" ? null : decision.kind;
}

/**
 * The {@link RecoveryOutcome} of a decision (for audit/persistence keying), or `null` for an abstention. Pure and
 * total — the determined result the runtime folds onto the ledger row alongside the recovery type.
 */
export function recoveryOutcomeOf(decision: RecoveryDecision): RecoveryOutcome | null {
  return decision.kind === "none" ? null : decision.outcome;
}

/**
 * The {@link RecoveryClassification} of a decision (for audit/persistence keying and disposition reporting), or
 * `null` for an abstention. Pure and total — the fold the runtime folds onto the ledger row, and the disposition
 * future operational capabilities read to determine whether (and how) to recover an operation.
 */
export function recoveryClassificationOf(decision: RecoveryDecision): RecoveryClassification | null {
  return decision.kind === "none" ? null : decision.classification;
}

/**
 * Whether a decision REQUIRES recovery (for audit/persistence keying), or `null` for an abstention. Pure and total —
 * the coherent companion of the classification (true iff the classification is not `none`). The flag a future
 * operational capability reads to decide whether to act at all.
 */
export function recoveryRequiredOf(decision: RecoveryDecision): boolean | null {
  return decision.kind === "none" ? null : decision.recovery_required;
}

/**
 * The SOURCE {@link VerificationIntegrity} verdict a recovery decision classified (for audit/persistence keying), or
 * `null` for an abstention. Pure and total — the verdict the runtime folds onto the ledger row so the recovery is
 * self-describing about the verification finding it recovers.
 */
export function recoveryIntegrityOf(decision: RecoveryDecision): VerificationIntegrity | null {
  return decision.kind === "none" ? null : decision.integrity;
}
