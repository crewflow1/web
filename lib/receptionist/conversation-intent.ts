// =====================================================================
// THE CONVERSATION INTENT ENGINE — PURE CORE (CEO Directive #018; R18: CONVERSATION INTENT ENGINE).
//
// R15 gave the runtime a coarse OWNERSHIP marker; R17 wrapped that marker in a formal STATE MACHINE
// that governs "which party owes the next turn". R18 is the next layer UP — the single, canonical
// authority over a DIFFERENT question: "what does the customer WANT?" — the conversational INTENT. It
// executes ON TOP of the R17 state machine and consumes the canonical R12/R16 conversation context; it
// does NOT move the ownership state, re-orchestrate the runtime, re-assemble context, or reconstruct a
// conversation — those layers already exist and this engine reuses them wholesale. It becomes the SINGLE
// SOURCE OF TRUTH for conversational intent: no feature may resolve intent independently, and every
// future slot-filling, booking, scheduling, memory-retrieval, customer-support or workflow capability
// consumes THIS engine.
//
// IT IS A PURE STATE CALCULUS, exactly like lib/receptionist/runtime.ts. It reaches NO policy, NO
// provider, NO ledger, NO database, NO clock, NO RNG and — the cardinal rule shared with the R12
// assembler — NO MODEL: intent is resolved by NAMED, DETERMINISTIC rules over the customer's latest
// message, never by an opaque model sample, so the same conversation always resolves the same intent
// and the resolution is reconstructable from source. It reuses two existing PURE layers and nothing
// else: the R2 booking DETECTOR ({@link detectBookingIntent}) as the single booking-recognition
// authority, and the R12 conversation CONTEXT ({@link ConversationContext}) as its sole input contract.
//
// IT RECOGNISES, IT NEVER ACTS. Recognising that a customer asked to book, to be called back, for a
// quote, or for a human is INTENT CLASSIFICATION — a label. Booking, AI scheduling, slot filling,
// memory retrieval and human handoff are EXPLICIT R18 NON-GOALS this engine does not perform: it names
// the intent and stops. Acting on an intent is a future capability that will CONSUME this engine.
//
// INTENT PROGRESSION MIRRORS THE R17 STATE MACHINE and NEVER BYPASSES IT. The engine has its own
// legal-edge relation ({@link INTENT_TRANSITIONS}), validator ({@link isValidIntentTransition}) and
// planner ({@link planIntentTransition}) — the same advance / unchanged / rejected discipline as the
// state machine. Its ONE governance law is MONOTONIC KNOWLEDGE: once a turn classifies a concrete
// intent, the engine never regresses to the initial `unknown` (exactly as the state machine never
// regresses to `awaiting_ai`). The turn-driven planner ({@link planIntentProgression}) derives its
// target through a fold ({@link advanceIntent}) whose IMAGE is exactly the legal-edge relation, so a
// real turn ALWAYS yields an `advance` or an `unchanged` and NEVER a `rejected` — a proven safety
// property — while `planIntentTransition` keeps rejection independently reachable for an illegal raw
// edge. The engine governs intent WITHIN the turn the state machine already owns; it never advances the
// ownership marker, so intent progression can never bypass the state machine.
// =====================================================================

import { detectBookingIntent } from "@/lib/receptionist/intent";
import type { ConversationContext } from "@/lib/receptionist/conversation-context";

/**
 * The closed vocabulary of conversational intent — what the customer WANTS on their latest turn:
 *   • unknown          — no classified intent yet (the initial value; also the safe default for an
 *                        absent or out-of-vocabulary persisted value, and a content-free turn).
 *   • general_enquiry  — a substantive customer message with no specialised signal.
 *   • booking_interest — the customer asked to book / arrange an appointment (R2 appointment cue).
 *   • callback_request — the customer asked to be called back (R2 callback cue).
 *   • quote_request    — the customer asked for a price / quote / estimate.
 *   • human_handoff    — the customer asked to speak to a human (overrides every other signal).
 * A deliberately small, closed set — the engine LABELS intent; it does not model a task graph.
 */
export type ConversationIntent =
  | "unknown"
  | "general_enquiry"
  | "booking_interest"
  | "callback_request"
  | "quote_request"
  | "human_handoff";

/** Every conversational intent, in a stable canonical order. The single source of the intent
 *  vocabulary on the TypeScript side — kept in lock-step with the migration's CHECK constraint
 *  (supabase/migrations/20260823000000_receptionist_conversation_intent.sql). */
export const CONVERSATION_INTENTS: readonly ConversationIntent[] = [
  "unknown",
  "general_enquiry",
  "booking_interest",
  "callback_request",
  "quote_request",
  "human_handoff",
];

/** A brand-new conversation has no classified intent: the customer has just made contact and nothing
 *  has been resolved yet. Also the safe default when a persisted value is absent or unrecognised. */
export const INITIAL_CONVERSATION_INTENT: ConversationIntent = "unknown";

/**
 * The CONCRETE (classified) intents — every intent except the initial `unknown`. Once a turn
 * classifies one, the engine never regresses to `unknown` (MONOTONIC KNOWLEDGE), the exact analogue of
 * the R17 state machine never regressing to `awaiting_ai`. The single source of "which intents are a
 * resolved classification" — the transition relation and its tests both derive from this.
 */
export const CONCRETE_INTENTS: readonly ConversationIntent[] = CONVERSATION_INTENTS.filter(
  (intent) => intent !== INITIAL_CONVERSATION_INTENT,
);

/** Narrow an arbitrary value to a known {@link ConversationIntent}. */
export function isConversationIntent(value: unknown): value is ConversationIntent {
  return typeof value === "string" && (CONVERSATION_INTENTS as readonly string[]).includes(value);
}

/**
 * Coerce a possibly-unknown persisted value to a {@link ConversationIntent}, defaulting to
 * {@link INITIAL_CONVERSATION_INTENT} when it is absent or out of vocabulary. DENY-UNKNOWN and TOTAL:
 * any input resolves to a valid intent, so the runtime can read a raw column value without a throw and
 * without ever adopting an intent the migration would reject.
 */
export function coerceConversationIntent(value: unknown): ConversationIntent {
  return isConversationIntent(value) ? value : INITIAL_CONVERSATION_INTENT;
}

// ---------------------------------------------------------------------
// Resolution — deterministic, conservative, model-free. It classifies the CUSTOMER's latest turn.
// ---------------------------------------------------------------------

/**
 * Explicit "I want a human" cues → {@link human_handoff}. Recognising that a customer wants to leave
 * the AI conversation is the STRONGEST signal — it changes who should own the exchange — so it is
 * evaluated FIRST and overrides every other cue. High-precision by design: a bare "someone" is not a
 * handoff; only an explicit request to reach a person / manager / complaint is.
 */
const HANDOFF_CUES: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "speak_to_person",
    /\b(?:speak|talk|chat)\s+(?:to|with)\s+(?:a\s+|an\s+|the\s+)?(?:real\s+|actual\s+|human\s+)?(?:human|person|someone|somebody|agent|adviser|advisor|representative|rep|manager|supervisor|owner)\b/i,
  ],
  ["real_person", /\b(?:real|actual|live|human)\s+(?:human|person|people|being|agent)\b/i],
  [
    "get_me_a_human",
    /\b(?:get|put)\s+me\s+(?:through\s+)?(?:to|onto)\s+(?:a\s+)?(?:human|person|someone|manager|agent)\b/i,
  ],
  ["manager", /\b(?:your|a|the)\s+manager\b/i],
  ["complaint", /\bcomplain(?:t|ts|ing|ed)?\b/i],
];

/** Explicit price / quote cues → {@link quote_request}. Evaluated AFTER booking so "how much to come
 *  out Tuesday?" is the appointment it primarily is, not a bare price question. */
const QUOTE_CUES: ReadonlyArray<readonly [string, RegExp]> = [
  ["quote", /\bquot(?:e|es|ing|ation|ations)\b/i],
  ["estimate", /\bestimat(?:e|es|ing|ion)\b/i],
  ["how_much", /\bhow\s+much\b/i],
  ["price", /\bpric(?:e|es|ing)\b/i],
  ["cost", /\bcosts?\b/i],
  ["ballpark", /\bballpark\b/i],
  ["charge", /\bcharges?\b/i],
];

/**
 * Classify a single customer message into a {@link ConversationIntent}. DETERMINISTIC and TOTAL — the
 * same text always yields the same intent — with a fixed precedence:
 *   1. empty / whitespace                     → `unknown`      (no signal at all);
 *   2. an explicit human-handoff cue          → `human_handoff` (overrides everything below);
 *   3. a booking signal (REUSING the R2 {@link detectBookingIntent}) → `callback_request` |
 *      `booking_interest` (callback precedence is inherited from the detector);
 *   4. an explicit price / quote cue          → `quote_request`;
 *   5. any other substantive message          → `general_enquiry`.
 * Module-private: {@link resolveIntent} is the ONLY exported resolver, so intent is resolved in exactly
 * one place and no feature can classify text independently.
 */
function classifyIntentSignal(text: string | null | undefined): ConversationIntent {
  const raw = (text ?? "").trim();
  if (!raw) return INITIAL_CONVERSATION_INTENT;

  // 1. A human-handoff request is the strongest signal — the customer wants OUT of the AI exchange.
  if (HANDOFF_CUES.some(([, re]) => re.test(raw))) return "human_handoff";

  // 2. Booking / callback — REUSE the canonical R2 booking detector (the single booking-recognition
  //    authority). We RECOGNISE the intent as a label; we never ACT on it (booking is an R18 non-goal).
  const booking = detectBookingIntent(raw);
  if (booking) return booking.kind === "callback" ? "callback_request" : "booking_interest";

  // 3. Price / quote enquiry.
  if (QUOTE_CUES.some(([, re]) => re.test(raw))) return "quote_request";

  // 4. A substantive message with no specialised signal is a general enquiry.
  return "general_enquiry";
}

/** The latest CUSTOMER turn's text in an assembled context, or null when there is none (an empty
 *  context, or a context whose retained turns are all `assistant`). Scans newest → oldest. */
function latestCustomerText(context: ConversationContext | null): string | null {
  if (!context) return null;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i]!;
    if (message.role === "customer") return message.text;
  }
  return null;
}

/**
 * Resolve the CURRENT conversational intent from the canonical R12/R16 conversation context. It reads
 * the customer's LATEST turn and classifies it. DETERMINISTIC, TOTAL and MODEL-FREE — the same context
 * always resolves the same intent — returning {@link INITIAL_CONVERSATION_INTENT} when there is no
 * customer signal (a null context, or no customer turn, or an empty message). THE single exported
 * resolver: every consumer resolves intent through this function and no other way, so the engine is the
 * single source of truth for conversational intent.
 */
export function resolveIntent(context: ConversationContext | null): ConversationIntent {
  return classifyIntentSignal(latestCustomerText(context));
}

// =====================================================================
// THE INTENT PROGRESSION MODEL (CEO Directive #018, R18).
//
// Resolution answers "what is the current intent?"; progression governs "how may intent MOVE?". It is
// the faithful analogue of the R17 conversation state machine: an explicit legal-edge relation, a total
// validator, and a planner that classifies every transition as an `advance` (a validated change to
// persist), an `unchanged` self-loop (nothing to persist), or a `rejected` illegal edge (refused, never
// persisted). Its ONE law is MONOTONIC KNOWLEDGE — a concrete intent never regresses to `unknown`,
// exactly as the state machine never regresses to `awaiting_ai`. The relation is EXACTLY the image of
// the turn fold {@link advanceIntent}, so it permits every progression a turn actually makes and
// nothing more.
// =====================================================================

/**
 * The legal directed edges of the intent engine: for each intent, the intents a single governed
 * transition may advance INTO. From `unknown`, a turn may learn ANY intent (or stay unknown). From a
 * CONCRETE intent, a turn may move to any concrete intent (itself included) but NEVER back to `unknown`
 * — knowledge is monotonic. This is exactly the IMAGE of {@link advanceIntent} over every resolved
 * intent, so it permits every progression a turn actually makes and NOTHING more. The SINGLE SOURCE of
 * the transition graph on the TypeScript side.
 */
export const INTENT_TRANSITIONS: Readonly<
  Record<ConversationIntent, readonly ConversationIntent[]>
> = {
  // Nothing is known yet → a turn may resolve to any intent, or leave it unknown (a content-free turn).
  unknown: CONVERSATION_INTENTS,
  // A concrete intent is known → a turn re-resolves to any concrete intent; it never un-knows it.
  general_enquiry: CONCRETE_INTENTS,
  booking_interest: CONCRETE_INTENTS,
  callback_request: CONCRETE_INTENTS,
  quote_request: CONCRETE_INTENTS,
  human_handoff: CONCRETE_INTENTS,
};

/**
 * Whether `from → to` is a declared legal edge of the intent engine. TOTAL and DETERMINISTIC over the
 * whole intent × intent space. This is the governing authority the runtime consults before it PERSISTS
 * any intent progression: an edge the relation does not contain is REJECTED and never written.
 * Reflexive edges (`to === from`) are legal for every intent — an idle self-loop never un-knows its
 * intent — because each intent lists itself among its targets.
 */
export function isValidIntentTransition(
  from: ConversationIntent,
  to: ConversationIntent,
): boolean {
  return INTENT_TRANSITIONS[from].includes(to);
}

/**
 * A governed intent transition the runtime executes, discriminated on `kind`:
 *   • advance   — a validated change (`from` ≠ `to`, a declared legal edge); the runtime PERSISTS `to`.
 *   • unchanged — a self-loop (`to` === `from`); intent does not move, so nothing is persisted.
 *   • rejected  — an edge OUTSIDE the declared relation (a `concrete → unknown` regression); the engine
 *                 REFUSES it (never persisted) and the runtime records it as a governance event.
 * So the runtime persists exactly the `advance` case and can never write an ungoverned progression.
 */
export type IntentTransitionPlan =
  | { kind: "advance"; from: ConversationIntent; to: ConversationIntent }
  | { kind: "unchanged"; intent: ConversationIntent }
  | { kind: "rejected"; from: ConversationIntent; to: ConversationIntent; reason: string };

/**
 * Plan a `from → to` intent transition through the engine: a self-loop is `unchanged`, a declared legal
 * edge is an `advance` to persist, and any other edge (only a `concrete → unknown` regression is
 * possible) is `rejected`. TOTAL and DETERMINISTIC — every (from, to) pair resolves to exactly one
 * plan. THE validation gate every persisted progression passes: an illegal edge is refused here and
 * never reaches the writer.
 */
export function planIntentTransition(
  from: ConversationIntent,
  to: ConversationIntent,
): IntentTransitionPlan {
  if (to === from) return { kind: "unchanged", intent: from };
  if (isValidIntentTransition(from, to)) return { kind: "advance", from, to };
  return {
    kind: "rejected",
    from,
    to,
    reason: `illegal intent transition ${from} → ${to} (not a declared edge of the intent engine)`,
  };
}

/**
 * Fold a freshly-resolved intent onto the prior intent — the intent analogue of the R15
 * `advanceConversationState` fold. TOTAL: adopt the resolved intent, EXCEPT when the turn resolved no
 * signal (`unknown`), in which case KEEP the prior intent. This is what makes progression monotonic: a
 * content-free turn never drags a known concrete intent back to `unknown`. DETERMINISTIC — the same
 * (prior, resolved) always yields the same next intent — so a conversation's intent is a pure fold over
 * its ordered per-turn resolutions.
 */
export function advanceIntent(
  prior: ConversationIntent,
  resolved: ConversationIntent,
): ConversationIntent {
  return resolved === INITIAL_CONVERSATION_INTENT ? prior : resolved;
}

/**
 * Plan the progression a TURN drives: fold the resolved intent onto the prior via {@link advanceIntent},
 * then VALIDATE that (prior → target) edge through the engine. Because the fold's image is exactly the
 * legal-edge relation, a real turn ALWAYS yields an `advance` or an `unchanged` and NEVER a `rejected`
 * — a proven safety property — yet the validation still gates the persist, so the engine is the single
 * authority over every intent progression. This is the one entry point the runtime calls to govern a
 * turn's intent advance, given the intent it resolved from the context.
 */
export function planIntentProgression(
  prior: ConversationIntent,
  resolved: ConversationIntent,
): IntentTransitionPlan {
  return planIntentTransition(prior, advanceIntent(prior, resolved));
}
