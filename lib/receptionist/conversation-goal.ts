// =====================================================================
// THE CONVERSATION GOAL ENGINE — PURE CORE (CEO Directive #018; R19: CONVERSATION GOAL ENGINE).
//
// R15 gave the runtime a coarse OWNERSHIP marker; R17 wrapped it in a formal STATE MACHINE ("which party
// owes the next turn"); R18 added the INTENT ENGINE ("what does the customer WANT?"). R19 is the next
// layer UP — the single, canonical authority over a THIRD question: "what is the conversation trying to
// ACCOMPLISH?" — the conversational GOAL (its OBJECTIVE). It executes ON TOP of the R18 intent engine and
// consumes the intent that engine resolves; it does NOT move the ownership state, does NOT move the intent
// marker, does NOT re-orchestrate the runtime, re-assemble context, reconstruct a conversation, or
// re-classify the customer's message — every one of those layers already exists and this engine reuses
// them wholesale. It becomes the SINGLE SOURCE OF TRUTH for the conversational objective: no feature may
// resolve a goal independently, and every future slot-filling, booking, scheduling, memory-retrieval,
// customer-support or workflow capability consumes THIS engine's objective.
//
// IT SITS ON THE INTENT, NOT THE CONTEXT. Intent answers "what does the customer want on their latest
// turn?"; the GOAL elevates that per-turn WANT into the conversation-level OBJECTIVE the receptionist
// pursues. So the engine's SOLE input is a resolved {@link ConversationIntent} — the canonical projection
// of the context the R18 engine already produced. It NEVER calls the intent resolver and NEVER touches the
// R12 context, so it DUPLICATES no intent resolution and no context assembly (both are R19 non-goals it
// must not re-implement). The context IS consumed — transitively, through the intent — at the runtime
// seam, which assembles the context ONCE (R16), resolves the intent from it (R18), and threads that intent
// here. The layering is a clean, linear stack: Context → Intent → Goal.
//
// IT IS A PURE STATE CALCULUS, exactly like lib/receptionist/runtime.ts and the R18 intent engine. It
// reaches NO policy, NO provider, NO ledger, NO database, NO clock, NO RNG and — the cardinal rule shared
// with the R12 assembler and the R18 engine — NO MODEL: the goal is resolved by a NAMED, TOTAL,
// DETERMINISTIC map from the resolved intent, never by an opaque model sample, so the same intent always
// resolves the same goal and the resolution is reconstructable from source. Its ONLY import is the R18
// intent engine (the intent TYPE it maps FROM); it reaches no second module.
//
// IT RECOGNISES AN OBJECTIVE, IT NEVER PURSUES ONE. Recognising that the conversation's objective is to
// arrange a booking, arrange a callback, provide a quote, answer an enquiry, or hand off to a human is
// GOAL CLASSIFICATION — a label on the conversational aim. Booking, AI scheduling, slot filling, memory
// retrieval and human handoff are EXPLICIT R19 NON-GOALS this engine does not perform: it names the
// objective and stops. Acting on a goal is a future capability that will CONSUME this engine.
//
// GOAL PROGRESSION MIRRORS THE R17 STATE MACHINE AND THE R18 INTENT ENGINE and NEVER BYPASSES EITHER. The
// engine has its own legal-edge relation ({@link GOAL_TRANSITIONS}), validator ({@link
// isValidGoalTransition}) and planner ({@link planGoalTransition}) — the same advance / unchanged /
// rejected discipline. Its ONE governance law is MONOTONIC OBJECTIVE: once a turn resolves a concrete
// goal, the engine never regresses to the initial `undetermined` (exactly as the state machine never
// regresses to `awaiting_ai` and intent never to `unknown`). The turn-driven planner ({@link
// planGoalProgression}) derives its target through a fold ({@link advanceGoal}) whose IMAGE is exactly the
// legal-edge relation, so a real turn ALWAYS yields an `advance` or an `unchanged` and NEVER a `rejected` —
// a proven safety property — while `planGoalTransition` keeps rejection independently reachable for an
// illegal raw edge. The engine governs the objective WITHIN the turn the state machine already owns and the
// intent engine already classified; it moves neither of their markers, so goal progression can never
// bypass the state machine or the intent engine.
// =====================================================================

import type { ConversationIntent } from "@/lib/receptionist/conversation-intent";

/**
 * The closed vocabulary of conversational GOALS — what the conversation is trying to ACCOMPLISH:
 *   • undetermined     — no objective resolved yet (the initial value; also the safe default for an
 *                        absent or out-of-vocabulary persisted value, and a turn with no intent signal).
 *   • answer_enquiry   — accomplish: answer the customer's general enquiry.
 *   • arrange_booking  — accomplish: arrange the appointment / booking the customer asked for.
 *   • arrange_callback — accomplish: arrange the callback the customer asked for.
 *   • provide_quote    — accomplish: provide the price / quote / estimate the customer asked for.
 *   • handoff_to_human — accomplish: hand the conversation to a human (the strongest objective).
 * A deliberately small, closed set — the engine LABELS the objective; it does not model a task graph. It is
 * the one-per-intent OBJECTIVE analogue of the R18 intent vocabulary: the intent names the customer's WANT,
 * the goal names the ACCOMPLISHMENT the conversation orients toward.
 */
export type ConversationGoal =
  | "undetermined"
  | "answer_enquiry"
  | "arrange_booking"
  | "arrange_callback"
  | "provide_quote"
  | "handoff_to_human";

/** Every conversational goal, in a stable canonical order (position-parallel to CONVERSATION_INTENTS). The
 *  single source of the goal vocabulary on the TypeScript side — kept in lock-step with the migration's
 *  CHECK constraint (supabase/migrations/20260824000000_receptionist_conversation_goal.sql). */
export const CONVERSATION_GOALS: readonly ConversationGoal[] = [
  "undetermined",
  "answer_enquiry",
  "arrange_booking",
  "arrange_callback",
  "provide_quote",
  "handoff_to_human",
];

/** A brand-new conversation has no resolved objective: the customer has just made contact and nothing has
 *  been accomplished-toward yet. Also the safe default when a persisted value is absent or unrecognised. */
export const INITIAL_CONVERSATION_GOAL: ConversationGoal = "undetermined";

/**
 * The CONCRETE (resolved) goals — every goal except the initial `undetermined`. Once a turn resolves one,
 * the engine never regresses to `undetermined` (MONOTONIC OBJECTIVE), the exact analogue of the R18 intent
 * engine never regressing to `unknown` and the R17 state machine never regressing to `awaiting_ai`. The
 * single source of "which goals are a resolved objective" — the transition relation and its tests both
 * derive from this.
 */
export const CONCRETE_GOALS: readonly ConversationGoal[] = CONVERSATION_GOALS.filter(
  (goal) => goal !== INITIAL_CONVERSATION_GOAL,
);

/** Narrow an arbitrary value to a known {@link ConversationGoal}. */
export function isConversationGoal(value: unknown): value is ConversationGoal {
  return typeof value === "string" && (CONVERSATION_GOALS as readonly string[]).includes(value);
}

/**
 * Coerce a possibly-unknown persisted value to a {@link ConversationGoal}, defaulting to
 * {@link INITIAL_CONVERSATION_GOAL} when it is absent or out of vocabulary. DENY-UNKNOWN and TOTAL: any
 * input resolves to a valid goal, so the runtime can read a raw column value without a throw and without
 * ever adopting a goal the migration would reject.
 */
export function coerceConversationGoal(value: unknown): ConversationGoal {
  return isConversationGoal(value) ? value : INITIAL_CONVERSATION_GOAL;
}

// ---------------------------------------------------------------------
// Resolution — deterministic, total, model-free. It ELEVATES the resolved INTENT to the OBJECTIVE.
// ---------------------------------------------------------------------

/**
 * The canonical intent → goal map: the OBJECTIVE each conversational intent elevates to. TOTAL over the
 * whole {@link ConversationIntent} vocabulary — the `Record` type makes the exhaustiveness a COMPILE-TIME
 * guarantee (a missing or out-of-vocabulary key fails `tsc`), so this map and the intent vocabulary can
 * never drift. Module-private: {@link resolveGoal} is the ONLY exported resolver, so a goal is resolved in
 * exactly one place and no feature can elevate an intent to an objective independently. One-per-intent by
 * design — the goal names the ACCOMPLISHMENT ("answer", "arrange", "provide", "handoff") the WANT implies,
 * preserving every distinction a future capability needs (a booking objective is distinct from a callback
 * objective; a quote objective from a general answer).
 */
const INTENT_TO_GOAL: Readonly<Record<ConversationIntent, ConversationGoal>> = {
  unknown: "undetermined",
  general_enquiry: "answer_enquiry",
  booking_interest: "arrange_booking",
  callback_request: "arrange_callback",
  quote_request: "provide_quote",
  human_handoff: "handoff_to_human",
};

/**
 * Resolve the CURRENT conversational goal from a resolved {@link ConversationIntent}. It ELEVATES the
 * intent the R18 engine produced (the context's canonical projection) into the OBJECTIVE the conversation
 * pursues. DETERMINISTIC, TOTAL and MODEL-FREE — the same intent always resolves the same goal — returning
 * {@link INITIAL_CONVERSATION_GOAL} when the intent carries no signal (`unknown`). THE single exported
 * resolver: every consumer resolves a goal through this function and no other way, so the engine is the
 * single source of truth for the conversational objective. It NEVER calls the intent resolver and NEVER
 * reads the context — it consumes an ALREADY-resolved intent — so it duplicates no intent resolution.
 */
export function resolveGoal(intent: ConversationIntent): ConversationGoal {
  return INTENT_TO_GOAL[intent];
}

// =====================================================================
// THE GOAL PROGRESSION MODEL (CEO Directive #018, R19).
//
// Resolution answers "what is the current objective?"; progression governs "how may the objective MOVE?".
// It is the faithful analogue of the R17 conversation state machine and the R18 intent engine: an explicit
// legal-edge relation, a total validator, and a planner that classifies every transition as an `advance`
// (a validated change to persist), an `unchanged` self-loop (nothing to persist), or a `rejected` illegal
// edge (refused, never persisted). Its ONE law is MONOTONIC OBJECTIVE — a concrete goal never regresses to
// `undetermined`, exactly as intent never regresses to `unknown` and state never to `awaiting_ai`. The
// relation is EXACTLY the image of the turn fold {@link advanceGoal}, so it permits every progression a
// turn actually makes and nothing more.
// =====================================================================

/**
 * The legal directed edges of the goal engine: for each goal, the goals a single governed transition may
 * advance INTO. From `undetermined`, a turn may resolve ANY goal (or stay undetermined). From a CONCRETE
 * goal, a turn may move to any concrete goal (itself included) but NEVER back to `undetermined` — the
 * objective is monotonic. This is exactly the IMAGE of {@link advanceGoal} over every resolved goal, so it
 * permits every progression a turn actually makes and NOTHING more. The SINGLE SOURCE of the transition
 * graph on the TypeScript side.
 */
export const GOAL_TRANSITIONS: Readonly<
  Record<ConversationGoal, readonly ConversationGoal[]>
> = {
  // Nothing is resolved yet → a turn may resolve to any goal, or leave it undetermined (no intent signal).
  undetermined: CONVERSATION_GOALS,
  // A concrete objective is known → a turn re-resolves to any concrete goal; it never un-resolves it.
  answer_enquiry: CONCRETE_GOALS,
  arrange_booking: CONCRETE_GOALS,
  arrange_callback: CONCRETE_GOALS,
  provide_quote: CONCRETE_GOALS,
  handoff_to_human: CONCRETE_GOALS,
};

/**
 * Whether `from → to` is a declared legal edge of the goal engine. TOTAL and DETERMINISTIC over the whole
 * goal × goal space. This is the governing authority the runtime consults before it PERSISTS any goal
 * progression: an edge the relation does not contain is REJECTED and never written. Reflexive edges
 * (`to === from`) are legal for every goal — an idle self-loop never un-resolves its objective — because
 * each goal lists itself among its targets.
 */
export function isValidGoalTransition(
  from: ConversationGoal,
  to: ConversationGoal,
): boolean {
  return GOAL_TRANSITIONS[from].includes(to);
}

/**
 * A governed goal transition the runtime executes, discriminated on `kind`:
 *   • advance   — a validated change (`from` ≠ `to`, a declared legal edge); the runtime PERSISTS `to`.
 *   • unchanged — a self-loop (`to` === `from`); the goal does not move, so nothing is persisted.
 *   • rejected  — an edge OUTSIDE the declared relation (a `concrete → undetermined` regression); the
 *                 engine REFUSES it (never persisted) and the runtime records it as a governance event.
 * So the runtime persists exactly the `advance` case and can never write an ungoverned progression.
 */
export type GoalTransitionPlan =
  | { kind: "advance"; from: ConversationGoal; to: ConversationGoal }
  | { kind: "unchanged"; goal: ConversationGoal }
  | { kind: "rejected"; from: ConversationGoal; to: ConversationGoal; reason: string };

/**
 * Plan a `from → to` goal transition through the engine: a self-loop is `unchanged`, a declared legal edge
 * is an `advance` to persist, and any other edge (only a `concrete → undetermined` regression is possible)
 * is `rejected`. TOTAL and DETERMINISTIC — every (from, to) pair resolves to exactly one plan. THE
 * validation gate every persisted progression passes: an illegal edge is refused here and never reaches the
 * writer.
 */
export function planGoalTransition(
  from: ConversationGoal,
  to: ConversationGoal,
): GoalTransitionPlan {
  if (to === from) return { kind: "unchanged", goal: from };
  if (isValidGoalTransition(from, to)) return { kind: "advance", from, to };
  return {
    kind: "rejected",
    from,
    to,
    reason: `illegal goal transition ${from} → ${to} (not a declared edge of the goal engine)`,
  };
}

/**
 * Fold a freshly-resolved goal onto the prior goal — the goal analogue of the R18 `advanceIntent` fold.
 * TOTAL: adopt the resolved goal, EXCEPT when the turn resolved no objective (`undetermined`), in which
 * case KEEP the prior goal. This is what makes progression monotonic: a turn with no intent signal never
 * drags a known concrete objective back to `undetermined`. DETERMINISTIC — the same (prior, resolved)
 * always yields the same next goal — so a conversation's goal is a pure fold over its ordered per-turn
 * resolutions.
 */
export function advanceGoal(
  prior: ConversationGoal,
  resolved: ConversationGoal,
): ConversationGoal {
  return resolved === INITIAL_CONVERSATION_GOAL ? prior : resolved;
}

/**
 * Plan the progression a TURN drives: fold the resolved goal onto the prior via {@link advanceGoal}, then
 * VALIDATE that (prior → target) edge through the engine. Because the fold's image is exactly the
 * legal-edge relation, a real turn ALWAYS yields an `advance` or an `unchanged` and NEVER a `rejected` — a
 * proven safety property — yet the validation still gates the persist, so the engine is the single
 * authority over every goal progression. This is the one entry point the runtime calls to govern a turn's
 * goal advance, given the goal it resolved from the intent.
 */
export function planGoalProgression(
  prior: ConversationGoal,
  resolved: ConversationGoal,
): GoalTransitionPlan {
  return planGoalTransition(prior, advanceGoal(prior, resolved));
}
