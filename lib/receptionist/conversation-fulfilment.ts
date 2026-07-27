// =====================================================================
// THE CONVERSATION FULFILMENT ENGINE — PURE CORE (CEO Directive #018; R30: CONVERSATION FULFILMENT ENGINE).
//
// R17–R25 built the DERIVING stack (State → Intent → Goal → Information → Gap → Strategy → Prompt → Response →
// Generation). R26 RESOLVES an outcome, R27 PREPARES an action, R28 DECIDES an execution's eligibility, and R29
// DETERMINES whether that decided execution requires APPROVAL. R30 is the NEXT — and, in this stack, the FIRST
// engine that PERFORMS: the single, canonical authority over an ELEVENTH question, one derived from the
// Authorisation Decision above it AND the human's grant beside it — "given an APPROVED authorisation, WHAT
// internal business operation must now be carried out, and over what payload?" — the FULFILMENT DECISION.
// Booking fulfilment is the FIRST fulfilment type expressed here — `fulfil_booking`, the fulfilment that
// materialises an approved booking as an internal record — but it is one member of the fulfilment vocabulary,
// not the engine's purpose.
//
// IT PERFORMS APPROVED WORK — AND ONLY APPROVED WORK. Unlike R26–R29 (each a pure DETERMINATION that persists an
// internal DECISION and performs nothing), the Fulfilment Engine's decision is the GO-AHEAD to carry out an
// approved internal business operation. That is exactly why its single, load-bearing gate is APPROVAL: a
// fulfilment decision is emitted ONLY when the authorisation's terminal state is `approved` — the grant a human
// recorded through the EXISTING Human Review architecture (a `sent` resolution on the held reply, folded to
// `approved` by R29's {@link deriveAuthorisationState}). Every non-approved state (`pending`, `rejected`,
// `foreclosed`) yields `approval_not_granted` and NO fulfilment. The engine therefore CANNOT bypass Human
// Review: without a human's grant there is no path to a fulfilment decision, by construction.
//
// THE AUTHORISATION ENGINE REMAINS AUTHORITATIVE — THE FULFILMENT ENGINE CONSUMES ITS DECISION, IT NEVER
// RE-DERIVES IT. {@link resolveFulfilment} takes the R29 {@link AuthorisationDecision} and its ALREADY-DERIVED
// terminal {@link AuthorisationState} as its ONLY inputs, and its FIRST gate DEFERS: when the Authorisation
// Engine rendered NO decision (an abstention), the Fulfilment Engine stands down (`no_authorisation_decision`) —
// there is nothing to fulfil. Because a decided authorisation only exists when the R28 Execution Engine decided
// (which only happens when the R27 Action Engine prepared an action, which only happens when the R26 Outcome
// Engine abstained), deferring to the Authorisation Engine here TRANSITIVELY preserves the Execution, Action and
// Outcome Engines' authority too. The approval itself is NEVER recomputed here: the terminal state is produced
// by R29's single bridge and handed in — this engine READS the grant, it never re-decides it. No duplicate
// approval logic; no duplicate fulfilment logic.
//
// POLICY STAYS MANDATORY — TRANSITIVELY, THROUGH THE AUTHORISATION IT CONSUMES. This engine imports NO policy
// module and names NO guardrail decision function. A `block` verdict already forced the execution to
// `blocked_by_policy` (R28), which R29 folded to a `foreclosed` authorisation — and a `foreclosed` authorisation
// can NEVER derive to `approved` (R29's `deriveAuthorisationState` keeps `foreclosed` terminal), so a
// policy-blocked booking is structurally unfulfillable here. Policy therefore stays the single arbiter, and its
// refusal PROPAGATES all the way into fulfilment, without this engine ever re-running or re-importing the
// guardrail.
//
// HUMAN REVIEW STAYS MANDATORY — THE GRANT IS THE HUMAN'S, AND IT IS THE ONLY KEY THAT OPENS FULFILMENT. The
// terminal `approved` state arises ONLY from the EXISTING Human Review architecture (R14's
// `receptionist_review_resolutions`), folded by R29. This engine consumes that grant; it never records one, and
// it emits a fulfilment decision for no other reason. Human Review is not merely preserved — it is the SOLE
// authoriser of every performed booking, by construction.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING AND PERFORMS NOTHING ITSELF. Like R26–R29, the fulfilment
// DECISION is a TOTAL, DETERMINISTIC function of already-computed inputs — the R29 authorisation decision and its
// derived terminal state. The pure core adds NO column and NO migration, reaches NO provider, NO ledger, NO DB,
// NO clock, NO RNG, NO org lookup, NO env read and — the cardinal rule shared with the whole stack — NO MODEL:
// the same (authorisation, approval) pair always yields the same fulfilment decision. WHETHER a decision is
// carried out (materialised as an internal record) and IDEMPOTENTLY recorded is the server runtime's job, behind
// its own append-only, service-role-only, idempotent ledger. The pure core names the fulfilment and stops.
//
// EXPLICIT R30 NON-GOALS no layer here performs: AI scheduling, calendar placement, quote execution, customer
// promotion, memory retrieval, customer-portal conversations, voice / WhatsApp / email, retry orchestration and
// receipt reconciliation. The "internal business operation" R30 performs is the MATERIALISATION of an approved
// booking as an internal record — the durable, auditable, idempotent record that a human-approved booking has
// been carried out — which is the exposure future, explicitly-authorised business capabilities read and act on.
// =====================================================================

import {
  isAuthorisationDecided,
  type AuthorisationDecision,
  type AuthorisationState,
  type ConversationAuthorisationType,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";

// ---------------------------------------------------------------------
// The FULFILMENT vocabulary — the closed set of fulfilment types and the performed outcomes.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of FULFILMENT TYPES — the kinds of approved authorisation this engine can carry out. R30
 * ships exactly ONE:
 *   • fulfil_booking — the fulfilment of an approved `approve_booking` authorisation: MATERIALISE the approved
 *                      booking as an internal record. It performs the INTERNAL business operation; it never
 *                      writes a calendar, schedules, promotes a customer or reaches a comms provider (all EXPLICIT
 *                      R30 non-goals).
 * Quote fulfilment, scheduling fulfilment, promotion fulfilment and every future fulfilment type are EXPLICIT R30
 * non-goals, so their fulfilment types are deliberately ABSENT — a future increment ADDS them here (and to the
 * ledger's CHECK) as an explicit, reviewable act. A closed const tuple, so {@link ConversationFulfilmentType} is
 * exactly these members and a consumer can switch exhaustively.
 */
export const FULFILMENT_TYPES = ["fulfil_booking"] as const;

/** One fulfilment type the engine can carry out. */
export type ConversationFulfilmentType = (typeof FULFILMENT_TYPES)[number];

/**
 * The closed vocabulary of FULFILMENT OUTCOMES — the PERFORMED result of carrying out a fulfilment. R30 ships
 * exactly ONE:
 *   • booking_recorded — the approved booking was materialised as an internal record. This is the INTERNAL
 *                        operation R30 performs: the durable record that a human-approved booking has been
 *                        carried out. It is deliberately NOT "booking_scheduled" or "calendar_written" — those
 *                        external effects are R30 non-goals.
 * A closed union so a consumer can switch exhaustively over every performed result.
 */
export type FulfilmentOutcome = "booking_recorded";

/**
 * The authorisation-type → fulfilment-type mapping — which FULFILMENT TYPE each decided
 * {@link ConversationAuthorisationType} is carried out as, or `null` when the authorisation type has no R30
 * fulfilment. TOTAL over the whole authorisation vocabulary — the `Record` type makes the exhaustiveness a
 * COMPILE-TIME guarantee, so this map and the R29 authorisation vocabulary can never drift (a new authorisation
 * type cannot be added without deciding its fulfilment here). R29 ships `approve_booking`, which maps to
 * `fulfil_booking`; a future authorisation type maps to its own fulfilment type (or `null` until one is added) as
 * an explicit, reviewable act.
 */
export const AUTHORISATION_FULFILMENT: Readonly<
  Record<ConversationAuthorisationType, ConversationFulfilmentType | null>
> = {
  approve_booking: "fulfil_booking",
};

// ---------------------------------------------------------------------
// The FULFILMENT model — the resolved fulfilment decision for an approved authorisation.
// ---------------------------------------------------------------------

/**
 * The booking payload a fulfilment materialises — the exact `prepare_booking` action the whole stack decided
 * over (R27 prepared it, R28 decided over it, R29 authorised it), reached here through the approved
 * authorisation. Structurally the authorisation's `execution.action`, so it can never drift from the decision it
 * fulfils.
 */
export type FulfilmentBooking = ApproveBookingAuthorisation["execution"]["action"];

/**
 * The FULFIL-BOOKING decision — the first (and only R30) fulfilment decision. It is the GO-AHEAD to materialise
 * an approved booking, carrying the performed {@link FulfilmentOutcome} (`booking_recorded`) and the exact
 * {@link FulfilmentBooking} payload to record (so the decision is self-describing for the fulfilment ledger). It
 * is emitted ONLY for an APPROVED `approve_booking` authorisation — it can carry no other authorisation, and it
 * cannot exist without the human's grant.
 */
export type FulfilBookingDecision = {
  readonly kind: "fulfil_booking";
  readonly outcome: FulfilmentOutcome;
  readonly booking: FulfilmentBooking;
};

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the engine carried out NO fulfilment. An abstention is not
 * an error; it is the honest "nothing to fulfil here" for the overwhelming majority of authorisations:
 *   • no_authorisation_decision — the R29 Authorisation Engine rendered NO decision (an abstention). There is
 *                                 nothing to fulfil, so the Fulfilment Engine defers. This is the FIRST gate —
 *                                 the Authorisation Engine (and transitively Execution, Action and Outcome) stays
 *                                 authoritative.
 *   • approval_not_granted      — an authorisation WAS decided, but its terminal state is not `approved` (it is
 *                                 `pending`, `rejected` or `foreclosed`). The HUMAN REVIEW GATE: without a human's
 *                                 grant there is nothing to carry out. This is the reason that makes "never bypass
 *                                 Human Review" structural.
 *   • unsupported_authorisation — an authorisation was decided AND approved, but its type maps to no R30
 *                                 fulfilment type (defence in depth: R29 ships only `approve_booking`, which maps
 *                                 to `fulfil_booking`, so this is unreachable today; it becomes live only if a
 *                                 future authorisation type is added to R29 without a matching fulfilment type
 *                                 here).
 * A closed union so {@link FulfilmentDecision}'s abstention arm is exhaustive.
 */
export type FulfilmentAbstention =
  | "no_authorisation_decision"
  | "approval_not_granted"
  | "unsupported_authorisation";

/**
 * The conversational FULFILMENT DECISION — a discriminated union the runtime reads:
 *   • a DECIDED arm ({@link FulfilBookingDecision}, and future fulfilment types) — the go-ahead to carry out a
 *     concrete internal business operation over a concrete payload. Its `kind` IS its
 *     {@link ConversationFulfilmentType}.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no fulfilment, tagged with WHY
 *     ({@link FulfilmentAbstention}). The overwhelmingly common case (every authorisation that is not an approved
 *     booking).
 * Every field is a total, deterministic function of the authorisation decision and its derived terminal state;
 * the whole object is derived, never persisted or performed by this core.
 */
export type FulfilmentDecision =
  | FulfilBookingDecision
  | { readonly kind: "none"; readonly reason: FulfilmentAbstention };

// ---------------------------------------------------------------------
// RESOLUTION — the single derived fulfilment decision. Gated on the human's grant; total over the inputs.
// ---------------------------------------------------------------------

/** The abstention decision for a reason — the single shape of "no fulfilment". */
function abstain(reason: FulfilmentAbstention): FulfilmentDecision {
  return { kind: "none", reason };
}

/**
 * Resolve the FULFILMENT DECISION for an approved authorisation — THE single entry point the runtime reads.
 * Consumes the two already-computed inputs it fulfils over: the R29 `authorisation` decision (the DEFERRAL gate —
 * when the Authorisation Engine rendered no decision, the Fulfilment Engine stands down) and its ALREADY-DERIVED
 * terminal `approval` state (produced by R29's {@link deriveAuthorisationState} from the human's Human Review
 * resolution — this engine READS it, it never recomputes it).
 *
 * Pure, TOTAL over any (authorisation, approval) pair, and DETERMINISTIC — the same pair always yields the same
 * fulfilment decision. The Authorisation Engine stays AUTHORITATIVE: the FIRST gate defers to it (and transitively
 * to Execution, Action and Outcome). Human Review stays MANDATORY and SOLE: a fulfilment decision is emitted ONLY
 * when `approval` is `approved` — every other terminal state yields `approval_not_granted`, so there is no path to
 * carrying out a booking without the human's grant. Policy stays MANDATORY: a policy-blocked booking foreclosed at
 * R29 can never derive to `approved`, so it can never reach a fulfilment decision here. Persists NOTHING and
 * performs NOTHING — the runtime decides whether and how to carry out and IDEMPOTENTLY record the decision. THE
 * single source of truth for what an approved authorisation must fulfil — every consumer resolves it through this
 * function and no other way; no feature implements independent fulfilment logic.
 */
export function resolveFulfilment(
  authorisation: AuthorisationDecision,
  approval: AuthorisationState,
): FulfilmentDecision {
  // THE AUTHORISATION ENGINE IS AUTHORITATIVE. If R29 rendered NO decision (an abstention), there is nothing to
  // fulfil and the Fulfilment Engine defers. This is the first thing the engine checks — it CONSUMES the
  // authorisation decision, it never overrides it. Because a decided authorisation exists ONLY when the R28
  // Execution Engine decided (which needs the R27 action, which needs the R26 outcome to abstain), deferring here
  // transitively preserves the whole stack's authority.
  if (!isAuthorisationDecided(authorisation)) return abstain("no_authorisation_decision");

  // The decided authorisation selects its fulfilment type. R29 ships only `approve_booking` (→ `fulfil_booking`);
  // a null here would mean a future authorisation type reached this engine before its fulfilment type was added —
  // defence in depth, unreachable today, but keeps the map and the vocabulary honest.
  const fulfilmentType = AUTHORISATION_FULFILMENT[authorisation.kind];
  if (fulfilmentType === null) return abstain("unsupported_authorisation");

  // THE HUMAN REVIEW GATE — the load-bearing R30 invariant. A fulfilment is carried out ONLY for an APPROVED
  // authorisation: the grant a human recorded in the EXISTING Human Review ledger (a `sent` resolution), folded to
  // `approved` by R29. Every other terminal state — `pending` (awaiting the human), `rejected` (the human
  // refused) or `foreclosed` (blocked upstream, and never revivable) — yields NO fulfilment. This is what makes
  // "never bypass Human Review" STRUCTURAL: there is no path past this gate without the human's grant.
  if (approval !== "approved") return abstain("approval_not_granted");

  // Render the performed outcome + payload for the fulfilment type. A closed switch keeps this exhaustive as the
  // vocabulary grows: adding a FULFILMENT_TYPE without a case here fails `tsc`.
  switch (fulfilmentType) {
    case "fulfil_booking": {
      // The approved booking is materialised as an internal record. The payload is the exact `prepare_booking`
      // action the whole stack decided over, carried through the authorisation — it can never drift from the
      // decision it fulfils.
      return { kind: "fulfil_booking", outcome: "booking_recorded", booking: authorisation.execution.action };
    }
  }
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a decision the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a decision is DECIDED (a go-ahead to carry out a concrete fulfilment), as opposed to an abstention. A
 * type guard: it narrows a {@link FulfilmentDecision} to its decided arms, so the runtime carries out and records
 * ONLY a real decision and an abstention is a total no-op. THE predicate the runtime gates the operation on —
 * there is no other "should we fulfil?" rule.
 */
export function isFulfilmentDecided(decision: FulfilmentDecision): decision is FulfilBookingDecision {
  return decision.kind !== "none";
}

/**
 * The {@link ConversationFulfilmentType} of a decision (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the decided arm's `kind` IS its fulfilment type, so the mapping is the identity on
 * the decided arms and `null` on the abstention.
 */
export function fulfilmentTypeOf(decision: FulfilmentDecision): ConversationFulfilmentType | null {
  return decision.kind === "none" ? null : decision.kind;
}

/**
 * The {@link FulfilmentOutcome} of a decision (for audit/persistence keying), or `null` for an abstention. Pure
 * and total — the performed result the runtime folds onto the ledger row alongside the fulfilment type.
 */
export function fulfilmentOutcomeOf(decision: FulfilmentDecision): FulfilmentOutcome | null {
  return decision.kind === "none" ? null : decision.outcome;
}
