// =====================================================================
// THE CONVERSATION RUNTIME — PURE CORE (CEO Directive #018; R15: MULTI-TURN CONVERSATION RUNTIME;
// R17: FORMAL CONVERSATION STATE MACHINE).
//
// This is the deterministic, leaf heart of the multi-turn runtime. It holds the conversation state,
// the total transition functions the server orchestrator folds after each turn, AND (R17) the formal
// state machine that GOVERNS every persisted progression. It reaches NOTHING: no policy, no provider,
// no ledger, no database, no model — it is a pure state calculus over plain inputs, so it is
// exhaustively unit-testable in isolation and can never become a second enforcement, transport, or
// generation path.
//
// R15 GAVE IT A COARSE OWNERSHIP MARKER; R17 MAKES IT A GOVERNED STATE MACHINE. The state still
// answers exactly one question — "which party owes the next turn?" — over three coarse values. R15
// ADVANCED that marker by a from-agnostic fold; R17 adds the CANONICAL CONVERSATION STATE MACHINE: an
// explicit legal-edge transition relation ({@link CONVERSATION_TRANSITIONS}), a total validator
// ({@link isValidConversationTransition}), and a planner ({@link planConversationTransition}) that
// classifies every transition as an `advance` (a validated change to persist), an `unchanged`
// self-loop (nothing to persist), or a `rejected` illegal edge (REFUSED, never persisted). The machine
// is the SINGLE AUTHORITY over how the marker progresses — every persisted advance passes its
// validation — yet it derives the transition from the coarse (prior state, turn OUTCOME) ALONE and
// NEVER from message content, so it never GATES a turn on the state: slot filling and intent
// progression remain EXPLICIT non-goals this core encodes none of. The relation is a SUPERSET of the
// R15 fold's image, so it permits every progression the runtime already makes and changes none.
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

// =====================================================================
// THE FORMAL CONVERSATION STATE MACHINE (CEO Directive #018, R17).
//
// R15's fold ({@link advanceConversationState}) is TOTAL but from-AGNOSTIC and UNGUARDED: it computes
// a target from the routing alone and the runtime persisted it on any change. R17 wraps that fold in a
// FORMAL STATE MACHINE — an explicit graph of the transitions the conversation may make, a validator,
// and a planner — so that EVERY persisted progression passes a declared, single-sourced validation and
// no feature can advance the state along an edge the machine does not permit. The machine adds
// governance, not new movement: its legal-edge relation is exactly the IMAGE of the R15 fold, so it
// accepts every transition the runtime already makes and REJECTS only the impossible ones — a
// conversation never regresses to `awaiting_ai` (the "AI owes the first turn" state) as the RESULT of
// its own turn outcome; only a fresh customer inbound owes the AI a first turn, and that is not a
// turn-driven transition. It stays a pure, content-free calculus: the transition is a function of the
// coarse (prior state, turn outcome) ALONE, never of what was said, so it encodes no intent
// progression or slot filling (both EXPLICIT R17 non-goals).
// =====================================================================

/**
 * The legal directed edges of the conversation state machine: for each state, the states a single
 * governed transition may advance INTO. This is exactly the IMAGE of {@link advanceConversationState}
 * over every {@link TurnRouting} — so it permits every progression the runtime actually makes and
 * NOTHING more. A turn outcome never targets `awaiting_ai` from another state, so `awaiting_ai` is
 * reachable only as a self-loop: a conversation cannot regress to "the AI owes the first turn" as the
 * result of a turn. The SINGLE SOURCE of the transition graph on the TypeScript side.
 */
export const CONVERSATION_TRANSITIONS: Readonly<
  Record<ConversationState, readonly ConversationState[]>
> = {
  // The AI owes the turn → it answers (sent → customer), holds/refuses (→ human), or does nothing
  // (noop → self). Every target reachable.
  awaiting_ai: ["awaiting_ai", "awaiting_customer", "awaiting_human"],
  // The ball is with the customer → a (re-driven) turn either sends (self) or holds/refuses (→ human);
  // it never re-owes the AI a FIRST turn (that is a fresh inbound, not a turn outcome).
  awaiting_customer: ["awaiting_customer", "awaiting_human"],
  // A human owes the next action → a turn either sends (→ customer) or holds/refuses again (self); it
  // never regresses to `awaiting_ai`.
  awaiting_human: ["awaiting_customer", "awaiting_human"],
};

/**
 * Whether `from → to` is a declared legal edge of the conversation state machine. TOTAL and
 * DETERMINISTIC over the whole state × state space. This is the governing authority the runtime
 * consults before it PERSISTS any progression: a transition the relation does not contain is REJECTED
 * and never written. Reflexive edges (`to === from`) are legal for every state — an idle self-loop
 * never leaves its owner — because each state lists itself among its targets.
 */
export function isValidConversationTransition(
  from: ConversationState,
  to: ConversationState,
): boolean {
  return CONVERSATION_TRANSITIONS[from].includes(to);
}

/**
 * A governed state transition the runtime executes, discriminated on `kind`:
 *   • advance   — a validated change (`from` ≠ `to`, a declared legal edge); the runtime PERSISTS `to`.
 *   • unchanged — a self-loop (`to` === `from`); ownership does not move, so nothing is persisted.
 *   • rejected  — an edge OUTSIDE the declared relation; the machine REFUSES it (never persisted) and
 *                 the runtime records it as a governance event. `reason` names the illegal edge.
 * So the runtime persists exactly the `advance` case and can never write an ungoverned progression.
 */
export type ConversationTransitionPlan =
  | { kind: "advance"; from: ConversationState; to: ConversationState }
  | { kind: "unchanged"; state: ConversationState }
  | { kind: "rejected"; from: ConversationState; to: ConversationState; reason: string };

/**
 * Plan a `from → to` state transition through the machine: a self-loop is `unchanged`, a declared
 * legal edge is an `advance` to persist, and ANY OTHER edge is `rejected`. TOTAL and DETERMINISTIC —
 * every (from, to) pair resolves to exactly one plan. THE validation gate every persisted progression
 * passes: an illegal edge is refused here and never reaches the writer.
 */
export function planStateTransition(
  from: ConversationState,
  to: ConversationState,
): ConversationTransitionPlan {
  if (to === from) return { kind: "unchanged", state: from };
  if (isValidConversationTransition(from, to)) return { kind: "advance", from, to };
  return {
    kind: "rejected",
    from,
    to,
    reason: `illegal conversation transition ${from} → ${to} (not a declared edge of the state machine)`,
  };
}

/**
 * Plan the transition a TURN drives: fold the routing (the turn OUTCOME/event) to its target state via
 * the R15 transition function, then VALIDATE that (prior → target) edge through the machine. Because
 * the fold's image is exactly the legal-edge relation, a real turn ALWAYS yields an `advance` or an
 * `unchanged` and NEVER a `rejected` — a proven safety property of the engine — yet the validation
 * still gates the persist, so the state machine is the single authority over every progression. This
 * is the one entry point the runtime calls to govern a turn's state advance.
 */
export function planConversationTransition(
  from: ConversationState,
  routing: TurnRouting,
): ConversationTransitionPlan {
  return planStateTransition(from, advanceConversationState(from, routing));
}
