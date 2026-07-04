import "server-only";
import { getTextProvider, textCostUsd, type TextResult } from "@/lib/ai/text";
import {
  buildReplyPrompt,
  DEFAULT_REPLY_DRAFT_MAX_TOKENS,
} from "@/lib/receptionist/draft";
import { composeReceptionistReply } from "@/lib/receptionist/reply";
import {
  getConversationContext,
  type ConversationContext,
} from "@/server/services/receptionist-conversation-context";
import type { InboundChannel } from "@/lib/receptionist/types";

// =====================================================================
// THE CONVERSATION-AWARE REPLY DRAFT GENERATOR — SERVER SEAM (CEO Directive #018, R13).
//
// R4's pipeline drafted the ONE reply an autonomous receptionist may send with no human behind it:
// a FIXED, deterministic acknowledgement (lib/receptionist/reply.ts::composeReceptionistReply). R13
// replaces that fixed composer with a CONVERSATION-AWARE draft GENERATOR — this seam — WITHOUT
// widening the pipeline by one inch. It generates a draft; it enforces nothing, audits nothing,
// transports nothing. Its single output is a string handed back to the canonical service, which
// runs it through the UNCHANGED Enforce → Audit → (deny-by-default) → Transport chain exactly as it
// ran the fixed acknowledgement.
//
// IT CONSUMES ONLY THE CANONICAL R12 CONTEXT. The only conversation input is fetched through the R12
// server seam getConversationContext — the single, org-scoped, deterministic way to obtain a
// conversation's model-ready context. This generator NEVER reconstructs a conversation (it does not
// touch the R11 read model) and NEVER assembles context (it does not call the R12 assembler
// directly). It folds what R12 produced, no more.
//
// IT REACHES THE MODEL ONLY THROUGH THE EXISTING ABSTRACTION. The one door to a language model is
// getTextProvider() from lib/ai/text (Directive 009) — no vendor SDK is imported here. The edge is
// BOUNDED, not trusted: temperature 0, a pinned model, a capped output, and cost recorded. This is
// the exact idiom of server/services/hq-drafts.ts::buildDraft.
//
// IT ALWAYS YIELDS A DRAFT. When no provider is configured (CI, and any environment without a key),
// when there is no conversation to reason over, when the R12 context is absent, or when the provider
// throws or returns empty — the DETERMINISTIC fallback runs: the very acknowledgement R4 shipped
// (composeReceptionistReply). So generation is total and, in the fallback, byte-for-byte the pre-R13
// behaviour — the reason is recorded on the draft's provenance for observability.
// =====================================================================

/** The label recorded on a draft the model generated (the conversation-aware path). */
export const MODEL_PRODUCER = "conversation_aware_reply";
/**
 * The label recorded on a draft the deterministic fallback produced. Kept identical to the pre-R13
 * acknowledgement producer so the fallback is, in provenance too, exactly the reply R4 shipped — the
 * `fallback_reason` field names WHY the fallback ran.
 */
export const FALLBACK_PRODUCER = "deterministic_acknowledgement";

/**
 * One generated reply draft plus its provenance — the draft text and the deterministic cost/model
 * accounting the canonical service folds into the audit metadata. `fallback_reason` is null on the
 * generated path and names the cause on the deterministic path, so every draft is explainable.
 */
export type GeneratedReplyDraft = {
  /** The reply text to enforce and audit — a model generation, or the deterministic acknowledgement. */
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

/** The inputs the generator needs: the org + channel, and the conversation to reason over (if any). */
export type GenerateReplyDraftInput = {
  /** The organisation the reply is drafted on behalf of (org-scopes the R12 context fetch). */
  org_id: string;
  /** The inbound channel the reply answers — selects the deterministic fallback's phrasing. */
  channel: InboundChannel;
  /** The conversation to reason over. Null (no contact ⇒ no thread) ⇒ deterministic fallback. */
  conversation_id: string | null;
  /**
   * The canonical R12 context, ALREADY ASSEMBLED by the caller (R16). When the runtime orchestrates a
   * turn it reconstructs and assembles ONCE and threads that single context in here, so the generator
   * consumes it verbatim WITHOUT a second fetch. Absent (a standalone caller) ⇒ the generator performs
   * its own canonical, org-scoped fetch below — the pre-R16 behaviour, unchanged.
   */
  context?: ConversationContext | null;
  /** The output-token ceiling; defaults to {@link DEFAULT_REPLY_DRAFT_MAX_TOKENS}. */
  max_tokens?: number;
};

/**
 * Generate the next receptionist reply draft for a conversation, consuming ONLY the canonical R12
 * context and reaching the model ONLY through the existing abstraction. Returns the draft plus its
 * provenance; it NEVER enforces, audits, or transports — the canonical service does that with the
 * returned draft, unchanged. Total: it always resolves to a draft, degrading to the deterministic
 * acknowledgement (never throwing) when there is no provider, no conversation, no context, or the
 * model call fails or returns nothing.
 */
export async function generateReplyDraft(
  input: GenerateReplyDraftInput,
): Promise<GeneratedReplyDraft> {
  const maxTokens = input.max_tokens ?? DEFAULT_REPLY_DRAFT_MAX_TOKENS;

  // No conversation to reason over (e.g. a contactless enquiry) → deterministic acknowledgement.
  // A conversation-aware draft is impossible without a conversation; behaviour is the pre-R13 reply.
  if (!input.conversation_id) return fallback(input.channel, "no_conversation");

  // CONSUME ONLY THE CANONICAL R12 CONTEXT, and consume it FIRST — a conversation-aware draft can be
  // built from nothing else. The context is EITHER threaded in by the R16 runtime (assembled ONCE
  // upstream, org-scoped at reconstruction) OR, for a standalone caller, fetched here through the
  // single org-scoped R12 seam. Consuming it before the provider check keeps org-scoping unconditional
  // and observable and this generator's identity unambiguous: it consults the canonical context, then
  // decides whether a model is available to draft from it. Absent (a conversation that does not exist
  // in this org) ⇒ deterministic fallback.
  const context =
    input.context ??
    (await getConversationContext({
      org_id: input.org_id,
      conversation_id: input.conversation_id,
    }));
  if (!context) return fallback(input.channel, "no_context");

  const provider = getTextProvider();
  // No provider configured → deterministic fallback (the DEFAULT path in CI, where no LLM key is
  // set — so generation is reproducible end to end and byte-for-byte the pre-R13 acknowledgement).
  if (!provider) return fallback(input.channel, "no_provider");

  // Only the two known LLM vendors yield a generated draft; anything else degrades deterministically.
  if (provider.info.provider !== "anthropic" && provider.info.provider !== "openai") {
    return fallback(input.channel, "unsupported_provider");
  }

  const prompt = buildReplyPrompt(context);

  const startedAt = Date.now();
  let result: TextResult;
  try {
    result = await provider.generate(prompt.user, {
      system: prompt.system,
      temperature: 0, // bounded determinism: temperature 0 + a pinned model (ADR 0002).
      maxTokens,
    });
  } catch (err) {
    // A transient provider failure degrades to the deterministic draft — generation never fails.
    return fallback(input.channel, `provider_error: ${errMessage(err)}`);
  }
  const latencyMs = Date.now() - startedAt;

  const draft = result.text.trim();
  // An empty generation is not a usable draft → deterministic acknowledgement instead.
  if (!draft) return fallback(input.channel, "empty_generation");

  return {
    draft,
    producer: MODEL_PRODUCER,
    model: result.model,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    cost_usd: textCostUsd(provider.info, result),
    latency_ms: latencyMs,
    fallback_reason: null,
  };
}

/**
 * The deterministic, model-free leg — the exact acknowledgement R4 shipped
 * ({@link composeReceptionistReply}), always available and always reproducible. The reason names why
 * the model path did not run; the producer stays the pre-R13 label so the fallback is, end to end,
 * the pre-R13 reply.
 */
function fallback(channel: InboundChannel, reason: string): GeneratedReplyDraft {
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
