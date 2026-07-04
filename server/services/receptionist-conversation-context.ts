import "server-only";
import {
  assembleConversationContext,
  type AssembleOptions,
  type ConversationContext,
} from "@/lib/receptionist/conversation-context";
import {
  reconstructConversation,
  type ConversationSummary,
} from "@/server/services/receptionist-conversation-reads";

// Re-export the canonical context TYPE from this server seam so the runtime and the R13 reply
// generator can THREAD and consume a `ConversationContext` without importing the pure assembler
// module directly — the R13 generator invariant forbids the generator seam from importing
// "@/lib/receptionist/conversation-context". The type is declared once, in the pure layer; this is a
// type-only re-export that adds no new import specifier and no runtime surface.
export type { ConversationContext };

// =====================================================================
// THE CONVERSATION CONTEXT SERVER SEAM (CEO Directive #018, R12).
//
// The pure R12 assembler (lib/receptionist/conversation-context.ts) is client/server-safe and does
// NO I/O — it only PROJECTS an already-reconstructed conversation into a model-ready context. This
// module is its ONE server-side entry point: the org-scoped, awaitable function every future
// consumer (reply generation, memory injection, human handoff, booking intent) calls to obtain the
// canonical context for a live conversation.
//
// It composes exactly two canonical layers and adds nothing of its own:
//   1. R11's reconstructConversation — THE single, org-scoped, deterministic way to read a
//      conversation's container metadata + ordered timeline (message bodies referenced, never
//      copied; ordering defined once, in the read model).
//   2. R12's assembleConversationContext — THE single, pure, deterministic way to fold that
//      reconstruction into a role-attributed, token-budgeted context object.
//
// It is READ-ONLY and calls NO MODEL. It reconstructs and assembles; it drafts no reply, retrieves
// no memory, enforces no policy, contacts no provider, and mutates no row. Org-scoping is inherited
// wholesale from R11 (the org_id filter lives on every read query), so one org can never assemble
// another's context. Determinism is inherited wholesale too: R11 reconstructs a conversation
// identically every read, the R12 fold is pure, so the same conversation always yields the same
// context object. Returns null for a conversation that does not exist in this organisation —
// exactly R11's null, propagated unchanged.
// =====================================================================

/**
 * The canonical context AND the conversation summary it was assembled from — the product of ONE
 * reconstruction. The R16 runtime consumes this to observe a turn (the summary carries the R15
 * `runtime_state` marker) while threading the SAME `context` down the pipeline, so an autonomous turn
 * reconstructs and assembles EXACTLY ONCE. Both fields derive from a single reconstructConversation.
 */
export type ConversationTurnContext = {
  /** The model-ready context — the SINGLE assembly, threaded through the whole turn. */
  context: ConversationContext;
  /** The container metadata from the SAME reconstruction — carries the R15 `runtime_state` marker. */
  summary: ConversationSummary;
};

/**
 * Reconstruct a conversation ONCE and assemble its canonical context ONCE, returning BOTH the assembled
 * context and the summary it came from. THE single-reconstruction entry point for the R16 runtime: a
 * turn reads `summary.runtime_state` here and threads `context` down to the generator IN PLACE OF a
 * second fetch, so it never reconstructs or assembles twice. Org-scoped and deterministic wholesale
 * from R11; returns null when the conversation does not exist in this organisation (R11's null).
 */
export async function getConversationTurnContext(input: {
  org_id: string;
  conversation_id: string;
  options?: AssembleOptions;
}): Promise<ConversationTurnContext | null> {
  const reconstructed = await reconstructConversation({
    org_id: input.org_id,
    conversation_id: input.conversation_id,
  });
  if (!reconstructed) return null;
  return {
    context: assembleConversationContext(reconstructed, input.options),
    summary: reconstructed.conversation,
  };
}

/**
 * Assemble THE canonical, model-ready conversation context for one conversation in an organisation.
 * Reconstructs the conversation through the R11 read model (org-scoped, deterministic), then applies
 * the pure R12 assembler. Returns null when the conversation does not exist in this organisation
 * (R11's null, propagated). Read-only and model-free: it reads and projects, nothing more. Defined in
 * terms of {@link getConversationTurnContext}, so this module keeps exactly ONE reconstruct-and-assemble
 * call site — the standalone consumers that need only the context project it off the shared helper.
 */
export async function getConversationContext(input: {
  org_id: string;
  conversation_id: string;
  options?: AssembleOptions;
}): Promise<ConversationContext | null> {
  const turn = await getConversationTurnContext(input);
  return turn?.context ?? null;
}
