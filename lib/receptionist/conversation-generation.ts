// =====================================================================
// THE CONVERSATION GENERATION ENGINE — PURE CORE (CEO Directive #018; R25: CONVERSATION GENERATION ENGINE).
//
// The conversation stack derives, in a clean linear order, EIGHT questions before a single word is written:
// Context (R12/R16) → State (R17) → Intent (R18) → Goal (R19) → Information (R20) → Gap (R21) → Strategy
// (R22) → Prompt (R23) → Response (R24). R24 is the last DERIVED leaf: it PREPARES a model-ready RESPONSE
// SPECIFICATION — the response OBJECTIVE, the field it SOLICITS, a model-ready DIRECTIVE and the GUARDRAILS the
// produced response must honour — and STOPS, deliberately WITHOUT producing a single word. R25 is the layer that
// finally PRODUCES the words: it is the canonical architectural capability responsible for CONVERSATIONAL
// LANGUAGE GENERATION — the single authority that CONVERTS a {@link ResponseSpecification} (R24), grounded in the
// canonical {@link ConversationContext} (R12), into a draft response. Every prior layer decided WHAT to say and
// HOW to shape it; this engine turns that decision into language. The receptionist reply draft is the FIRST
// IMPLEMENTATION produced THROUGH this engine (server/services/receptionist-draft.ts), not the engine's purpose:
// booking confirmations, scheduling prompts, CRM-update messages, customer-support replies, voice and every
// future multi-channel utterance must ALSO generate their language through this one engine — no feature may
// implement independent language-generation logic.
//
// THIS MODULE IS THE ENGINE'S PURE CORE — IT DEFINES THE MODEL, IT CONSUMES THE SPEC, IT NEVER REACHES A MODEL.
// It owns three things and no more: (1) the canonical GENERATION MODEL — the {@link GenerationRequest} a caller
// submits, the {@link GenerationInstruction} the model is driven by, the {@link GeneratedResponse} it yields, and
// the {@link GenerationEngine} INTERFACE every implementation satisfies; (2) the RESPONSE-SPECIFICATION
// CONSUMPTION — {@link prepareGenerationInstruction}, the ONE place an R24 spec becomes a model-ready instruction;
// and (3) the deterministic FALLBACK shaping — {@link fallbackResponse}, the model-free draft every
// implementation degrades to. It is a PURE, client/server-safe module in the exact discipline of R12's context
// assembler, R13's prompt builder and R24's response engine: NO I/O, NO clock (the model latency the server
// records is the server implementation's concern, never this core's), NO RNG, and — the cardinal rule of the
// whole stack — NO MODEL. It calls no LLM, imports no vendor SDK, reads no database and mutates nothing. Reaching
// the model is the SERVER engine's job (server/services/receptionist-generation.ts); this core only PREPARES what
// that reach is driven by and SHAPES what it degrades to.
//
// IT REUSES R13's PROMPT BUILDER — IT FORKS NO PROMPT LOGIC. The two-part prompt (`system` safety framing +
// `user` transcript ask) a language model drafts a receptionist reply from was single-sourced by R13
// ({@link buildReplyPrompt} + {@link REPLY_DRAFT_SYSTEM_PROMPT}). This engine IMPORTS that builder and
// re-implements NONE of it: {@link prepareGenerationInstruction} calls it to obtain the canonical prompt, leaves
// the fixed system framing UNTOUCHED (so a conversation can never steer the safety rules — the R13 injection
// invariant is preserved verbatim), and adds ONLY the R24 spec's model-ready guidance to the USER channel. When
// there is NO spec (a spec-less caller), the prepared instruction is BYTE-IDENTICAL to R13's prompt — so the
// engine subsumes the pre-R25 draft path without changing one byte of its behaviour. The deterministic fallback
// is likewise R4's acknowledgement ({@link composeReceptionistReply}), reused, never re-composed.
//
// IT PRODUCES DRAFTS ONLY — IT NEVER EXECUTES A BUSINESS ACTION. Preparing the instruction, shaping the fallback
// and (in the server engine) reaching the model are the whole of it. Enforcing the policy, writing the audit,
// transporting the reply, booking, scheduling, CRM writes and every side effect are EXPLICIT R25 NON-GOALS this
// engine does not perform: it converts a spec into a draft, and stops. The draft it yields is UNTRUSTED model
// output — the load-bearing guarantee is downstream and unchanged: every draft still flows through the canonical
// Enforce → Audit → (deny-by-default) → Transport pipeline before it could ever reach a customer. This engine
// composes language; it enforces nothing.
// =====================================================================

import { buildReplyPrompt, DEFAULT_REPLY_DRAFT_MAX_TOKENS } from "@/lib/receptionist/draft";
import { composeReceptionistReply } from "@/lib/receptionist/reply";
import type { ConversationContext } from "@/lib/receptionist/conversation-context";
import type { InboundChannel } from "@/lib/receptionist/types";
import type { ResponseSpecification } from "@/lib/receptionist/conversation-response";

// ---------------------------------------------------------------------
// The PROVENANCE vocabulary — the closed set of labels a generated draft is tagged with.
// ---------------------------------------------------------------------

/**
 * The label recorded on a draft the model generated (the conversation-aware path). Owned here — the engine
 * is the single authority over language generation, so the provenance vocabulary that names HOW a draft was
 * produced is the engine's, re-exported by every implementation for its consumers.
 */
export const MODEL_PRODUCER = "conversation_aware_reply";

/**
 * The label recorded on a draft the deterministic fallback produced. Kept identical to the pre-R13
 * acknowledgement producer so the fallback is, in provenance too, exactly the reply R4 shipped — the
 * `fallback_reason` field names WHY the fallback ran.
 */
export const FALLBACK_PRODUCER = "deterministic_acknowledgement";

/**
 * The bounded sampling temperature every generation is driven at — 0, for reproducible determinism at the
 * model edge (a pinned model + temperature 0; ADR 0002). Carried on the {@link GenerationInstruction} so the
 * bound is decided ONCE here and honoured by every implementation, never re-chosen at a call site.
 */
export const GENERATION_TEMPERATURE = 0;

// ---------------------------------------------------------------------
// The GENERATION MODEL — the canonical request, instruction, result and interface.
// ---------------------------------------------------------------------

/**
 * The canonical INPUT to conversational language generation — what any capability submits to the engine to
 * obtain a draft. It names the org the draft is generated on behalf of, the channel it answers, the
 * conversation to reason over, the canonical R12 context (already assembled by the caller, or null ⇒ the
 * deterministic fallback), the R24 response specification that guides HOW the draft is shaped (or null ⇒ a
 * spec-less draft, byte-identical to the pre-R25 path), and the optional output-token ceiling. Every
 * implementation — the receptionist reply draft first, future capabilities next — submits THIS shape.
 */
export type GenerationRequest = {
  /** The organisation the draft is generated on behalf of (org-scopes the R12 context fetch). */
  org_id: string;
  /** The channel the generated language answers — selects the deterministic fallback's phrasing. */
  channel: InboundChannel;
  /** The conversation to reason over. Null (no contact ⇒ no thread) ⇒ deterministic fallback. */
  conversation_id: string | null;
  /**
   * The canonical R12 context, ALREADY ASSEMBLED by the caller (R16). The runtime assembles it ONCE per turn
   * and threads it in, so the engine consumes it verbatim; a standalone caller may leave it null and the server
   * engine performs its own org-scoped fetch. Null after that fetch ⇒ deterministic fallback.
   */
  context: ConversationContext | null;
  /**
   * The R24 RESPONSE SPECIFICATION guiding this generation — the response objective, the model-ready directive
   * and the guardrails the draft must honour. Non-null on the runtime path (the runtime derives it every turn);
   * null for a spec-less caller, which yields exactly the pre-R25 prompt. It GUIDES the draft; it never steers
   * the fixed safety framing.
   */
  spec: ResponseSpecification | null;
  /** The output-token ceiling; defaults to {@link DEFAULT_REPLY_DRAFT_MAX_TOKENS}. */
  max_tokens?: number;
};

/**
 * The model-ready INSTRUCTION a language model is driven by — the deterministic product of consuming a
 * {@link GenerationRequest}'s context + spec. The `system` half is R13's fixed safety framing, VERBATIM (never
 * steerable by conversation content); the `user` half is R13's transcript ask plus, when a spec is present, the
 * spec's model-ready response guidance. `temperature` and `max_tokens` carry the bounded edge. NOT
 * customer-facing prose — the model still composes the actual words from this instruction.
 */
export type GenerationInstruction = {
  /** The fixed R13 safety framing, applied as the model's system channel — unaltered by any conversation content. */
  system: string;
  /** The transcript ask (R13), plus the R24 spec's response guidance when a spec guides this generation. */
  user: string;
  /** The bounded sampling temperature ({@link GENERATION_TEMPERATURE}). */
  temperature: number;
  /** The output-token ceiling honoured at the model edge. */
  max_tokens: number;
};

/**
 * One generated draft plus its provenance — the canonical OUTPUT of the engine, folded into audit metadata by
 * the pipeline. `fallback_reason` is null on the generated path and names the cause on the deterministic path,
 * so every draft is explainable; the cost/token/latency accounting is the provider's authoritative truth (0 /
 * null on the deterministic path).
 */
export type GeneratedResponse = {
  /** The draft text to enforce and audit — a model generation, or the deterministic acknowledgement. */
  draft: string;
  /** The path that produced the draft: {@link MODEL_PRODUCER} or {@link FALLBACK_PRODUCER}. */
  producer: string;
  /** The model that generated the draft, or null on the deterministic path. */
  model: string | null;
  /** Billed input tokens (0 on the deterministic path). */
  input_tokens: number;
  /** Billed output tokens (0 on the deterministic path). */
  output_tokens: number;
  /** The measured cost in USD, or null when unknown / on the deterministic path. */
  cost_usd: number | null;
  /** The model latency in ms, or null on the deterministic path. */
  latency_ms: number | null;
  /** Why the deterministic fallback ran, or null when the model generated the draft. */
  fallback_reason: string | null;
};

/**
 * The GENERATION INTERFACE — the single contract every language-generation implementation satisfies: a total,
 * async function from a {@link GenerationRequest} to a {@link GeneratedResponse}, degrading to the deterministic
 * fallback rather than throwing. The receptionist reply draft is the first implementation of this interface;
 * future capabilities implement the SAME contract, so "generate conversational language" means exactly one thing
 * across the system.
 */
export type GenerationEngine = (request: GenerationRequest) => Promise<GeneratedResponse>;

// ---------------------------------------------------------------------
// The RESPONSE-SPECIFICATION CONSUMPTION — the ONE place a spec becomes a model instruction.
// ---------------------------------------------------------------------

/**
 * Render the R24 response specification as deterministic, model-ready GUIDANCE for the user channel — the
 * response objective, the spec's directive, and the guardrails the draft must honour. NOT customer-facing prose:
 * it tells the model HOW to shape the reply, mirroring the directive the R24 engine prepared. Deterministic — the
 * same spec always renders the same guidance.
 */
function renderResponseGuidance(spec: ResponseSpecification): string {
  const guardrails = spec.guardrails.join(", ");
  return [
    `Response guidance (objective: ${spec.objective}):`,
    spec.directive,
    `Honour these response guardrails: ${guardrails}.`,
  ].join("\n");
}

/**
 * Consume a {@link ResponseSpecification} + the canonical {@link ConversationContext} into the model-ready
 * {@link GenerationInstruction} — THE single place an R24 spec becomes a language-generation instruction. REUSES
 * R13's {@link buildReplyPrompt} to obtain the canonical two-part prompt (it forks no prompt logic), leaves the
 * fixed `system` framing UNTOUCHED (a conversation can never steer the safety rules), and — ONLY when a spec
 * guides this generation — appends the spec's response guidance to the `user` channel. With NO spec the
 * instruction's prompt is BYTE-IDENTICAL to R13's, so a spec-less caller generates exactly as it did pre-R25.
 * PURE and DETERMINISTIC: the same context + spec always yields the same instruction. Reaches no model.
 */
export function prepareGenerationInstruction(
  context: ConversationContext,
  spec: ResponseSpecification | null,
  maxTokens: number = DEFAULT_REPLY_DRAFT_MAX_TOKENS,
): GenerationInstruction {
  const prompt = buildReplyPrompt(context);
  const user =
    spec === null ? prompt.user : `${prompt.user}\n\n${renderResponseGuidance(spec)}`;
  return {
    system: prompt.system,
    user,
    temperature: GENERATION_TEMPERATURE,
    max_tokens: maxTokens,
  };
}

// ---------------------------------------------------------------------
// The DETERMINISTIC FALLBACK — the model-free draft every implementation degrades to.
// ---------------------------------------------------------------------

/**
 * Shape the deterministic, model-free {@link GeneratedResponse} — the exact acknowledgement R4 shipped
 * ({@link composeReceptionistReply}), always available and always reproducible, tagged with the pre-R13
 * {@link FALLBACK_PRODUCER} label and the `reason` the model path did not run. Every generation implementation
 * degrades to THIS one shaping (no provider, no conversation, no context, a model throw or an empty generation),
 * so the fallback draft is, in text AND provenance, byte-for-byte the pre-R13 reply — reproducible end to end in
 * CI, where no model is configured. A total function; it reaches no model and touches no I/O.
 */
export function fallbackResponse(
  channel: InboundChannel,
  reason: string,
): GeneratedResponse {
  return {
    draft: composeReceptionistReply({ channel }),
    producer: FALLBACK_PRODUCER,
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: null,
    latency_ms: null,
    fallback_reason: reason,
  };
}
