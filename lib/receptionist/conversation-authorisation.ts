// =====================================================================
// THE CONVERSATION AUTHORISATION ENGINE — PURE CORE (CEO Directive #018; R29: CONVERSATION AUTHORISATION ENGINE).
//
// R17–R25 built the DERIVING stack (State → Intent → Goal → Information → Gap → Strategy → Prompt → Response →
// Generation). R26 added the OUTCOME ENGINE (RESOLVES an internal outcome). R27 added the ACTION ENGINE
// (PREPARES an internal business action). R28 added the EXECUTION ENGINE (DECIDES whether a prepared action is
// ELIGIBLE to execute, and under what authority). R29 is the NEXT layer: the single, canonical authority over a
// TENTH question, one derived from the Execution Decision above it — "given an EXECUTION DECISION, IS approval
// required before this may proceed, and what is the authorisation STATE?" — the AUTHORISATION DECISION. Booking
// approval is the FIRST authorisation type expressed here — `approve_booking`, the authorisation that governs
// whether a decided booking execution may be approved — but it is one member of the authorisation vocabulary,
// not the engine's purpose.
//
// IT DETERMINES APPROVAL — IT DOES NOT EXECUTE. Determining whether an execution decision requires approval is a
// pure CHOICE over the already-decided execution eligibility — an authorisation STATE a human (through the
// EXISTING Human Review architecture) or a future, explicitly-authorised increment later acts on. Actually
// placing the booking, writing a calendar, generating a quote, promoting a customer, scheduling, retrying,
// reconciling a receipt, or reaching any comms provider are EXPLICIT R29 NON-GOALS no layer here performs. This
// pure core names the authorisation and stops. The Authorisation Engine DETERMINES APPROVAL; it does not
// broaden authority beyond the approved scope, and it EXECUTES nothing.
//
// THE EXECUTION ENGINE REMAINS AUTHORITATIVE — THE AUTHORISATION ENGINE CONVERTS ITS RESULT, IT NEVER RE-DERIVES
// IT. {@link resolveAuthorisation} takes the R28 {@link ExecutionDecision} as its ONLY input and its FIRST gate
// DEFERS: when the Execution Engine rendered NO decision (an abstention), the Authorisation Engine stands down
// (`no_execution_decision`) — there is nothing to authorise. Because a decided execution only exists when the
// R27 Action Engine PREPARED an action (the Execution Engine's own first gate defers to the Action Engine),
// deferring to the Execution Engine here TRANSITIVELY preserves the Action Engine's authority too — and, since
// the Action Engine defers to the R26 Outcome Engine, the Outcome Engine's authority as well. The Authorisation
// Engine CONSUMES the execution decision; it NEVER calls `resolveExecution`, `resolveAction`, `resolveOutcome`,
// re-derives the strategy/goal/gap, re-extracts information or re-classifies intent.
//
// POLICY STAYS MANDATORY — TRANSITIVELY, THROUGH THE ELIGIBILITY IT CONSUMES. This engine imports NO policy
// module and names NO guardrail decision function: the reply's fate was decided by the R3 guardrail during
// dispatch and FOLDED into the execution eligibility by R28. A `block` verdict already forced the execution to
// `blocked_by_policy`, which this engine maps to `foreclosed` (no approval — a policy-blocked booking is never
// approvable). Policy therefore stays the single arbiter of a reply's fate and its refusal PROPAGATES into the
// authorisation, without this engine ever re-running or re-importing the guardrail. No duplicate policy logic.
//
// HUMAN REVIEW STAYS MANDATORY — THE STRONGEST TURN-TIME STATE IS `pending` — THERE IS DELIBERATELY NO
// AUTONOMOUS-APPROVE VALUE. A booking is a §9 A4 CUSTOMER COMMITMENT ("Voice / WhatsApp / Email / Scheduler
// never commit; the human does"), so even when the Execution Engine decided the strongest eligibility
// (`requires_human_review`), the STRONGEST authorisation state this engine EMITS is `pending` — never
// "approved". The turn-time state vocabulary ({@link AuthorisationOpeningState}) structurally OMITS any grant
// value: the model is INCAPABLE of auto-approving. The terminal `approved` / `rejected` states arise ONLY from
// the EXISTING Human Review architecture — a human's decision on the held reply recorded in
// `receptionist_review_resolutions` — folded in by {@link deriveAuthorisationState}. R29 therefore INTEGRATES
// with Human Review; it never duplicates the grant. Human Review stays MANDATORY for every approvable booking,
// by construction.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING. Like the R26 outcome, the R27 action and the R28
// execution, the authorisation DECISION is a TOTAL, DETERMINISTIC function of an already-computed input — the
// R28 execution decision (the deferral gate and the eligibility it folds). The pure core adds NO column and NO
// migration; whether a decision is PERSISTED (and where) is the server runtime's job, behind its own
// append-only ledger.
//
// IT DUPLICATES NOTHING BENEATH IT. It consumes an ALREADY-decided execution decision; it NEVER re-decides
// execution, re-prepares the action, re-resolves the outcome, re-derives the strategy, re-detects the gap,
// re-extracts information, re-classifies intent or RE-RUNS POLICY — it names none of those resolvers. Its only
// import is the R28 execution PREDICATE + TYPES (type-only for the types). It reaches NO provider, NO ledger, NO
// DB, NO clock, NO RNG, NO org lookup, NO env read and — the cardinal rule shared with the whole stack — NO
// MODEL: the decision is resolved by a named, total, deterministic fold, so the same execution decision always
// yields the same authorisation. The layering stays a clean, linear stack: Context → … → Outcome → Action →
// Execution → Authorisation.
// =====================================================================

import {
  isExecutionDecided,
  type ExecutionDecision,
  type ExecuteBookingDecision,
  type ConversationExecutionType,
  type ExecutionEligibility,
} from "@/lib/receptionist/conversation-execution";

// ---------------------------------------------------------------------
// The AUTHORISATION vocabulary — the closed set of authorisation types, requirements and states.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of AUTHORISATION TYPES — the kinds of execution decision this engine can render an
 * authorisation DECISION over. R29 ships exactly ONE:
 *   • approve_booking — the authorisation decision for a decided `execute_booking` execution: DOES the booking
 *                       the Execution Engine decided require approval, and what is its authorisation state? It
 *                       DETERMINES the booking's approval requirement; it never GRANTS the approval (the grant
 *                       is a human act recorded through the EXISTING Human Review architecture) and never PLACES
 *                       the booking (calendar writes, scheduling and every external business action are EXPLICIT
 *                       R29 non-goals).
 * Quote approval, customer-promotion approval, scheduling approval and every future authorisation type are
 * EXPLICIT R29 non-goals, so their authorisation types are deliberately ABSENT — a future increment ADDS them
 * here (and to the ledger's CHECK) as an explicit, reviewable act. A closed const tuple, so
 * {@link ConversationAuthorisationType} is exactly these members and a consumer can switch exhaustively.
 */
export const AUTHORISATION_TYPES = ["approve_booking"] as const;

/** One authorisation type the engine can render a decision over. */
export type ConversationAuthorisationType = (typeof AUTHORISATION_TYPES)[number];

/**
 * The closed vocabulary of REQUIREMENTS — the answer to "IS approval required before this may proceed?":
 *   • human_approval_required — the execution decided the strongest eligibility (`requires_human_review`): a
 *                               human must APPROVE before the booking may proceed. Approval is MANDATORY.
 *   • not_required            — the execution was blocked upstream (by policy or by the organisation): there is
 *                               nothing to approve, so approval is not required. The authorisation is foreclosed.
 * A closed union — the determination is total over every decided execution eligibility.
 */
export type AuthorisationRequirement = "human_approval_required" | "not_required";

/**
 * The closed vocabulary of AUTHORISATION STATES — the recorded lifecycle of an authorisation. The lifecycle
 * SPANS two integrated ledgers, and this vocabulary names every state across both:
 *   • pending    — approval is REQUIRED and awaiting a human decision. The STRONGEST state the turn-time engine
 *                  EMITS: a booking is a §9 A4 commitment, so it is never auto-approved. This is the hand-off to
 *                  the EXISTING Human Review architecture.
 *   • foreclosed — no approval was required (the execution was blocked upstream); there is nothing to authorise.
 *                  The other state the turn-time engine emits.
 *   • approved   — a human GRANTED approval. This state is NEVER emitted by the turn-time engine; it is DERIVED
 *                  from the EXISTING Human Review architecture (a `sent` resolution on the held reply) by
 *                  {@link deriveAuthorisationState}. R29 integrates with the grant; it never records it.
 *   • rejected   — a human REFUSED approval. Likewise DERIVED (a `dismissed` resolution), never turn-time.
 * A closed union so a consumer can switch exhaustively over the whole lifecycle.
 */
export type AuthorisationState = "pending" | "approved" | "rejected" | "foreclosed";

/**
 * The subset of {@link AuthorisationState} the TURN-TIME engine may emit and the ledger may store — `pending`
 * or `foreclosed`, NEVER a grant. This is the load-bearing R29 type: it makes "the engine never auto-approves"
 * a COMPILE-TIME guarantee (the resolved decision's `state` is typed to this subset) and the ledger mirrors it
 * with a CHECK. The grant states (`approved` / `rejected`) are structurally unreachable at decision time — they
 * exist only in the EXISTING Human Review ledger, folded in by {@link deriveAuthorisationState}. This is the R29
 * analogue of R28's eligibility vocabulary that omits any autonomous-execute value.
 */
export type AuthorisationOpeningState = Extract<AuthorisationState, "pending" | "foreclosed">;

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the engine rendered NO authorisation decision on a turn.
 * An abstention is not an error; it is the honest "nothing to authorise here" for the vast majority of turns:
 *   • no_execution_decision — the R28 Execution Engine rendered NO decision this turn (an abstention). There is
 *                             nothing to authorise, so the Authorisation Engine defers. This is the FIRST gate —
 *                             the Execution Engine (and transitively the Action and Outcome Engines) stays
 *                             authoritative.
 *   • unsupported_execution — an execution WAS decided, but its type maps to no R29 authorisation type (defence
 *                             in depth: R28 ships only `execute_booking`, which maps to `approve_booking`, so
 *                             this is unreachable today; it becomes live only if a future execution type is
 *                             added to R28 without a matching authorisation type here).
 * A closed union so {@link AuthorisationDecision}'s abstention arm is exhaustive.
 */
export type AuthorisationAbstention = "no_execution_decision" | "unsupported_execution";

// ---------------------------------------------------------------------
// The AUTHORISATION model — the resolved authorisation decision for a turn.
// ---------------------------------------------------------------------

/**
 * The APPROVE-BOOKING decision — the first (and only R29) authorisation decision. It carries the resolved
 * {@link AuthorisationRequirement} (is approval required), the resolved {@link AuthorisationOpeningState} (the
 * turn-time state — `pending` or `foreclosed`, NEVER a grant), and the exact {@link ExecuteBookingDecision} it
 * authorises over (so the decision is self-describing for the audit ledger). It DETERMINES the booking's
 * approval requirement; it carries NO grant, NO reviewer and NO placed booking — approval and execution are
 * EXPLICIT R29 non-goals. There is no field that could express "approved": the model records a REQUIREMENT and
 * a turn-time state, never a performed grant.
 */
export type ApproveBookingAuthorisation = {
  readonly kind: "approve_booking";
  readonly requirement: AuthorisationRequirement;
  readonly state: AuthorisationOpeningState;
  readonly execution: ExecuteBookingDecision;
};

/**
 * The conversational AUTHORISATION DECISION for one turn — a discriminated union the runtime reads:
 *   • a DECIDED arm ({@link ApproveBookingAuthorisation}, and future authorisation types) — a concrete
 *     requirement + turn-time state over a decided execution. Its `kind` IS its
 *     {@link ConversationAuthorisationType}.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no decision this turn, tagged with WHY
 *     ({@link AuthorisationAbstention}). The overwhelmingly common case (every turn on which the Execution
 *     Engine decided nothing, which is every turn that is not a satisfied booking).
 * Every field is a total, deterministic function of the execution decision; the whole object is derived, never
 * persisted by this core.
 */
export type AuthorisationDecision =
  | ApproveBookingAuthorisation
  | { readonly kind: "none"; readonly reason: AuthorisationAbstention };

/**
 * The execution-type → authorisation-type mapping — which AUTHORISATION TYPE each decided
 * {@link ConversationExecutionType} is authorised under, or `null` when the execution type has no R29
 * authorisation. TOTAL over the whole execution vocabulary — the `Record` type makes the exhaustiveness a
 * COMPILE-TIME guarantee, so this map and the R28 execution vocabulary can never drift (a new execution type
 * cannot be added without deciding its authorisation here). R28 ships `execute_booking`, which maps to
 * `approve_booking`; a future execution type maps to its own authorisation type (or `null` until one is added)
 * as an explicit, reviewable act.
 */
export const EXECUTION_AUTHORISATION: Readonly<
  Record<ConversationExecutionType, ConversationAuthorisationType | null>
> = {
  execute_booking: "approve_booking",
};

// ---------------------------------------------------------------------
// RESOLUTION — the single derived authorisation decision. The fold is total over the execution eligibility.
// ---------------------------------------------------------------------

/** The abstention decision for a reason — the single shape of "no decision this turn". */
function abstain(reason: AuthorisationAbstention): AuthorisationDecision {
  return { kind: "none", reason };
}

/**
 * The REQUIREMENT fold — an approval is required exactly when the Execution Engine decided the strongest
 * eligibility (`requires_human_review`). Every blocked eligibility folds to `not_required` (nothing to approve).
 * Pure and total over the eligibility vocabulary.
 */
function requirementFor(eligibility: ExecutionEligibility): AuthorisationRequirement {
  return eligibility === "requires_human_review" ? "human_approval_required" : "not_required";
}

/**
 * The turn-time STATE fold — `pending` exactly when approval is required (`requires_human_review`), else
 * `foreclosed`. The image is {@link AuthorisationOpeningState} by construction: a grant is UNREACHABLE at
 * decision time. Pure and total over the eligibility vocabulary.
 */
function openingStateFor(eligibility: ExecutionEligibility): AuthorisationOpeningState {
  return eligibility === "requires_human_review" ? "pending" : "foreclosed";
}

/**
 * Resolve the AUTHORISATION DECISION for a turn — THE single entry point the runtime reads. Consumes the one
 * already-computed input it authorises over: the R28 `execution` decision (the DEFERRAL gate — when the
 * Execution Engine rendered no decision, the Authorisation Engine stands down — and the eligibility it folds).
 *
 * Pure, TOTAL over any execution decision, and DETERMINISTIC — the same execution decision always yields the
 * same authorisation. The Execution Engine stays AUTHORITATIVE: the FIRST gate defers to it (and transitively to
 * the Action and Outcome Engines, since a decided execution exists only when an action was prepared, which
 * exists only when the outcome abstained). Policy stays MANDATORY: a `block` verdict already forced the
 * execution to `blocked_by_policy`, which folds here to `foreclosed` — and the guardrail is never re-run or even
 * re-imported. Human Review stays MANDATORY: the strongest state this engine EMITS is `pending` — there is no
 * autonomous-approve value to return, and the grant (`approved` / `rejected`) arises ONLY from the EXISTING
 * Human Review architecture via {@link deriveAuthorisationState}. Persists NOTHING — the runtime decides whether
 * and where to record the decision. THE single source of truth for the approval requirement — every consumer
 * resolves it through this function and no other way; no feature implements independent approval-requirement
 * logic.
 */
export function resolveAuthorisation(execution: ExecutionDecision): AuthorisationDecision {
  // THE EXECUTION ENGINE IS AUTHORITATIVE. If R28 rendered NO decision (an abstention), there is nothing to
  // authorise and the Authorisation Engine defers. This is the first thing the engine checks — it CONVERTS the
  // execution decision (consumes it), it never overrides it. Because a decided execution exists ONLY when the
  // R27 Action Engine prepared an action (the Execution Engine's own first gate), deferring here transitively
  // preserves the Action Engine's authority too — and, in turn, the R26 Outcome Engine's.
  if (!isExecutionDecided(execution)) return abstain("no_execution_decision");

  // The decided execution selects its authorisation type. R28 ships only `execute_booking` (→ `approve_booking`);
  // a null here would mean a future execution type reached this engine before its authorisation type was added —
  // defence in depth, unreachable today, but keeps the map and the vocabulary honest.
  const authorisationType = EXECUTION_AUTHORISATION[execution.kind];
  if (authorisationType === null) return abstain("unsupported_execution");

  // Render the requirement + turn-time state for the authorisation type. A closed switch keeps this exhaustive
  // as the vocabulary grows: adding an AUTHORISATION_TYPE without a case here fails `tsc`. Each arm folds the
  // execution eligibility into the approval requirement and the turn-time state (never a grant).
  switch (authorisationType) {
    case "approve_booking": {
      // The fold, from the execution eligibility (itself the fixed-priority fold of org → policy → human-review):
      //  • requires_human_review ⇒ human_approval_required + `pending` — a human must approve; the strongest a
      //    booking reaches. There is deliberately no "approved now" — a booking is never auto-approved.
      //  • blocked_by_policy / blocked_by_org ⇒ not_required + `foreclosed` — the execution was blocked upstream
      //    (policy or org), so there is nothing to approve. Policy's refusal PROPAGATES here without a re-run.
      const requirement = requirementFor(execution.eligibility);
      const state = openingStateFor(execution.eligibility);
      return { kind: "approve_booking", requirement, state, execution };
    }
  }
}

// ---------------------------------------------------------------------
// HUMAN REVIEW INTEGRATION — the single fold from an EXISTING review resolution to the terminal state.
// ---------------------------------------------------------------------

/**
 * A signal from the EXISTING Human Review architecture — the resolution a human recorded on the held reply in
 * `receptionist_review_resolutions` (R14): `sent` (the human approved and sent the confirmation), `dismissed`
 * (the human refused), or `null` (no resolution yet — still pending). This is the ONLY input R29 reads from the
 * Human Review architecture; R29 never WRITES it, so there is no duplicate human-decision recorder.
 */
export type ReviewResolutionSignal = "sent" | "dismissed" | null;

/**
 * Derive the TERMINAL authorisation state by folding the turn-time state with an EXISTING Human Review
 * resolution — THE single bridge between the Authorisation Engine and the Human Review architecture, and the
 * ONLY place the grant states are produced. This is how R29 INTEGRATES with Human Review WITHOUT duplicating it:
 *   • a `foreclosed` authorisation required no approval, so a later resolution never revives it — it stays
 *     `foreclosed`;
 *   • a `pending` authorisation resolves under the human's authority: `sent` ⇒ `approved`, `dismissed` ⇒
 *     `rejected`, and no resolution yet ⇒ still `pending`.
 * Pure and total. The grant is the human's, recorded in the EXISTING resolution ledger; this function merely
 * PROJECTS it onto the authorisation lifecycle. No approval logic is duplicated: R29 reads the resolution, it
 * never records one.
 */
export function deriveAuthorisationState(
  opening: AuthorisationOpeningState,
  resolution: ReviewResolutionSignal,
): AuthorisationState {
  if (opening === "foreclosed") return "foreclosed";
  if (resolution === "sent") return "approved";
  if (resolution === "dismissed") return "rejected";
  return "pending";
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a decision the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a decision is DECIDED (a concrete requirement + turn-time state over a decided execution), as opposed
 * to an abstention. A type guard: it narrows an {@link AuthorisationDecision} to its decided arms, so the
 * runtime records ONLY a real decision and an abstention is a total no-op. THE predicate the runtime gates
 * persistence on — there is no other "did we decide?" rule.
 */
export function isAuthorisationDecided(
  decision: AuthorisationDecision,
): decision is ApproveBookingAuthorisation {
  return decision.kind !== "none";
}

/**
 * Whether a decision REQUIRES human approval — true exactly for a decided authorisation whose requirement is
 * `human_approval_required` (equivalently, whose turn-time state is `pending`). Pure and total; a projection a
 * future approval-inbox consumer reads to surface the bookings still awaiting a human. An abstention or a
 * foreclosed authorisation is `false`.
 */
export function isApprovalRequired(decision: AuthorisationDecision): boolean {
  return decision.kind !== "none" && decision.requirement === "human_approval_required";
}

/**
 * The {@link ConversationAuthorisationType} of a decision (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the decided arm's `kind` IS its authorisation type, so the mapping is the
 * identity on the decided arms and `null` on the abstention.
 */
export function authorisationTypeOf(
  decision: AuthorisationDecision,
): ConversationAuthorisationType | null {
  return decision.kind === "none" ? null : decision.kind;
}

/**
 * The {@link AuthorisationRequirement} of a decision (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — a projection the runtime folds onto the ledger row alongside the authorisation
 * type.
 */
export function requirementOf(
  decision: AuthorisationDecision,
): AuthorisationRequirement | null {
  return decision.kind === "none" ? null : decision.requirement;
}

/**
 * The turn-time {@link AuthorisationOpeningState} of a decision (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — NEVER a grant value: the projection's image is exactly `pending` | `foreclosed`
 * by construction, so the runtime can never record an autonomous approval.
 */
export function openingStateOf(
  decision: AuthorisationDecision,
): AuthorisationOpeningState | null {
  return decision.kind === "none" ? null : decision.state;
}
