// =====================================================================
// THE CONVERSATION RUNTIME — PURE CORE (CEO Directive #018, R15: MULTI-TURN CONVERSATION RUNTIME).
//
// This is the deterministic, leaf heart of the multi-turn runtime. It holds the MINIMAL
// conversation state and the total transition functions the server orchestrator folds after each
// turn. It reaches NOTHING: no policy, no provider, no ledger, no database, no model — it is a pure
// state calculus over plain inputs, so it is exhaustively unit-testable in isolation and can never
// become a second enforcement, transport, or generation path.
//
// IT IS A COARSE TURN-OWNERSHIP MARKER, NOT A STATE MACHINE. The state answers exactly one
// question — "which party owes the next turn?" — and the runtime ADVANCES it after a turn; it never
// GATES a turn on it. A formal conversation state machine, slot filling, and intent progression are
// EXPLICIT R16+ NON-GOALS; this core deliberately encodes none of them. Three values, two total
// folds, nothing more.
//
// IT NAMES NO DECISION SURFACE. The turn classifier reads the guardrail VERDICT as a plain string
// the canonical service already resolved (`allow` | `review` | `block`). It imports no policy
// module and names none of the policy's decision functions, so the single-enforcement-path invariant
// (only server/services/receptionist.ts reaches the guardrail) is untouched by this file.
// =====================================================================

/**
 * The MINIMAL conversation state: which party owes the next turn.
 *   • awaiting_ai       — a customer message landed; the AI owes the next reply.
 *   • awaiting_customer — the AI answered and it was sent; the ball is with the customer.
 *   • awaiting_human    — a reply was held for review or refused as prohibited; a human owes the
 *                         next action (the Reply Review Inbox, or a decision on a blocked reply).
 * A coarse ownership marker — deliberately NOT a formal state machine (an R16 non-goal).
 */
export type ConversationState = "awaiting_ai" | "awaiting_customer" | "awaiting_human";

/** Every conversation state, in a stable canonical order. The single source of the state vocabulary
 *  on the TypeScript side — kept in lock-step with the migration's CHECK constraint. */
export const CONVERSATION_STATES: readonly ConversationState[] = [
  "awaiting_ai",
  "awaiting_customer",
  "awaiting_human",
];

/** A brand-new conversation owes an AI turn: the customer has just made contact. Also the safe
 *  default when a persisted value is absent or unrecognised. */
export const INITIAL_CONVERSATION_STATE: ConversationState = "awaiting_ai";

/** Narrow an arbitrary value to a known {@link ConversationState}. */
export function isConversationState(value: unknown): value is ConversationState {
  return (
    typeof value === "string" && (CONVERSATION_STATES as readonly string[]).includes(value)
  );
}

/**
 * Coerce a possibly-unknown persisted value to a {@link ConversationState}, defaulting to
 * {@link INITIAL_CONVERSATION_STATE} when it is absent or out of vocabulary. DENY-UNKNOWN and
 * TOTAL: any input resolves to a valid state, so the runtime can read a raw column value without a
 * throw and without ever adopting a state the migration would reject.
 */
export function coerceConversationState(value: unknown): ConversationState {
  return isConversationState(value) ? value : INITIAL_CONVERSATION_STATE;
}

/**
 * How a single turn resolved — the fold input for the state advance:
 *   • sent    — the reply was enforced, audited `allow`, and carried to transport;
 *   • held    — the reply was audited `review` (a human owes the send — the Reply Review Inbox);
 *   • refused — the reply was audited `block` (never safe to send; a human owes the next action);
 *   • noop    — no audit was produced (a duplicate short-circuit, or no reply attempt) — nothing
 *               was sent or recorded, so ownership is unchanged.
 */
export type TurnRouting = "sent" | "held" | "refused" | "noop";

/**
 * The dispatch facts the turn classifier folds. STRUCTURAL — the verdict is a plain string the
 * canonical service already resolved, so this leaf imports no policy type and reaches no decision
 * surface.
 */
export type TurnDispatchFacts = {
  /** The guardrail verdict string (`allow` | `review` | `block`), or null when none was produced. */
  verdict: string | null;
  /** True when a prior SENT transport short-circuited this turn before any audit or send. */
  duplicate: boolean;
  /** True when the turn produced an audit (an enforcement decision was durably recorded). */
  auditProduced: boolean;
};

/**
 * Classify how a turn resolved from its dispatch facts. TOTAL and DETERMINISTIC — every input maps
 * to exactly one routing:
 *   • a duplicate, or a turn that produced no audit → `noop` (nothing advanced);
 *   • an `allow`                                    → `sent`;
 *   • a `block`                                     → `refused`;
 *   • anything else that produced an audit (i.e. a `review`) → `held`.
 * It MIRRORS but never REACHES the canonical policy: the verdict is a plain string the service
 * resolved through the single enforcement chokepoint, so no decision function is named here.
 */
export function classifyTurn(facts: TurnDispatchFacts): TurnRouting {
  if (facts.duplicate || !facts.auditProduced) return "noop";
  if (facts.verdict === "allow") return "sent";
  if (facts.verdict === "block") return "refused";
  return "held";
}

/**
 * The conversation state a routing advances TO, or null when the routing leaves the state unchanged
 * (a `noop`). TOTAL and DETERMINISTIC:
 *   • sent    → awaiting_customer (the AI answered; the ball is with the customer);
 *   • held    → awaiting_human    (a human owes the review send);
 *   • refused → awaiting_human    (a human owes the next action on a blocked reply);
 *   • noop    → null              (nothing was sent or recorded; ownership is unchanged).
 */
export function nextConversationState(routing: TurnRouting): ConversationState | null {
  switch (routing) {
    case "sent":
      return "awaiting_customer";
    case "held":
      return "awaiting_human";
    case "refused":
      return "awaiting_human";
    case "noop":
      return null;
  }
}

/**
 * Advance a conversation's state by one turn. TOTAL: returns the routing's target state, or the
 * CURRENT state unchanged when the routing advances nowhere (a `noop`). DETERMINISTIC — the same
 * (current, routing) always yields the same next state — so a conversation's state is a pure fold
 * over its ordered turn outcomes.
 */
export function advanceConversationState(
  current: ConversationState,
  routing: TurnRouting,
): ConversationState {
  return nextConversationState(routing) ?? current;
}
