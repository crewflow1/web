// =====================================================================
// THE CONVERSATION OUTCOME ENGINE — PURE CORE (CEO Directive #018; R26: CONVERSATION OUTCOME ENGINE).
//
// R17 wrapped the runtime in a formal STATE MACHINE ("which party owes the next turn"); R18 added the
// INTENT ENGINE ("what does the customer WANT?"); R19 the GOAL ENGINE ("what is the conversation trying to
// ACCOMPLISH?"); R20 the INFORMATION ENGINE ("what STRUCTURED FACTS has the customer PROVIDED?"); R21 the
// GAP ENGINE ("what is STILL MISSING?"); R22 the STRATEGY ENGINE ("HOW SHOULD THE CONVERSATION PROGRESS?");
// R23 the PROMPT PLANNER and R24 the RESPONSE ENGINE (HOW to word the next reply); R25 the GENERATION ENGINE
// (the words themselves). Every one of those layers OBSERVES, DERIVES or WORDS — none of them ACTS. R26 is
// the FIRST layer that ACTS on a satisfied conversational goal: the single, canonical authority over a
// SEVENTH question, one DERIVED from the strategy above it — "given that the objective is SATISFIED and the
// strategy says PROGRESS, what INTERNAL OUTCOME does the conversation produce, and is it well-formed enough
// to record?" — the conversational OUTCOME. Callback fulfilment is the FIRST outcome expressed here — a
// `callback` resolution carrying the number to ring back — but it is just one member of the outcome
// vocabulary, not the engine's purpose.
//
// IT RESOLVES AN INTERNAL OUTCOME — IT NEVER EXECUTES A BUSINESS ACTION. Determining that a satisfied
// callback objective yields a `callback` outcome for the number the customer gave is a pure CHOICE over the
// already-derived strategy, goal and information — a planning DECISION about an INTERNAL record. Actually
// PERSISTING that outcome, recording it on the lead, drafting the confirmation and routing it are the SERVER
// RUNTIME's job (server/services/receptionist-outcome.ts) and the UNCHANGED reply pipeline's job; and
// booking execution, calendar scheduling, quote/pricing generation, lead-to-customer promotion, AI
// scheduling, memory retrieval and every EXTERNAL business action are EXPLICIT R26 NON-GOALS no layer here
// performs. This pure core names the outcome and stops. The Outcome Engine may resolve INTERNAL outcomes; it
// never executes an external business action.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING. Like the R21 gap and the R22 strategy, the outcome
// RESOLUTION is a TOTAL, DETERMINISTIC function of already-derived observations — the R22 strategy (the
// progression trigger), the R19 goal (which outcome type the objective produces) and the R20 information
// (the payload the outcome carries). The pure core adds NO column and NO migration; whether an outcome is
// PERSISTED (and where) is the server runtime's decision, behind its own append-only ledger. Resolution is
// computed wherever it is needed (surfaced on the runtime turn result; re-derivable on any read) so it can
// never drift from the strategy/goal/information it derives from.
//
// IT REUSES THE R20 VALIDITY SURFACE — IT FORKS NO FIELD LOGIC. "Is this phone number well-formed?" is
// answered by the R20 information engine's single validity authority ({@link isValidFieldValue}) — the SAME
// predicate that gated the value into the information record on the way in. This engine IMPORTS that
// predicate and re-implements NONE of it: it runs no second E.164 regex and knows nothing about a field's
// shape beyond what R20 defines. So there is exactly ONE definition of "a valid phone number" (R20) and
// exactly ONE definition of "what INTERNAL OUTCOME a satisfied objective produces" (R26) — no feature
// computes either independently. RESOLUTION and VALIDATION are UNIFIED, exactly as R20 unifies extraction
// and validation: {@link resolveOutcome} yields an actionable outcome ONLY when its payload re-passes the
// field validator, so an ill-formed value can never become a recordable outcome.
//
// IT DUPLICATES NOTHING BENEATH IT. It consumes an ALREADY-derived strategy, goal and information; it NEVER
// re-assembles context, re-classifies intent, re-resolves goal, re-extracts information, re-detects the gap
// or re-derives the strategy — it names none of those resolvers, planners, extractors or detectors. Its only
// imports are the R22 strategy TYPE, the R19 goal TYPE, and the R20 information field TYPES plus the ONE R20
// validity predicate. It reaches NO policy, NO provider, NO ledger, NO DB, NO clock, NO RNG and — the
// cardinal rule shared with the whole stack — NO MODEL: the outcome is resolved by a named, total,
// deterministic mapping table and a single validity check, so the same (strategy, goal, information) always
// yields the same resolution and the derivation is reconstructable from source. The layering stays a clean,
// linear stack: Context → Intent → Goal → Information → Gap → Strategy → Prompt → Response → Generation →
// Outcome.
// =====================================================================

import type { ConversationGoal } from "@/lib/receptionist/conversation-goal";
import type { ConversationStrategy } from "@/lib/receptionist/conversation-strategy";
import {
  isValidFieldValue,
  type ConversationInformation,
} from "@/lib/receptionist/conversation-information";

// ---------------------------------------------------------------------
// The OUTCOME vocabulary — the closed set of internal outcome types.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of internal OUTCOME TYPES — the actionable results a satisfied conversational
 * objective can produce. R26 ships exactly ONE:
 *   • callback — the customer asked to be RUNG BACK; the outcome carries the E.164 number to ring.
 * Booking execution, calendar scheduling and quote/pricing generation are EXPLICIT R26 non-goals, so their
 * outcome types are deliberately ABSENT from this vocabulary — a future increment ADDS them here (and to the
 * ledger's CHECK) as an explicit, reviewable act. A closed const tuple, so {@link ConversationOutcomeType}
 * is exactly these members and a consumer can switch exhaustively.
 */
export const OUTCOME_TYPES = ["callback"] as const;

/** One internal outcome type the engine can resolve. */
export type ConversationOutcomeType = (typeof OUTCOME_TYPES)[number];

/**
 * The closed vocabulary of ABSTENTIONS — the reasons the engine resolved NO outcome on a turn. An
 * abstention is not an error; it is the honest "nothing to record here" for the vast majority of turns:
 *   • not_progressing    — the strategy is not `progress_goal`; the turn hands back / answers / escalates,
 *                          so there is no satisfied objective to act on yet.
 *   • goal_has_no_outcome — the strategy IS `progress_goal` but this goal produces no R26 outcome (an
 *                          answer/handoff is carried by another strategy; booking/quote are future outcome
 *                          types). The objective progresses conversationally, but records no internal outcome.
 *   • incomplete         — the goal's outcome type needs a payload field the information does not hold in a
 *                          well-formed shape (defence-in-depth: for a satisfied objective this should not
 *                          arise, but a malformed persisted value can never become a recordable outcome).
 * A closed union so {@link OutcomeResolution}'s abstention arm is exhaustive.
 */
export type OutcomeAbstention = "not_progressing" | "goal_has_no_outcome" | "incomplete";

// ---------------------------------------------------------------------
// The OUTCOME model — the resolved next internal outcome for a turn.
// ---------------------------------------------------------------------

/**
 * The CALLBACK outcome — the first actionable outcome. Carries the single fact the callback needs: the
 * `phone_number` to ring back, in canonical E.164 (`+44…`), guaranteed well-formed by {@link resolveOutcome}
 * (it is the R20-validated `phone_number` slot the satisfied objective already holds).
 */
export type CallbackOutcome = { readonly kind: "callback"; readonly phone_number: string };

/**
 * The conversational OUTCOME RESOLUTION for one turn — a discriminated union the runtime reads:
 *   • an ACTIONABLE arm ({@link CallbackOutcome}, and future outcome types) — a concrete internal outcome to
 *     record, carrying its payload. Its `kind` IS its {@link ConversationOutcomeType}.
 *   • the ABSTENTION arm (`{ kind: "none"; reason }`) — no outcome this turn, tagged with WHY
 *     ({@link OutcomeAbstention}). The overwhelmingly common case (every non-`progress_goal` turn, and every
 *     progressing turn whose goal has no R26 outcome).
 * Every field is a total, deterministic function of (strategy, goal, information); the whole object is
 * derived, never persisted by this core.
 */
export type OutcomeResolution =
  | CallbackOutcome
  | { readonly kind: "none"; readonly reason: OutcomeAbstention };

/**
 * The goal → outcome-type mapping — which INTERNAL outcome each satisfied {@link ConversationGoal} produces
 * when the strategy says PROGRESS, or `null` when the goal produces no R26 outcome. TOTAL over the whole goal
 * vocabulary — the `Record` type makes the exhaustiveness a COMPILE-TIME guarantee, so this map and the goal
 * vocabulary can never drift (a new goal cannot be added without deciding its outcome here). Only
 * `arrange_callback` maps to an outcome in R26; `arrange_booking` and `provide_quote` map to `null` because
 * booking execution and quote generation are EXPLICIT R26 non-goals (their outcome types are future work);
 * `undetermined`/`answer_enquiry`/`handoff_to_human` never reach `progress_goal` (earlier strategy rules
 * claim them) and produce no outcome regardless.
 */
export const GOAL_OUTCOME: Readonly<Record<ConversationGoal, ConversationOutcomeType | null>> = {
  undetermined: null,
  answer_enquiry: null,
  arrange_booking: null, // future: booking execution is an explicit R26 non-goal
  arrange_callback: "callback",
  provide_quote: null, // future: quote/pricing generation is an explicit R26 non-goal
  handoff_to_human: null,
};

// ---------------------------------------------------------------------
// RESOLUTION — the single derived next-outcome decision. Resolution and validation are UNIFIED.
// ---------------------------------------------------------------------

/** The abstention resolution for a reason — the single shape of "no outcome this turn". */
function abstain(reason: OutcomeAbstention): OutcomeResolution {
  return { kind: "none", reason };
}

/**
 * Resolve the conversational OUTCOME for a turn — THE single entry point the runtime reads. Consumes the
 * three already-derived observations it acts over: the R22 `strategy` (the progression TRIGGER — only a
 * `progress_goal` turn produces an outcome), the R19 `goal` (which SELECTS the outcome type via
 * {@link GOAL_OUTCOME}), and the R20 `information` (the PAYLOAD the outcome carries).
 *
 * Pure, TOTAL over any (strategy, goal, information), and DETERMINISTIC — the same inputs always yield the
 * same resolution. RESOLUTION and VALIDATION are UNIFIED: an actionable outcome is returned ONLY when its
 * payload re-passes the R20 field validator (never a second, forked check), so a malformed value can never
 * become a recordable outcome; otherwise the engine ABSTAINS with a reason. Persists NOTHING — the runtime
 * decides whether and where to record an actionable outcome. THE single source of truth for conversational
 * outcome resolution — every consumer resolves the outcome through this function and no other way; no
 * feature implements independent outcome-resolution logic.
 */
export function resolveOutcome(
  strategy: ConversationStrategy,
  goal: ConversationGoal,
  information: ConversationInformation,
): OutcomeResolution {
  // Only a `progress_goal` strategy ACTS. Every other strategy (acknowledge / request_information /
  // provide_answer / escalate_to_human) hands the turn back, answers, or routes to a human — none produces
  // an internal outcome. This is the exact R26 trigger: `progress_goal` fires ONLY for a SATISFIED
  // actionable objective (the earlier strategy rules claim undetermined / unsatisfied / answer / handoff).
  if (strategy !== "progress_goal") return abstain("not_progressing");

  // The satisfied objective selects the outcome type. A goal with no R26 outcome (booking / quote — future;
  // or a goal that never reaches progress_goal) progresses conversationally but records nothing here.
  const type = GOAL_OUTCOME[goal];
  if (type === null) return abstain("goal_has_no_outcome");

  // Resolve the outcome for its type. A closed switch keeps this exhaustive as the vocabulary grows: adding
  // an OUTCOME_TYPE without a case here fails `tsc`. Each arm re-validates its payload through the R20
  // authority, so an actionable outcome is always well-formed.
  switch (type) {
    case "callback": {
      // The callback needs the phone number the satisfied objective already gathered. Re-validate it
      // through the ONE R20 predicate (defence-in-depth over the persisted value); absent or malformed ⇒
      // abstain rather than record an unringable outcome.
      const phone = information.phone_number;
      if (phone === undefined || !isValidFieldValue("phone_number", phone)) {
        return abstain("incomplete");
      }
      return { kind: "callback", phone_number: phone };
    }
  }
}

// ---------------------------------------------------------------------
// VALIDATION / PROJECTION — named predicates over a resolution the runtime reads.
// ---------------------------------------------------------------------

/**
 * Whether a resolution is an ACTIONABLE outcome (a concrete internal outcome to record), as opposed to an
 * abstention. A type guard: it narrows an {@link OutcomeResolution} to its actionable arms, so the runtime
 * persists ONLY an actionable outcome and an abstention is a total no-op. THE predicate the runtime gates
 * persistence on — there is no other "should we record this?" rule.
 */
export function isActionableOutcome(
  resolution: OutcomeResolution,
): resolution is CallbackOutcome {
  return resolution.kind !== "none";
}

/**
 * The {@link ConversationOutcomeType} of a resolution (for audit/persistence keying), or `null` for an
 * abstention. Pure and total — the actionable arm's `kind` IS its outcome type, so the mapping is the
 * identity on the actionable arms and `null` on the abstention.
 */
export function outcomeTypeOf(resolution: OutcomeResolution): ConversationOutcomeType | null {
  return resolution.kind === "none" ? null : resolution.kind;
}
