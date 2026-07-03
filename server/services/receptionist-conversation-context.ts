import "server-only";
import {
  assembleConversationContext,
  type AssembleOptions,
  type ConversationContext,
} from "@/lib/receptionist/conversation-context";
import { reconstructConversation } from "@/server/services/receptionist-conversation-reads";

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
 * Assemble THE canonical, model-ready conversation context for one conversation in an organisation.
 * Reconstructs the conversation through the R11 read model (org-scoped, deterministic), then applies
 * the pure R12 assembler. Returns null when the conversation does not exist in this organisation
 * (R11's null, propagated). Read-only and model-free: it reads and projects, nothing more.
 */
export async function getConversationContext(input: {
  org_id: string;
  conversation_id: string;
  options?: AssembleOptions;
}): Promise<ConversationContext | null> {
  const reconstructed = await reconstructConversation({
    org_id: input.org_id,
    conversation_id: input.conversation_id,
  });
  if (!reconstructed) return null;
  return assembleConversationContext(reconstructed, input.options);
}
