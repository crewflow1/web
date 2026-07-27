// =====================================================================
// THE CONVERSATION ACTION ENGINE — PURE CORE (CEO Directive #018; R27: CONVERSATION ACTION ENGINE).
//
// R17–R25 built the DERIVING stack (State → Intent → Goal → Information → Gap → Strategy → Prompt → Response
// → Generation): every layer OBSERVES, DERIVES or WORDS. R26 added the OUTCOME ENGINE — the first layer that
// ACTS on a satisfied objective, resolving an INTERNAL OUTCOME (a `callback` carrying the number to ring) and
// recording it. R27 is the NEXT layer: the single, canonical authority over an EIGHTH question, one derived
// from the Outcome above it — "given the conversation's resolved OUTCOME, the progressing strategy, the goal
// and the information, what INTERNAL BUSINESS ACTION should the organisation PREPARE?" — the conversational
// ACTION. Booking preparation is the FIRST action expressed here — a `prepare_booking` proposal carrying the
// job type, postcode and callback number a human/CRM needs to arrange the visit — but it is one member of
// the action vocabulary, not the engine's purpose.
//
// IT PREPARES WORK — IT DOES NOT EXECUTE WORK. Determining that a satisfied booking objective should PREPARE
// a booking proposal is a pure CHOICE over the already-resolved outcome, strategy, goal and information — a
// planning DECISION about an INTERNAL proposal a human/CRM later acts on. Actually persisting that proposal
// is the SERVER RUNTIME's job (server/services/receptionist-action.ts); and BOOKING EXECUTION, CALENDAR
// WRITES, QUOTE/PRICING GENERATION, AI SCHEDULING, CUSTOMER PROMOTION, memory retrieval and every EXTERNAL
// business action are EXPLICIT R27 NON-GOALS no layer here performs. This pure core names the action and
// stops. The Action Engine may PREPARE internal actions; it never EXECUTES an external business action.
//
// THE OUTCOME ENGINE REMAINS AUTHORITATIVE — THE ACTION ENGINE CONVERTS ITS RESULT, IT NEVER RE-DERIVES IT.
// {@link resolveAction} takes the R26 {@link OutcomeResolution} as its FIRST input and its FIRST gate DEFERS:
// when the Outcome Engine already resolved an ACTIONABLE outcome (a `callback`), the Action Engine stands
// down (`outcome_resolved`) — the outcome owns that turn. The two engines can never compete because
// {@link GOAL_ACTION} and the R26 `GOAL_OUTCOME` are DISJOINT: no goal maps to BOTH an outcome and an action
// (`arrange_callback` → a callback OUTCOME and no action; `arrange_booking` → a `prepare_booking` ACTION and
// no outcome). Booking preparation therefore fires WITHOUT adding a booking OUTCOME type: a satisfied
// `arrange_booking` reaches `progress_goal`, the Outcome Engine ABSTAINS on it (`goal_has_no_outcome`), and
// the Action Engine picks it up. The Action Engine CONSUMES the outcome; it NEVER calls `resolveOutcome`,
// re-derives the strategy/goal/gap, re-extracts information or re-classifies intent.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING. Like the R26 outcome, the action RESOLUTION is a
// TOTAL, DETERMINISTIC function of already-derived observations — the R26 outcome (the deferral gate), the
// R22 strategy (the progression trigger), the R19 goal (which action type the objective prepares) and the
// R20 information (the payload the action carries). The pure core adds NO column and NO migration; whether an
// action is PERSISTED (and where) is the server runtime's decision, behind its own append-only ledger.
//
// IT REUSES THE R20 VALIDITY SURFACE — IT FORKS NO FIELD LOGIC. "Is this job type / postcode / phone number
// well-formed?" is answered by the R20 information engine's single validity authority
// ({@link isValidFieldValue}) — the SAME predicate that gated each value into the information record. This
// engine IMPORTS that predicate and re-implements NONE of it. RESOLUTION and VALIDATION are UNIFIED, exactly
// as R20 unifies extraction and validation and R26 unifies outcome resolution and validation:
// {@link resolveAction} yields an actionable action ONLY when EVERY payload field re-passes its R20
// validator, so an ill-formed value can never become a preparable action.
//
// IT DUPLICATES NOTHING BENEATH IT. It consumes an ALREADY-resolved outcome, strategy, goal and information;
// it NEVER re-assembles context, re-classifies intent, re-resolves goal, re-extracts information, re-detects
// the gap, re-derives the strategy or RE-RESOLVES THE OUTCOME — it names none of those resolvers. Its only
// imports are the R26 outcome PREDICATE + TYPE, the R22 strategy TYPE, the R19 goal TYPE, and the R20
// information field TYPES plus the ONE R20 validity predicate. It reaches NO policy, NO provider, NO ledger,
// NO DB, NO clock, NO RNG and — the cardinal rule shared with the whole stack — NO MODEL: the action is
// resolved by a named, total, deterministic mapping table and a single validity check, so the same (outcome,
// strategy, goal, information) always yields the same resolution. The layering stays a clean, linear stack:
// Context → Intent → Goal → Information → Gap → Strategy → Prompt → Response → Generation → Outcome → Action.
// =====================================================================

import type { ConversationGoal } from "@/lib/receptionist/conversation-goal";
import type { ConversationStrategy } from "@/lib/receptionist/conversation-strategy";
import {
  isValidFieldValue,
  type ConversationInformation,
} from "@/lib/receptionist/conversation-information";
import {
  isActionableOutcome,
  type OutcomeResolution,
} from "@/lib/receptionist/conversation-outcome";

// ---------------------------------------------------------------------
// The ACTION vocabulary — the closed set of internal action types.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of internal ACTION TYPES — the business actions a satisfied conversational objective
 * can PREPARE for a human/CRM to act on. R27 ships exactly ONE:
 *   • prepare_booking — the customer is ready to BOOK; the action carries the job type, postcode and callback
 *                       number the team needs to arrange the visit. It PREPARES the booking; it never EXECUTES
 *                       it (calendar writes, scheduling and pricing are EXPLICIT R27 non-goals).
 * Booking execution, calendar writes, quote/pricing generation, AI scheduling and customer promotion are
 * EXPLICIT R27 non-goals, so their action types are deliberately ABSENT — a future increment ADDS them here
 * (and to the ledger's CHECK) as an explicit, reviewable act. A closed const tuple, so
 * {@link ConversationActionType} is exactly these members and a consumer can switch exhaustively.
 */
export const ACTION_TYPES = ["prepare_booking"] as const;

/** One internal action type the engine can prepare. */
export type ConversationActionType = (typeof ACTION_TYPES)[number];

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the engine prepared NO action on a turn. An abstention
 * is not an error; it is the honest "nothing to prepare here" for the vast majority of turns:
 *   • outcome_resolved   — the R26 Outcome Engine already resolved an ACTIONABLE outcome (a `callback`) this
 *                          turn; the Outcome Engine owns it and the Action Engine defers. This is the FIRST
 *                          gate — the Outcome Engine stays authoritative.
 *   • not_progressing    — the strategy is not `progress_goal`; the turn hands back / answers / escalates, so
 *                          there is no satisfied objective to prepare an action for yet.
 *   • goal_has_no_action — the strategy IS `progress_goal` but this goal prepares no R27 action (a callback is
 *                          an OUTCOME not an action; quote/answer/handoff prepare nothing here). The objective
 *                          progresses conversationally, but prepares no internal action.
 *   • incomplete         — the goal's action type needs a payload field the information does not hold in a
 *                          well-formed shape (defence-in-depth: for a satisfied objective this should not
 *                          arise, but a malformed persisted value can never become a preparable action).
 * A closed union so {@link ActionResolution}'s abstention arm is exhaustive.
 */
export type ActionAbstention =
  | "outcome_resolved"
  | "not_progressing"
  | "goal_has_no_action"
  | "incomplete";

// ---------------------------------------------------------------------
// The ACTION model — the resolved next internal action for a turn.
// ---------------------------------------------------------------------

/**
 * The PREPARE-BOOKING action — the first actionable action. Carries the three facts a human/CRM needs to
 * arrange the visit: the `job_type` (the trade), the `postcode` (where), and the `phone_number` to ring
 * (whom), each in its canonical R20 shape and guaranteed well-formed by {@link resolveAction} (they are the
 * R20-validated slots the satisfied `arrange_booking` objective already holds). It PREPARES the booking; it
 * carries NO date, NO calendar slot and NO price — scheduling and pricing are EXPLICIT R27 non-goals.
 */
export type PrepareBookingAction = {
  readonly kind: "prepare_booking";
  readonly job_type: string;
  readonly postcode: string;
  readonly phone_number: string;
};

/**
 * The conversational ACTION RESOLUTION for one turn — a discriminated union the runtime reads:
 *   • an ACTIONABLE arm ({@link PrepareBookingAction}, and future action types) — a concrete internal action
 *     to PREPARE, carrying its payload. Its `kind` IS its {@link ConversationActionType}.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no action this turn, tagged with WHY
 *     ({@link ActionAbstention}). The overwhelmingly common case (every callback turn the Outcome Engine
 *     owns, every non-`progress_goal` turn, and every progressing turn whose goal prepares no R27 action).
 * Every field is a total, deterministic function of (outcome, strategy, goal, information); the whole object
 * is derived, never persisted by this core.
 */
export type ActionResolution =
  | PrepareBookingAction
  | { readonly kind: "none"; readonly reason: ActionAbstention };

/**
 * The goal → action-type mapping — which INTERNAL action each satisfied {@link ConversationGoal} PREPARES
 * when the strategy says PROGRESS and the Outcome Engine did not claim the turn, or `null` when the goal
 * prepares no R27 action. TOTAL over the whole goal vocabulary — the `Record` type makes the exhaustiveness a
 * COMPILE-TIME guarantee, so this map and the goal vocabulary can never drift (a new goal cannot be added
 * without deciding its action here).
 *
 * DISJOINT FROM THE R26 `GOAL_OUTCOME` BY CONSTRUCTION: no goal maps to BOTH an action here and an outcome
 * there. `arrange_callback` maps to `null` (its satisfied objective is a callback OUTCOME, owned by R26);
 * only `arrange_booking` maps to an action in R27 — booking PREPARATION, which fires precisely because the
 * Outcome Engine ABSTAINS on `arrange_booking` (`GOAL_OUTCOME.arrange_booking === null`). `provide_quote`
 * maps to `null` because quote/pricing generation is an EXPLICIT R27 non-goal (a future action type);
 * `undetermined`/`answer_enquiry`/`handoff_to_human` never reach `progress_goal` (earlier strategy rules
 * claim them) and prepare no action regardless. This disjointness is what keeps the Outcome Engine
 * authoritative: the two engines partition the goals, they never contend for one.
 */
export const GOAL_ACTION: Readonly<Record<ConversationGoal, ConversationActionType | null>> = {
  undetermined: null,
  answer_enquiry: null,
  arrange_booking: "prepare_booking",
  arrange_callback: null, // a callback is an R26 OUTCOME, not an R27 action — disjoint from GOAL_OUTCOME
  provide_quote: null, // future: quote/pricing generation is an explicit R27 non-goal
  handoff_to_human: null,
};

// ---------------------------------------------------------------------
// RESOLUTION — the single derived next-action decision. Resolution and validation are UNIFIED.
// ---------------------------------------------------------------------

/** The abstention resolution for a reason — the single shape of "no action this turn". */
function abstain(reason: ActionAbstention): ActionResolution {
  return { kind: "none", reason };
}

/**
 * Resolve the conversational ACTION for a turn — THE single entry point the runtime reads. Consumes the four
 * already-derived observations it acts over: the R26 `outcome` (the DEFERRAL gate — when the Outcome Engine
 * already resolved an actionable outcome, the Action Engine stands down), the R22 `strategy` (the progression
 * TRIGGER — only a `progress_goal` turn prepares an action), the R19 `goal` (which SELECTS the action type
 * via {@link GOAL_ACTION}), and the R20 `information` (the PAYLOAD the action carries).
 *
 * Pure, TOTAL over any (outcome, strategy, goal, information), and DETERMINISTIC — the same inputs always
 * yield the same resolution. The Outcome Engine stays AUTHORITATIVE: the FIRST gate defers to it, and because
 * {@link GOAL_ACTION} is disjoint from the R26 `GOAL_OUTCOME` the two engines never contend. RESOLUTION and
 * VALIDATION are UNIFIED: an actionable action is returned ONLY when EVERY payload field re-passes its R20
 * validator (never a second, forked check), so a malformed value can never become a preparable action;
 * otherwise the engine ABSTAINS with a reason. Persists NOTHING — the runtime decides whether and where to
 * PREPARE an actionable action. THE single source of truth for conversational action resolution — every
 * consumer resolves the action through this function and no other way; no feature implements independent
 * action-resolution logic.
 */
export function resolveAction(
  outcome: OutcomeResolution,
  strategy: ConversationStrategy,
  goal: ConversationGoal,
  information: ConversationInformation,
): ActionResolution {
  // THE OUTCOME ENGINE IS AUTHORITATIVE. If R26 already resolved an ACTIONABLE outcome (a `callback`), that
  // outcome OWNS this turn and the Action Engine defers. This is the first thing the engine checks — it
  // CONVERTS the outcome (consumes it), it never overrides it. In practice this and `GOAL_ACTION`'s
  // disjointness from `GOAL_OUTCOME` are belt-and-braces: a goal with an outcome has no action anyway.
  if (isActionableOutcome(outcome)) return abstain("outcome_resolved");

  // Only a `progress_goal` strategy ACTS. Every other strategy (acknowledge / request_information /
  // provide_answer / escalate_to_human) hands the turn back, answers, or routes to a human — none prepares an
  // internal action. This is the exact R27 trigger: `progress_goal` fires ONLY for a SATISFIED actionable
  // objective (the earlier strategy rules claim undetermined / unsatisfied / answer / handoff).
  if (strategy !== "progress_goal") return abstain("not_progressing");

  // The satisfied objective selects the action type. A goal with no R27 action (callback — an OUTCOME; quote
  // — future; or a goal that never reaches progress_goal) progresses conversationally but prepares nothing.
  const type = GOAL_ACTION[goal];
  if (type === null) return abstain("goal_has_no_action");

  // Resolve the action for its type. A closed switch keeps this exhaustive as the vocabulary grows: adding an
  // ACTION_TYPE without a case here fails `tsc`. Each arm re-validates its whole payload through the R20
  // authority, so an actionable action is always well-formed.
  switch (type) {
    case "prepare_booking": {
      // Booking preparation needs the three facts the satisfied objective already gathered — the trade, the
      // place and the number to ring. Re-validate EACH through the ONE R20 predicate (defence-in-depth over
      // the persisted values); any absent or malformed ⇒ abstain rather than prepare an unusable booking.
      const jobType = information.job_type;
      const postcode = information.postcode;
      const phone = information.phone_number;
      if (
        jobType === undefined ||
        !isValidFieldValue("job_type", jobType) ||
        postcode === undefined ||
        !isValidFieldValue("postcode", postcode) ||
        phone === undefined ||
        !isValidFieldValue("phone_number", phone)
      ) {
        return abstain("incomplete");
      }
      return { kind: "prepare_booking", job_type: jobType, postcode, phone_number: phone };
    }
  }
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a resolution the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a resolution is an ACTIONABLE action (a concrete internal action to PREPARE), as opposed to an
 * abstention. A type guard: it narrows an {@link ActionResolution} to its actionable arms, so the runtime
 * persists ONLY an actionable action and an abstention is a total no-op. THE predicate the runtime gates
 * persistence on — there is no other "should we prepare this?" rule.
 */
export function isActionableAction(
  resolution: ActionResolution,
): resolution is PrepareBookingAction {
  return resolution.kind !== "none";
}

/**
 * The {@link ConversationActionType} of a resolution (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the actionable arm's `kind` IS its action type, so the mapping is the identity
 * on the actionable arms and `null` on the abstention.
 */
export function actionTypeOf(resolution: ActionResolution): ConversationActionType | null {
  return resolution.kind === "none" ? null : resolution.kind;
}
