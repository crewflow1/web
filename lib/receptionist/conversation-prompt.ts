// =====================================================================
// THE CONVERSATION PROMPT PLANNER — PURE CORE (CEO Directive #018; R23: CONVERSATION PROMPT PLANNER).
//
// R15 gave the runtime a coarse OWNERSHIP marker; R17 wrapped it in a formal STATE MACHINE ("which party
// owes the next turn"); R18 added the INTENT ENGINE ("what does the customer WANT?"); R19 added the GOAL
// ENGINE ("what is the conversation trying to ACCOMPLISH?"); R20 added the INFORMATION ENGINE ("what
// STRUCTURED FACTS has the customer PROVIDED?"); R21 added the GAP ENGINE ("given the objective and the
// facts we hold, WHAT IS STILL MISSING?"); R22 added the STRATEGY ENGINE ("given the gap, HOW SHOULD THE
// CONVERSATION PROGRESS — what is the next conversational ACTION?"). R23 is the next layer UP — the single,
// canonical authority over a SEVENTH question, one DERIVED from the layer beneath it: "given the chosen
// strategy, WHAT IS THE NEXT CONVERSATIONAL PROMPT — what conversational ACT to perform, what field (if any)
// it targets, and what it should FOCUS on?" — the conversational PROMPT PLAN. It is the receptionist's
// UTTERANCE-PLANNING layer: it turns the strategy DECISION (R22) into a planned next PROMPT. Slot filling is
// the FIRST planner expressed here — an `ask` act naming the one field to request — but it is just one member
// of the prompt-act vocabulary, not the engine's purpose.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING. Like the R21 gap and the R22 strategy, the prompt
// plan is the THIRD purely-DERIVED layer of the stack that adds NO column and NO migration. The plan is a
// TOTAL, DETERMINISTIC function of a SINGLE already-DERIVED observation — the {@link StrategyDecision} (R22),
// which is itself a pure projection of the R21 gap, which is a pure projection of the persisted goal (R19) +
// information (R20). Persisting the plan would create a source of truth that could drift from the decision it
// derives from; instead the plan is COMPUTED wherever it is needed (surfaced on the runtime turn result;
// re-derived on every read of the read model) and never stored. Goal + information remain the ONLY persisted
// conversational state; the gap, the strategy and the prompt plan are always fresh projections of them, so
// none can ever be stale.
//
// IT PLANS, IT NEVER ACTS — AND IT NEVER WRITES THE WORDS. Determining that the next prompt is "greet the
// customer", "ask for the postcode", "answer the enquiry", "hand off to a human" or "proceed with the objective"
// is a pure CHOICE over what the decision reports — a planning DECISION. Composing the actual prose,
// generating the draft with the model, routing to a human, booking, scheduling, CRM writes and every side
// effect are EXPLICIT R23 NON-GOALS this engine does not perform: it names the next prompt's ACT, its TARGET
// and its FOCUS, and stops. GENERATING the utterance — the model drafting the reply downstream — and
// EXECUTING any business action are future/existing capabilities that CONSUME this plan; the planner produces
// a deterministic planning DIRECTIVE (never customer-facing prose) that guides the draft, and it never
// executes a business action. Slot filling is the first CONSUMER as much as the first planner: a future
// capability reads an `ask` plan and its target field to know which slot to request next, but the request
// itself, and every business action, lives OUTSIDE this engine.
//
// IT REUSES THE R22 STRATEGY DECISION — IT FORKS NO STRATEGY LOGIC. The questions "what is the next action?",
// "what does it target?", "does it expect a reply?" are answered by the R22 strategy engine
// ({@link StrategyDecision} — its `strategy`, `target`, `expectsReply`). This engine IMPORTS that derived view
// and re-implements NONE of it: it re-runs no priority ordering, re-selects no strategy, never calls the
// strategy resolver, and never touches the R21 gap surface or the R20 slot surface directly — it reads the
// decision the R22 engine already computed and adds only the utterance-planning SEMANTICS that sit on top: a
// strategy → conversational-ACT mapping ({@link STRATEGY_ACT}), the field a prompt TARGETS, and the FOCUS it
// should carry. So there is exactly ONE definition of "what to DO" (R22) and exactly ONE definition of "what
// to ASK or SAY next" (R23) — no feature computes either independently.
//
// IT DUPLICATES NOTHING BENEATH IT. It consumes an ALREADY-derived decision; it NEVER re-assembles context,
// re-classifies intent, re-resolves goal, re-extracts information, re-detects the gap, or re-resolves the
// strategy — it names none of those resolvers, planners, extractors, the gap detector or the strategy
// resolver. Its only imports are the R22 strategy TYPES ({@link ConversationStrategy} + {@link StrategyDecision},
// from which it maps the act and reads the decision) and the R20 information-field TYPE ({@link InformationField},
// which types what an `ask` prompt targets); ALL are type-only, so this module names NO runtime value from any
// other layer. It reaches NO policy, NO provider, NO ledger, NO DB, NO clock, NO RNG and — the cardinal rule
// shared with the whole stack — NO MODEL: the plan is chosen by named, total, deterministic mapping tables, so
// the same decision always yields the same plan and the derivation is reconstructable from source. The
// layering stays a clean, linear stack: Context → Intent → Goal → Information → Gap → Strategy → Prompt.
// =====================================================================

import type { InformationField } from "@/lib/receptionist/conversation-information";
import type {
  ConversationStrategy,
  StrategyDecision,
} from "@/lib/receptionist/conversation-strategy";

// ---------------------------------------------------------------------
// The PROMPT ACT vocabulary — the closed set of next conversational acts.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of conversational PROMPT ACTS — the FIVE kinds of next utterance the receptionist can
 * plan on a turn, deliberately DISJOINT from BOTH the R22 strategy vocabulary AND the R19 goal vocabulary (a
 * prompt act is a planned UTTERANCE, distinct from the strategic MOVE that selects it and the OBJECTIVE it
 * serves):
 *   • greet   — open the conversation / receive the customer (plans the acknowledge move's utterance).
 *   • ask     — request the single highest-priority missing field (plans the request_information move's
 *               utterance). THE slot-filling act — the one act that TARGETS a specific field.
 *   • answer  — answer the customer's enquiry directly (plans the provide_answer move's utterance).
 *   • handoff — tell the customer a human colleague will take over (plans the escalate_to_human move's
 *               utterance).
 *   • proceed — confirm what has been gathered and carry the objective forward (plans the progress_goal
 *               move's utterance).
 * A closed union: every {@link planPrompt} plan names one of these, so a consumer can switch exhaustively.
 * The names are deliberately chosen to NOT collide with any strategy or goal literal (e.g. `handoff` ≠
 * `handoff_to_human`, `answer` ≠ `provide_answer` / `answer_enquiry`, `proceed` ≠ the strategy `progress_goal`
 * and the goal-transition kind `advance`), so the vocabularies stay independent.
 */
export type PromptAct = "greet" | "ask" | "answer" | "handoff" | "proceed";

/**
 * The prompt-act vocabulary as an ordered, frozen list — the single enumerable source of the {@link PromptAct}
 * members (the type is compile-time only). Ordered to mirror the strategy priority the acts derive from
 * (greet ← acknowledge, ask ← request_information, answer ← provide_answer, handoff ← escalate_to_human,
 * proceed ← progress_goal). The unit + security tiers pin that it is EXACT — a permutation of the whole
 * {@link PromptAct} union with no missing act, no duplicate and no out-of-vocabulary entry.
 */
export const PROMPT_ACTS = [
  "greet",
  "ask",
  "answer",
  "handoff",
  "proceed",
] as const satisfies readonly PromptAct[];

// ---------------------------------------------------------------------
// The MAPPING tables — strategy → act, field → focus directive, act → focus directive. Named, total,
// deterministic; each is a compile-time-exhaustive `Record`, so a new member of a source vocabulary cannot
// be added without also binding its mapping here.
// ---------------------------------------------------------------------

/**
 * The canonical R22-strategy → R23-act binding — the ONE place a strategy becomes a planned act, defined
 * ONCE here. TOTAL over the whole {@link ConversationStrategy} vocabulary — the `Record` type makes the
 * exhaustiveness a COMPILE-TIME guarantee (a missing or out-of-vocabulary strategy fails `tsc`), so this
 * mapping and the strategy vocabulary can never drift. Keys are the strategy STRING LITERALS (the map is
 * indexed by `decision.strategy`), the analogue of how R22 keyed its rules off `gap.goal` by literal — so the
 * planner adds no runtime dependency on the strategy engine beyond the type it already imports.
 */
const STRATEGY_ACT = {
  acknowledge: "greet",
  request_information: "ask",
  provide_answer: "answer",
  escalate_to_human: "handoff",
  progress_goal: "proceed",
} as const satisfies Record<ConversationStrategy, PromptAct>;

/**
 * The per-field FOCUS directive for an `ask` prompt — a deterministic, model-free planning instruction naming
 * WHAT the receptionist should request for each {@link InformationField}. NOT customer-facing prose: it is the
 * canonical directive the downstream draft generator focuses the prompt on (the model still composes the
 * actual words). TOTAL over the whole information-field vocabulary — the `Record` type makes the
 * exhaustiveness a COMPILE-TIME guarantee, so a new field cannot be added without also giving it a focus. This
 * is the slot-filling directive surface: an `ask` plan carries the directive for the ONE field the R22
 * decision targeted.
 */
const FIELD_FOCUS = {
  job_type: "the type of work the customer needs carried out",
  postcode: "the postcode where the work is needed",
  phone_number: "the best phone number to reach the customer on",
  email_address: "the email address to send written details to",
} as const satisfies Record<InformationField, string>;

/**
 * The per-act FOCUS directive for a NON-targeted prompt — a deterministic, model-free planning instruction for
 * every act that does not name a specific field. NOT customer-facing prose: it is the canonical directive the
 * downstream draft generator focuses the prompt on. TOTAL over the whole {@link PromptAct} vocabulary — the
 * `Record` type makes the exhaustiveness a COMPILE-TIME guarantee. The `ask` entry is a DEFENSIVE fallback
 * only: an `ask` plan normally carries a {@link FIELD_FOCUS} directive for its target field, and reaches this
 * generic directive solely in the (type-unreachable) case of an `ask` with no target.
 */
const ACT_FOCUS = {
  greet: "welcome the customer and invite them to explain what they need",
  ask: "the information still needed to proceed",
  answer: "answer the customer's enquiry directly",
  handoff: "let the customer know a human colleague will take over",
  proceed: "confirm the details gathered and move the objective forward",
} as const satisfies Record<PromptAct, string>;

// ---------------------------------------------------------------------
// The PROMPT PLAN model — the derived next-prompt view for a strategy decision.
// ---------------------------------------------------------------------

/**
 * The conversational PROMPT PLAN for one strategy decision — the DERIVED next-prompt view a future capability
 * reads:
 *   • act          — the planned conversational act (the {@link PromptAct} the decision's strategy maps to).
 *   • field        — the single {@link InformationField} the prompt targets, or null. Non-null ONLY for an
 *                    `ask` plan (slot filling), where it is the decision's `target` field (the one slot to
 *                    request next); null for every other act, which targets no specific field.
 *   • focus        — the deterministic, model-free planning DIRECTIVE for the prompt: the field's directive
 *                    for a targeted `ask`, else the act's generic directive. NOT customer-facing prose — it
 *                    tells the downstream draft generator what to focus the utterance on; the model composes
 *                    the actual words.
 *   • expectsReply — whether the prompt expects a customer REPLY in return, carried verbatim from the R22
 *                    decision (true for `greet` / `ask`, false for the forward acts). A pure OBSERVATION about
 *                    the planned prompt — it does NOT gate the runtime (the turn still generates its reply);
 *                    it tells a future capability whether this prompt solicits another customer turn.
 * Every field is a total, deterministic function of the decision; the whole object is derived, never persisted.
 */
export type ConversationPromptPlan = {
  act: PromptAct;
  field: InformationField | null;
  focus: string;
  expectsReply: boolean;
};

/**
 * Plan the next conversational PROMPT for a strategy decision — THE single entry point the runtime and the
 * read model call. Maps the decision's strategy to its conversational act ({@link STRATEGY_ACT}), targets the
 * decision's field for an `ask` (else no field), selects the FOCUS directive (the field's directive for a
 * targeted `ask`, else the act's generic directive), and carries the decision's `expectsReply` verbatim. Pure,
 * TOTAL over any decision, and DETERMINISTIC — the same decision always yields the same plan. Persists NOTHING:
 * the plan is a fresh projection of the derived decision, never a stored observation. THE single source of
 * truth for conversational prompt planning — every consumer derives the next prompt through this function and
 * no other way; no feature implements independent prompt-planning logic. It PLANS the prompt only; generating
 * the utterance and executing any business action live OUTSIDE this engine.
 */
export function planPrompt(decision: StrategyDecision): ConversationPromptPlan {
  const act = STRATEGY_ACT[decision.strategy];
  const field = act === "ask" ? decision.target : null;
  const focus = field !== null ? FIELD_FOCUS[field] : ACT_FOCUS[act];
  return { act, field, focus, expectsReply: decision.expectsReply };
}
