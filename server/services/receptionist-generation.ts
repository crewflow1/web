import "server-only";
import { getTextProvider, textCostUsd, type TextResult } from "@/lib/ai/text";
import { invokeWithGovernor } from "@/lib/ai/governor";
import { getConversationContext } from "@/server/services/receptionist-conversation-context";
import {
  prepareGenerationInstruction,
  fallbackResponse,
  MODEL_PRODUCER,
  type GenerationRequest,
  type GeneratedResponse,
} from "@/lib/receptionist/conversation-generation";

// =====================================================================
// THE CONVERSATION GENERATION ENGINE — SERVER RUNTIME (CEO Directive #018, R25: CONVERSATION GENERATION ENGINE).
//
// The pure core (lib/receptionist/conversation-generation.ts) defines the engine's MODEL, its RESPONSE-SPEC
// CONSUMPTION and its FALLBACK shaping — but it deliberately reaches NO model. This module is the engine's SERVER
// RUNTIME: the ONE place conversational language generation actually reaches a language model. It is the single
// entry point every generating capability calls — {@link generateConversationResponse} — and it CONVERTS a
// {@link GenerationRequest} (the canonical R24 response spec, grounded in the canonical R12 context) into a
// {@link GeneratedResponse}, degrading to the deterministic fallback (never throwing) when the model cannot run.
// The receptionist reply draft (server/services/receptionist-draft.ts) is the FIRST implementation to call it;
// booking, scheduling, CRM, support, voice and every future multi-channel utterance call this SAME function — no
// feature reaches a language model for conversational output any other way.
//
// IT CONSUMES ONLY THE CANONICAL R12 CONTEXT. The only conversation input is the R12 context — threaded in by the
// caller (the R16 runtime assembles it ONCE and hands it down) or, for a standalone caller, fetched here through
// the single org-scoped R12 seam getConversationContext. This engine NEVER reconstructs a conversation (it does
// not touch the R11 read model) and NEVER assembles context (it does not call the R12 assembler directly). It
// consumes what R12 produced, no more.
//
// IT REACHES THE MODEL ONLY THROUGH THE EXISTING ABSTRACTION. The one door to a language model is getTextProvider
// from lib/ai/text (Directive 009) — no vendor SDK is imported here. The edge is BOUNDED, not trusted: the
// instruction the pure core prepared carries temperature 0 and a capped output, and cost is recorded. This is the
// exact idiom R13 established and R25 now single-sources through the engine.
//
// IT ALWAYS YIELDS A DRAFT — AND IT PRODUCES DRAFTS ONLY. When no provider is configured (CI, and any environment
// without a key), when there is no conversation, when the R12 context is absent, or when the provider throws or
// returns empty, the DETERMINISTIC fallback the pure core shapes runs: the acknowledgement R4 shipped. So
// generation is total and, in the fallback, byte-for-byte the pre-R13 behaviour — the reason is recorded on the
// draft's provenance. And that is the whole of its job: this engine GENERATES language and stops. It enforces no
// policy, writes no audit, transports nothing and executes no business action — the canonical service runs the
// draft through the UNCHANGED Enforce → Audit → (deny-by-default) → Transport pipeline, exactly as before.
// =====================================================================

/**
 * Generate the next conversational draft for a request — THE single language-generation entry point, the engine's
 * server runtime. Consumes ONLY the canonical R12 context and the R24 response spec, prepares the model-ready
 * instruction through the pure core ({@link prepareGenerationInstruction}), reaches the model ONLY through the
 * existing abstraction, and returns the draft plus its provenance. It NEVER enforces, audits, or transports — the
 * canonical service does that with the returned draft, unchanged. Total: it always resolves to a draft, degrading
 * to the deterministic acknowledgement ({@link fallbackResponse}, never throwing) when there is no provider, no
 * conversation, no context, or the model call fails or returns nothing.
 */
export async function generateConversationResponse(
  request: GenerationRequest,
): Promise<GeneratedResponse> {
  // No conversation to reason over (e.g. a contactless enquiry) → deterministic acknowledgement. A
  // conversation-aware draft is impossible without a conversation; behaviour is the pre-R13 reply.
  if (!request.conversation_id) return fallbackResponse(request.channel, "no_conversation");

  // CONSUME ONLY THE CANONICAL R12 CONTEXT, and consume it FIRST — a conversation-aware draft can be built from
  // nothing else. The context is EITHER threaded in by the R16 runtime (assembled ONCE upstream, org-scoped at
  // reconstruction) OR, for a standalone caller, fetched here through the single org-scoped R12 seam. Consuming
  // it before the provider check keeps org-scoping unconditional and observable. Absent (a conversation that does
  // not exist in this org) ⇒ deterministic fallback.
  const context =
    request.context ??
    (await getConversationContext({
      org_id: request.org_id,
      conversation_id: request.conversation_id,
    }));
  if (!context) return fallbackResponse(request.channel, "no_context");

  const provider = getTextProvider();
  // No provider configured → deterministic fallback (the DEFAULT path in CI, where no LLM key is set — so
  // generation is reproducible end to end and byte-for-byte the pre-R13 acknowledgement).
  if (!provider) return fallbackResponse(request.channel, "no_provider");

  // Only the two known LLM vendors yield a generated draft; anything else degrades deterministically.
  if (provider.info.provider !== "anthropic" && provider.info.provider !== "openai") {
    return fallbackResponse(request.channel, "unsupported_provider");
  }

  // CONVERT THE SPEC INTO A MODEL INSTRUCTION through the pure core — the single response-spec consumption. The
  // instruction carries R13's fixed safety framing (system), the transcript ask plus the R24 spec's guidance
  // (user), and the bounded edge (temperature 0, the output cap).
  const instruction = prepareGenerationInstruction(context, request.spec, request.max_tokens);

  const startedAt = Date.now();
  let result: TextResult;
  try {
    // GOVERNED. The one door to a model is now also the one door to the AI Cost
    // Governor (lib/ai/governor.ts): the ceiling, the recent-duplicate refusal
    // and the ledger wrap this call, so activation day inherits governance for
    // free rather than acquiring it later. This is the seam BOTH the phone
    // receptionist and the WhatsApp draft-first path reach a model through —
    // governing it here governs both, with no per-channel duplication.
    //
    // DARK TODAY: no tier is bound and no credential is set, so `getTextProvider()`
    // above already returned null and this line is unreachable in production; the
    // deterministic acknowledgement is the live behaviour, unchanged.
    //
    // EVENT-DRIVEN: this runs on an INBOUND MESSAGE — a real conversational
    // turn that just happened — never on a page render or a poll.
    const outcome = await invokeWithGovernor(
      "receptionist.reply_draft",
      "drafting",
      async () => {
        const generated = await provider.generate(instruction.user, {
          system: instruction.system,
          temperature: instruction.temperature,
          maxTokens: instruction.max_tokens,
        });
        return {
          value: generated,
          usage: {
            provider: provider.info.provider,
            model: generated.model,
            inputTokens: generated.inputTokens,
            outputTokens: generated.outputTokens,
          },
        };
      },
      {
        orgId: request.org_id,
        // A system-initiated turn: the inbound webhook has no signed-in user.
        userId: null,
        // Identical instruction for the same conversation within the dedupe
        // window ⇒ the same draft; re-asking is pure waste.
        dedupeContent: `${request.conversation_id}\u0000${instruction.system}\u0000${instruction.user}`,
      },
    );
    if (outcome.status === "blocked") {
      // The org is at its monthly ceiling. Generation stays TOTAL — the
      // deterministic acknowledgement runs, exactly as it does with no provider.
      return fallbackResponse(request.channel, "budget_blocked");
    }
    if (outcome.status === "duplicate") {
      return fallbackResponse(request.channel, "duplicate_request");
    }
    result = outcome.value;
  } catch (err) {
    // A transient provider failure degrades to the deterministic draft — generation never fails.
    // The governor has already RECORDED the failure and rethrown; this catch is unchanged.
    return fallbackResponse(request.channel, `provider_error: ${errMessage(err)}`);
  }
  const latencyMs = Date.now() - startedAt;

  const draft = result.text.trim();
  // An empty generation is not a usable draft → deterministic acknowledgement instead.
  if (!draft) return fallbackResponse(request.channel, "empty_generation");

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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
