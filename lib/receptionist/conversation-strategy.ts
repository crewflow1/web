// =====================================================================
// THE CONVERSATION STRATEGY ENGINE — PURE CORE (CEO Directive #018; R22: CONVERSATION STRATEGY ENGINE).
//
// R15 gave the runtime a coarse OWNERSHIP marker; R17 wrapped it in a formal STATE MACHINE ("which party
// owes the next turn"); R18 added the INTENT ENGINE ("what does the customer WANT?"); R19 added the GOAL
// ENGINE ("what is the conversation trying to ACCOMPLISH?"); R20 added the INFORMATION ENGINE ("what
// STRUCTURED FACTS has the customer PROVIDED?"); R21 added the GAP ENGINE ("given the objective and the
// facts we hold, WHAT IS STILL MISSING?"). R22 is the next layer UP — the single, canonical authority over
// a SIXTH question, one DERIVED from the layer beneath it: "given the gap, HOW SHOULD THE CONVERSATION
// PROGRESS — what is the next conversational ACTION, what does it act ON, and does it expect a REPLY?" —
// the conversational STRATEGY. It is the receptionist's DECISION-MAKING layer: it turns the completeness
// OBSERVATION (R21) into a chosen next MOVE. Slot filling is the FIRST strategy expressed here — a
// `request_information` decision naming the one field to ask for — but it is just one member of the
// strategy vocabulary, not the engine's purpose.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING. Like the R21 gap, the strategy is the SECOND layer
// of the stack that adds NO column and NO migration. The strategy is a TOTAL, DETERMINISTIC function of a
// SINGLE already-DERIVED observation — the {@link ConversationGap} (R21), which is itself a pure projection
// of the persisted goal (R19) + information (R20). Persisting the strategy would create a source of truth
// that could drift from the gap it derives from; instead the strategy is COMPUTED wherever it is needed
// (surfaced on the runtime turn result; re-derived on every read of the read model) and never stored. Goal
// + information remain the ONLY persisted conversational state; the gap and the strategy are always fresh
// projections of them, so neither can ever be stale.
//
// IT DECIDES, IT NEVER ACTS. Determining that the next move is "ask for the postcode", "provide the answer",
// or "escalate to a human" is a pure CHOICE over what the gap reports — a planning DECISION. Composing the
// question, generating the answer, routing to a human, booking, scheduling, CRM writes and every side
// effect are EXPLICIT R22 NON-GOALS this engine does not perform: it names the next conversational action
// and stops. ACTING on the strategy — emitting the prompt, executing the business action — is a future
// capability that will CONSUME this engine. The Strategy Engine determines CONVERSATIONAL actions ONLY; it
// never executes a business action. Slot filling is the first CONSUMER as much as the first strategy: a
// future capability reads a `request_information` decision to know which field to request next, but the
// request itself, and every business action, lives OUTSIDE this engine.
//
// IT REUSES THE R21 GAP SURFACE — IT FORKS NO COMPLETENESS LOGIC. The questions "what does the objective
// still need?", "which missing item matters most?", "is the objective satisfied?" are answered by the R21
// gap engine ({@link ConversationGap} — its `missing`, `nextRequired`, `satisfied`, `turnRequired`). This
// engine IMPORTS that derived view and re-implements NONE of it: it re-runs no completeness arithmetic,
// re-orders no priority, and never touches the R20 slot surface directly — it reads the gap the R21 engine
// already computed and adds only the planning SEMANTICS that sit on top: a cross-goal PRIORITY ordering over
// STRATEGIES ({@link STRATEGY_PRIORITY}), the SINGLE next-action decision, and what that decision targets
// and expects. So there is exactly ONE definition of "what is missing / most important / satisfied" (R21)
// and exactly ONE definition of "what to DO about it" (R22) — no feature computes either independently.
//
// IT DUPLICATES NOTHING BENEATH IT. It consumes an ALREADY-derived gap; it NEVER re-assembles context,
// re-classifies intent, re-resolves goal, re-extracts information, or re-detects the gap — it names none of
// those resolvers, planners, extractors or the gap detector. Its only imports are the R21 gap TYPE (which it
// reads the decision from) and the R20 information-field TYPE (which types what a `request_information`
// decision targets); BOTH are type-only, so this module names NO runtime value from any other layer. It
// reaches NO policy, NO provider, NO ledger, NO DB, NO clock, NO RNG and — the cardinal rule shared with the
// whole stack — NO MODEL: the strategy is chosen by a named, total, deterministic ordered rule table, so the
// same gap always yields the same decision and the derivation is reconstructable from source. The layering
// stays a clean, linear stack: Context → Intent → Goal → Information → Gap → Strategy.
// =====================================================================

import type { ConversationGap } from "@/lib/receptionist/conversation-gap";
import type { InformationField } from "@/lib/receptionist/conversation-information";

// ---------------------------------------------------------------------
// The STRATEGY vocabulary — the closed set of next conversational actions.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of conversational STRATEGIES — the FIVE next actions the receptionist can decide to
 * take on a turn, deliberately DISJOINT from the R19 goal vocabulary (a strategy is a MOVE, not an
 * objective):
 *   • acknowledge         — the objective is not yet known; open the conversation / receive the customer.
 *   • request_information — the objective needs a fact the customer has not provided; ask for the single
 *                           highest-priority missing field. THE slot-filling strategy.
 *   • provide_answer      — the objective is to answer an enquiry and it is satisfied; give the answer.
 *   • escalate_to_human   — the objective is a human handoff and it is satisfied; route to a person.
 *   • progress_goal       — the objective is a satisfied actionable goal (booking / callback / quote); carry
 *                           it forward. The catch-all forward move once nothing is outstanding.
 * A closed union: every {@link resolveStrategy} decision is one of these, so a consumer can switch
 * exhaustively.
 */
export type ConversationStrategy =
  | "acknowledge"
  | "request_information"
  | "provide_answer"
  | "escalate_to_human"
  | "progress_goal";

// ---------------------------------------------------------------------
// The PRIORITY model — an ordered rule table over the gap, most-important FIRST.
// ---------------------------------------------------------------------

/**
 * One STRATEGY RULE — a candidate strategy paired with the gap PREDICATE that selects it. The rules are
 * evaluated in declaration order (see {@link STRATEGY_RULES}); the FIRST whose `when` holds wins. Pure: a
 * predicate reads only the already-derived {@link ConversationGap}, never any external state.
 */
type StrategyRule = {
  readonly strategy: ConversationStrategy;
  readonly when: (gap: ConversationGap) => boolean;
};

/**
 * The ORDERED decision table — the strategy engine's one PRIORITY rule, defined ONCE here. Evaluated
 * top-to-bottom, FIRST match wins, so the ordering IS the priority:
 *   1. acknowledge         — an undetermined objective outranks everything: until we know what the customer
 *                            wants, the only move is to receive them.
 *   2. request_information — an unsatisfied objective (the gap reports `!satisfied`, so `nextRequired` names a
 *                            field) is asked about BEFORE any goal-specific move: gather what is missing first.
 *   3. provide_answer      — a satisfied answer_enquiry objective: nothing outstanding, so answer.
 *   4. escalate_to_human   — a satisfied handoff_to_human objective: nothing outstanding, so route to a human.
 *   5. progress_goal       — the UNCONDITIONAL final guard: any other satisfied objective (an actionable
 *                            booking / callback / quote) carries forward. Being unconditional makes
 *                            {@link selectStrategy} TOTAL — every gap matches at least this rule.
 * The keys off `gap.goal` compare STRING LITERALS against the R19 goal vocabulary rather than importing the
 * goal module, so the strategy engine adds no importer to that layer. `STRATEGY_PRIORITY` is DERIVED from
 * this table (never a second hand-maintained list), so the priority order and the rule order can never drift.
 */
const STRATEGY_RULES: readonly StrategyRule[] = [
  { strategy: "acknowledge", when: (g) => g.goal === "undetermined" },
  { strategy: "request_information", when: (g) => !g.satisfied },
  { strategy: "provide_answer", when: (g) => g.goal === "answer_enquiry" },
  { strategy: "escalate_to_human", when: (g) => g.goal === "handoff_to_human" },
  { strategy: "progress_goal", when: () => true },
];

/**
 * The strategy PRIORITY order, most-important first — DERIVED from {@link STRATEGY_RULES} (the rule table is
 * the single source of truth; this is its projection onto just the strategy names). Because it is derived,
 * the priority order can never drift from the resolution order. A permutation of the whole
 * {@link ConversationStrategy} vocabulary; the unit + security tiers pin that it is exact (no missing
 * strategy, no duplicate, no out-of-vocabulary entry).
 */
export const STRATEGY_PRIORITY: readonly ConversationStrategy[] =
  STRATEGY_RULES.map((rule) => rule.strategy);

// ---------------------------------------------------------------------
// The STRATEGY model — the derived next-action decision for a gap.
// ---------------------------------------------------------------------

/**
 * The conversational STRATEGY DECISION for one gap — the DERIVED next-action view a future capability reads:
 *   • strategy    — the chosen next conversational action (the highest-priority rule that matched the gap).
 *   • target      — the single {@link InformationField} the action acts on, or null. Non-null ONLY for a
 *                   `request_information` decision, where it is the gap's `nextRequired` field (the one slot
 *                   to ask for next); null for every other strategy, which acts on no specific field.
 *   • expectsReply — whether the action expects a customer REPLY in return: true for `acknowledge` and
 *                   `request_information` (both hand the turn back to the customer), false for the forward
 *                   moves (`provide_answer`, `escalate_to_human`, `progress_goal`). A pure OBSERVATION about
 *                   the chosen move — it does NOT gate the runtime (the turn still generates its reply); it
 *                   tells a future capability whether this move solicits another customer turn.
 * Every field is a total, deterministic function of the gap; the whole object is derived, never persisted.
 */
export type StrategyDecision = {
  strategy: ConversationStrategy;
  target: InformationField | null;
  expectsReply: boolean;
};

/**
 * Select the single next STRATEGY for a gap — the head of the ordered {@link STRATEGY_RULES} table whose
 * predicate holds. Total: the final rule is unconditional, so some rule always matches; the trailing return
 * is unreachable and present only so the function is total without relying on the loop's control flow.
 * Deterministic: the same gap always selects the same strategy.
 */
function selectStrategy(gap: ConversationGap): ConversationStrategy {
  for (const rule of STRATEGY_RULES) {
    if (rule.when(gap)) return rule.strategy;
  }
  return "progress_goal"; // unreachable — the final rule is unconditional; present for totality.
}

/**
 * Resolve the conversational STRATEGY for a gap — THE single entry point the runtime and the read model
 * call. Selects the next action ({@link selectStrategy}) and composes its decision: what it TARGETS (the
 * gap's `nextRequired` field for a `request_information` move, else null) and whether it EXPECTS a reply
 * (the two customer-facing moves). Pure, TOTAL over any gap, and DETERMINISTIC — the same gap always yields
 * the same decision. Persists NOTHING: the strategy is a fresh projection of the derived gap, never a stored
 * observation. THE single source of truth for conversational planning — every consumer derives the next
 * action through this function and no other way; no feature implements independent conversation-planning
 * logic.
 */
export function resolveStrategy(gap: ConversationGap): StrategyDecision {
  const strategy = selectStrategy(gap);
  return {
    strategy,
    target: strategy === "request_information" ? gap.nextRequired : null,
    expectsReply:
      strategy === "acknowledge" || strategy === "request_information",
  };
}
