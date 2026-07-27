// =====================================================================
// THE CONVERSATION RESPONSE ENGINE — PURE CORE (CEO Directive #018; R24: CONVERSATION RESPONSE ENGINE).
//
// R15 gave the runtime a coarse OWNERSHIP marker; R17 wrapped it in a formal STATE MACHINE ("which party owes
// the next turn"); R18 added the INTENT ENGINE ("what does the customer WANT?"); R19 added the GOAL ENGINE
// ("what is the conversation trying to ACCOMPLISH?"); R20 added the INFORMATION ENGINE ("what STRUCTURED FACTS
// has the customer PROVIDED?"); R21 added the GAP ENGINE ("what is still MISSING?"); R22 added the STRATEGY
// ENGINE ("given the gap, HOW SHOULD THE CONVERSATION PROGRESS?"); R23 added the PROMPT PLANNER ("given the
// strategy, WHAT IS THE NEXT CONVERSATIONAL PROMPT — what ACT, what field, what FOCUS?"). R24 is the next layer
// UP — the single, canonical authority over an EIGHTH question, one DERIVED from the layer beneath it: "given
// the planned prompt, HOW SHOULD THE RESPONSE BE PRODUCED — what response OBJECTIVE, what field (if any) it
// SOLICITS, what model-ready DIRECTIVE should guide the draft, and what GUARDRAILS must the produced response
// honour?" — the RESPONSE SPECIFICATION. It is the receptionist's RESPONSE-PREPARATION layer: it turns the
// prompt PLAN (R23) into a model-ready response SPEC. Prompt execution is the FIRST response prepared here — a
// `gather` spec naming the one field to solicit — but it is just one member of the response-objective
// vocabulary, not the engine's purpose.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING. Like the R21 gap, the R22 strategy and the R23 prompt
// plan, the response spec is the FOURTH purely-DERIVED layer of the stack that adds NO column and NO migration.
// The spec is a TOTAL, DETERMINISTIC function of a SINGLE already-DERIVED observation — the
// {@link ConversationPromptPlan} (R23), which is itself a pure projection of the R22 decision, which projects
// the R21 gap, which projects the persisted goal (R19) + information (R20). Persisting the spec would create a
// source of truth that could drift from the plan it derives from; instead the spec is COMPUTED wherever it is
// needed (surfaced on the runtime turn result; re-derived on every read of the read model) and never stored.
// Goal + information remain the ONLY persisted conversational state; the gap, the strategy, the prompt plan and
// the response spec are always fresh projections of them, so none can ever be stale.
//
// IT PREPARES, IT NEVER PRODUCES — AND IT NEVER WRITES THE WORDS. Determining that a response should "welcome",
// "gather the postcode", "inform", "transfer" or "confirm" — with its model-ready directive and its guardrails —
// is a pure CHOICE over what the plan reports — a preparation DECISION. Composing the actual prose, GENERATING
// the draft with the model (R13), routing to a human, booking, scheduling, CRM writes and every side effect are
// EXPLICIT R24 NON-GOALS this engine does not perform: it names the response's OBJECTIVE, what it SOLICITS, its
// DIRECTIVE and its GUARDRAILS, and stops. GENERATING the utterance — the model drafting the reply downstream —
// and EXECUTING any business action are future/existing capabilities that CONSUME this spec; the engine produces
// a deterministic preparation DIRECTIVE (never customer-facing prose) that tells the draft HOW to be produced,
// and it never produces the words nor executes a business action. Prompt execution is the first CONSUMER as much
// as the first preparation: a future capability reads a `gather` spec and its solicited field to know how to
// produce the request, but the production itself, and every business action, lives OUTSIDE this engine.
//
// IT REUSES THE R23 PROMPT PLAN — IT FORKS NO PLANNING LOGIC. The questions "what is the next act?", "what does
// it target?", "what should it focus on?", "does it expect a reply?" are answered by the R23 prompt planner
// ({@link ConversationPromptPlan} — its `act`, `field`, `focus`, `expectsReply`). This engine IMPORTS that
// derived view and re-implements NONE of it: it re-runs no strategy resolution, re-plans no prompt, never calls
// the planner, and never touches the R22 decision surface or the R21 gap surface directly — it reads the plan
// the R23 engine already computed and adds only the response-preparation SEMANTICS that sit on top: an act →
// response-OBJECTIVE mapping ({@link PROMPT_OBJECTIVE}), the field a response SOLICITS, the model-ready DIRECTIVE
// it carries, and the GUARDRAILS it must honour. So there is exactly ONE definition of "what to ASK or SAY next"
// (R23) and exactly ONE definition of "HOW to PRODUCE the response" (R24) — no feature computes either
// independently.
//
// IT DUPLICATES NOTHING BENEATH IT. It consumes an ALREADY-derived plan; it NEVER re-assembles context,
// re-classifies intent, re-resolves goal, re-extracts information, re-detects the gap, re-resolves the strategy
// OR re-plans the prompt — it names none of those resolvers, planners, extractors, the gap detector, the
// strategy resolver or the prompt planner. Its only imports are the R23 prompt TYPES ({@link ConversationPromptPlan}
// + {@link PromptAct}, from which it maps the objective and reads the plan) and the R20 information-field TYPE
// ({@link InformationField}, which types what a `gather` response solicits); ALL are type-only, so this module
// names NO runtime value from any other layer. It reaches NO policy, NO provider, NO ledger, NO DB, NO clock, NO
// RNG and — the cardinal rule shared with the whole stack — NO MODEL: the spec is prepared by named, total,
// deterministic mapping tables, so the same plan always yields the same spec and the derivation is
// reconstructable from source. The layering stays a clean, linear stack: Context → Intent → Goal → Information →
// Gap → Strategy → Prompt → Response.
// =====================================================================

import type { InformationField } from "@/lib/receptionist/conversation-information";
import type {
  ConversationPromptPlan,
  PromptAct,
} from "@/lib/receptionist/conversation-prompt";

// ---------------------------------------------------------------------
// The RESPONSE OBJECTIVE vocabulary — the closed set of response-preparation modes.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of RESPONSE OBJECTIVES — the FIVE ways the receptionist can PREPARE a response on a
 * turn, deliberately DISJOINT from BOTH the R23 prompt-act vocabulary AND every layer beneath it (a response
 * objective is a preparation MODE — how the produced response should be shaped — distinct from the planned ACT
 * that selects it, the strategic MOVE beneath that, and the OBJECTIVE the conversation serves):
 *   • welcome  — prepare an opening response that receives the customer (from the `greet` act).
 *   • gather   — prepare a response that solicits the single highest-priority missing field (from the `ask`
 *               act). THE prompt-execution objective — the one objective that SOLICITS a specific field.
 *   • inform   — prepare a response that answers the customer's enquiry (from the `answer` act).
 *   • transfer — prepare a response that hands the customer to a human colleague (from the `handoff` act).
 *   • confirm  — prepare a response that confirms what has been gathered and carries the objective forward
 *               (from the `proceed` act).
 * A closed union: every {@link buildResponseSpec} spec names one of these, so a consumer can switch
 * exhaustively. The names are deliberately chosen to NOT collide with any prompt-act, strategy or goal literal,
 * so the vocabularies stay independent.
 */
export type ResponseObjective =
  | "welcome"
  | "gather"
  | "inform"
  | "transfer"
  | "confirm";

/**
 * The response-objective vocabulary as an ordered, frozen list — the single enumerable source of the
 * {@link ResponseObjective} members (the type is compile-time only). Ordered to mirror the prompt-act order the
 * objectives derive from (welcome ← greet, gather ← ask, inform ← answer, transfer ← handoff, confirm ←
 * proceed). The unit + security tiers pin that it is EXACT — a permutation of the whole {@link ResponseObjective}
 * union with no missing objective, no duplicate and no out-of-vocabulary entry.
 */
export const RESPONSE_OBJECTIVES = [
  "welcome",
  "gather",
  "inform",
  "transfer",
  "confirm",
] as const satisfies readonly ResponseObjective[];

// ---------------------------------------------------------------------
// The RESPONSE GUARDRAIL vocabulary — the closed set of invariants every produced response must honour.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of RESPONSE GUARDRAILS — the invariants a produced response must honour, carried on the
 * spec so the downstream draft is prepared WITHIN a known safety envelope. They express HOW the response must be
 * produced, never customer-facing prose:
 *   • conversational_only — produce WORDS only; never execute a business action (the cardinal R24 boundary).
 *   • single_reply        — produce exactly ONE conversational reply, not a multi-step plan or a sequence.
 *   • solicit_one_field   — request ONLY the single field the spec solicits; do not over-ask (a `gather` spec).
 *   • no_commitments      — make NO promise a human or the business must honour (a `transfer` / `confirm` spec).
 *   • ground_in_context   — answer ONLY from the assembled conversation context; invent no facts (an `inform`
 *                          spec).
 * A closed union defined ONCE here, deliberately novel (no member collides with any other layer's vocabulary).
 */
export type ResponseGuardrail =
  | "conversational_only"
  | "single_reply"
  | "solicit_one_field"
  | "no_commitments"
  | "ground_in_context";

// ---------------------------------------------------------------------
// The MAPPING tables — act → objective, objective → guardrails. Named, total, deterministic; each is a
// compile-time-exhaustive `Record`, so a new member of a source vocabulary cannot be added without also
// binding its mapping here.
// ---------------------------------------------------------------------

/**
 * The canonical R23-act → R24-objective binding — the ONE place a planned prompt act becomes a response
 * objective, defined ONCE here. TOTAL over the whole {@link PromptAct} vocabulary — the `Record` type makes the
 * exhaustiveness a COMPILE-TIME guarantee (a missing or out-of-vocabulary act fails `tsc`), so this mapping and
 * the prompt-act vocabulary can never drift. Keys are the act STRING LITERALS (the map is indexed by
 * `plan.act`), the analogue of how R23 keyed its acts off `decision.strategy` by literal — so the response
 * engine adds no runtime dependency on the prompt planner beyond the type it already imports.
 */
const PROMPT_OBJECTIVE = {
  greet: "welcome",
  ask: "gather",
  answer: "inform",
  handoff: "transfer",
  proceed: "confirm",
} as const satisfies Record<PromptAct, ResponseObjective>;

/**
 * The per-objective GUARDRAILS a produced response must honour — a deterministic, model-free envelope for each
 * {@link ResponseObjective}. Every objective carries the two UNIVERSAL guardrails (conversational_only,
 * single_reply — the response is always words-only and a single reply), plus the objective-specific one: a
 * `gather` solicits exactly one field, an `inform` grounds in context, and a `transfer` / `confirm` makes no
 * commitments. TOTAL over the whole objective vocabulary — the `Record` type makes the exhaustiveness a
 * COMPILE-TIME guarantee, so a new objective cannot be added without also giving it a guardrail set.
 */
const OBJECTIVE_GUARDRAILS = {
  welcome: ["conversational_only", "single_reply"],
  gather: ["conversational_only", "single_reply", "solicit_one_field"],
  inform: ["conversational_only", "single_reply", "ground_in_context"],
  transfer: ["conversational_only", "single_reply", "no_commitments"],
  confirm: ["conversational_only", "single_reply", "no_commitments"],
} as const satisfies Record<ResponseObjective, readonly ResponseGuardrail[]>;

// ---------------------------------------------------------------------
// The RESPONSE SPECIFICATION model — the derived, model-ready response view for a prompt plan.
// ---------------------------------------------------------------------

/**
 * The RESPONSE SPECIFICATION for one prompt plan — the DERIVED, model-ready view a draft generator (and every
 * future response-producing capability) consumes:
 *   • objective  — the response objective (the {@link ResponseObjective} the plan's act maps to): HOW the
 *                  response should be shaped this turn.
 *   • solicits   — the single {@link InformationField} the response solicits, or null. Non-null ONLY for a
 *                  `gather` spec (prompt execution), where it is the plan's targeted field (the one slot to
 *                  request); null for every other objective, which solicits no specific field.
 *   • directive  — the model-ready preparation DIRECTIVE: a deterministic instruction that tells the downstream
 *                  draft generator HOW to produce the response (the response's purpose, plus whether to expect a
 *                  reply). NOT customer-facing prose — the model still composes the actual words.
 *   • awaitsReply — whether the produced response should invite and await a customer REPLY, carried verbatim
 *                  from the R23 plan's `expectsReply` (true for `welcome` / `gather`, false for the forward
 *                  objectives). A pure OBSERVATION about the prepared response — it does NOT gate the runtime.
 *   • guardrails — the invariant {@link ResponseGuardrail}s the produced response must honour (always
 *                  conversational-only and single-reply, plus the objective-specific guardrail). The safety
 *                  envelope the draft is prepared within.
 * Every field is a total, deterministic function of the plan; the whole object is derived, never persisted.
 */
export type ResponseSpecification = {
  objective: ResponseObjective;
  solicits: InformationField | null;
  directive: string;
  awaitsReply: boolean;
  guardrails: readonly ResponseGuardrail[];
};

/**
 * Compose the model-ready preparation DIRECTIVE for a response — a deterministic instruction that tells the
 * downstream draft generator HOW to produce the reply. Consumes the plan's FOCUS verbatim (it re-derives no
 * focus): a `gather` response (a solicited field) frames the focus as a request ("asks the customer for {the
 * field focus}"); every other response frames it as its purpose ("will {the act focus}"). Appends the
 * reply-expectation clause when the response awaits a customer turn. NOT customer-facing prose.
 */
function composeDirective(
  solicits: InformationField | null,
  focus: string,
  awaitsReply: boolean,
): string {
  const purpose = solicits !== null ? `asks the customer for ${focus}` : `will ${focus}`;
  const base = `Compose a reply that ${purpose}.`;
  return awaitsReply ? `${base} Expect a reply from the customer.` : base;
}

/**
 * Build the model-ready RESPONSE SPECIFICATION for a prompt plan — THE single entry point the runtime and the
 * read model call. Maps the plan's act to its response objective ({@link PROMPT_OBJECTIVE}), carries the plan's
 * targeted field as what the response solicits (non-null only for a `gather`), composes the model-ready
 * directive from the plan's focus and reply expectation ({@link composeDirective}), carries the plan's
 * `expectsReply` verbatim as `awaitsReply`, and attaches the objective's guardrail envelope
 * ({@link OBJECTIVE_GUARDRAILS}). Pure, TOTAL over any plan, and DETERMINISTIC — the same plan always yields the
 * same spec. Persists NOTHING: the spec is a fresh projection of the derived plan, never a stored observation.
 * THE single source of truth for response preparation — every consumer prepares the response through this
 * function and no other way; no feature implements independent response-preparation logic. It PREPARES the
 * response spec only; generating the utterance and executing any business action live OUTSIDE this engine.
 */
export function buildResponseSpec(plan: ConversationPromptPlan): ResponseSpecification {
  const objective = PROMPT_OBJECTIVE[plan.act];
  const solicits = plan.field;
  return {
    objective,
    solicits,
    directive: composeDirective(solicits, plan.focus, plan.expectsReply),
    awaitsReply: plan.expectsReply,
    guardrails: OBJECTIVE_GUARDRAILS[objective],
  };
}
