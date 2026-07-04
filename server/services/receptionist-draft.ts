import "server-only";
import { generateConversationResponse } from "@/server/services/receptionist-generation";
import {
  MODEL_PRODUCER,
  FALLBACK_PRODUCER,
  type GeneratedResponse,
} from "@/lib/receptionist/conversation-generation";
import type { ConversationContext } from "@/server/services/receptionist-conversation-context";
import type { ResponseSpecification } from "@/lib/receptionist/conversation-response";
import type { InboundChannel } from "@/lib/receptionist/types";

// =====================================================================
// THE CONVERSATION-AWARE REPLY DRAFT — THE FIRST IMPLEMENTATION THROUGH THE GENERATION ENGINE
// (CEO Directive #018, R13: CONVERSATION-AWARE REPLY DRAFTING → R25: CONVERSATION GENERATION ENGINE).
//
// R4's pipeline drafted the ONE reply an autonomous receptionist may send with no human behind it: a FIXED,
// deterministic acknowledgement. R13 replaced that fixed composer with a CONVERSATION-AWARE draft GENERATOR that
// consumed the canonical R12 context and reached a language model through the house abstraction. R25 lifts the
// draft GENERATION itself into a canonical, shared capability — the CONVERSATION GENERATION ENGINE
// (server/services/receptionist-generation.ts + lib/receptionist/conversation-generation.ts) — the single
// authority that converts an R24 response specification, grounded in the R12 context, into a draft. This module is
// no longer the generator; it is the generator's FIRST IMPLEMENTATION: the receptionist reply draft, expressed as
// a thin adapter that submits a {@link GenerationRequest} to the engine and returns what it produces.
//
// IT FORKS NO GENERATION LOGIC. Every act of generation — consuming the R12 context, consuming the R24 spec into a
// model instruction, reaching the model through the existing abstraction (temperature 0, a capped output, cost
// recorded), and degrading to R4's deterministic acknowledgement — lives in the engine, single-sourced. This
// adapter re-implements NONE of it: it maps the receptionist's draft-generation need (an org, a channel, a
// conversation, the threaded context, the derived spec) onto the canonical request and calls
// {@link generateConversationResponse}. Booking, scheduling, CRM, support, voice and every future capability adapt
// their own need onto the SAME engine the same way; no feature drafts conversational language another way.
//
// ITS SINGLE OUTPUT IS A DRAFT PLUS PROVENANCE. It enforces nothing, audits nothing, transports nothing — the
// canonical service runs the returned draft through the UNCHANGED Enforce → Audit → (deny-by-default) → Transport
// chain exactly as it always has. And generation is total: with no provider (CI, and any environment without a
// key), no conversation, no context, or a provider throw/empty, the engine's deterministic fallback runs — the
// very acknowledgement R4 shipped — so this path is byte-for-byte its pre-R13 self in CI, with the reason recorded
// on the draft's provenance for observability.
// =====================================================================

/** The label recorded on a draft the model generated — re-exported from the engine, the provenance authority. */
export { MODEL_PRODUCER, FALLBACK_PRODUCER };

/**
 * One generated reply draft plus its provenance — the engine's {@link GeneratedResponse}, re-exported under the
 * name this seam's consumers (the canonical service, the audit metadata fold) already use. The shape is the
 * engine's canonical result, unchanged: the draft text and the deterministic cost/model/latency accounting, with
 * `fallback_reason` naming WHY the deterministic leg ran (or null on the generated path).
 */
export type GeneratedReplyDraft = GeneratedResponse;

/**
 * The inputs the receptionist reply draft needs: the org + channel, the conversation to reason over (if any), the
 * canonical R12 context ALREADY ASSEMBLED by the caller (R16 — threaded verbatim; absent ⇒ the engine performs its
 * own org-scoped fetch), the R24 RESPONSE SPECIFICATION the runtime derived for this turn (absent ⇒ a spec-less
 * draft, byte-identical to the pre-R25 prompt), and an optional output-token ceiling. This adapter maps them onto
 * the engine's canonical {@link GenerationRequest}.
 */
export type GenerateReplyDraftInput = {
  /** The organisation the reply is drafted on behalf of (org-scopes the R12 context fetch). */
  org_id: string;
  /** The inbound channel the reply answers — selects the deterministic fallback's phrasing. */
  channel: InboundChannel;
  /** The conversation to reason over. Null (no contact ⇒ no thread) ⇒ deterministic fallback. */
  conversation_id: string | null;
  /**
   * The canonical R12 context, ALREADY ASSEMBLED by the caller (R16). Threaded verbatim to the engine; absent (a
   * standalone caller) ⇒ the engine performs its own canonical, org-scoped fetch — the pre-R16 behaviour.
   */
  context?: ConversationContext | null;
  /**
   * The R24 response specification the runtime derived for this turn — guides HOW the engine shapes the draft.
   * Absent (a spec-less caller, e.g. the internal produce-and-enforce path) ⇒ the engine prepares exactly the
   * pre-R25 prompt, so behaviour is unchanged.
   */
  spec?: ResponseSpecification | null;
  /** The output-token ceiling; the engine defaults it when absent. */
  max_tokens?: number;
};

/**
 * Generate the next receptionist reply draft for a conversation — THE first implementation through the
 * Conversation Generation Engine. Maps the receptionist's draft-generation need onto the canonical
 * {@link GenerationRequest} and delegates WHOLE to {@link generateConversationResponse}; it re-implements no
 * generation logic. Returns the draft plus its provenance; it NEVER enforces, audits, or transports — the
 * canonical service does that with the returned draft, unchanged. Total: the engine always resolves to a draft,
 * degrading to the deterministic acknowledgement (never throwing) when there is no provider, no conversation, no
 * context, or the model call fails or returns nothing.
 */
export async function generateReplyDraft(
  input: GenerateReplyDraftInput,
): Promise<GeneratedReplyDraft> {
  return generateConversationResponse({
    org_id: input.org_id,
    channel: input.channel,
    conversation_id: input.conversation_id,
    context: input.context ?? null,
    spec: input.spec ?? null,
    max_tokens: input.max_tokens,
  });
}
