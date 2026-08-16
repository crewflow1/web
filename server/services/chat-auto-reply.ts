import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTextProvider } from "@/lib/ai/text";
import { invokeWithGovernor, isTierActivated } from "@/lib/ai/governor";

/**
 * MP Phase 8 "Live Chat" — the automated acknowledgement a portal chat gets the
 * moment a customer sends a message, and the AI-dark seam behind it.
 *
 * WHAT THIS GUARANTEES, IN PLAIN TERMS.
 * When a customer posts in their portal chat, the company sees the message in
 * the unified inbox and replies with a real human at the composer — but that
 * reply is not instant. So the customer immediately gets ONE automated message
 * back, marked as automated (messages.auto_generated = true), telling them the
 * message landed and a person will follow up. That reassurance is:
 *
 *   • DETERMINISTIC TODAY. No inference tier is bound (see lib/ai/governor —
 *     every tier maps to null), so `maybeGenerateChatReply` returns null WITHOUT
 *     reaching a model, and the fixed `DETERMINISTIC_CHAT_ACK` string is posted.
 *     A model is NEVER called while dark: the tier gate below short-circuits
 *     before a provider is even resolved.
 *
 *   • GOVERNED WHEN IT LIGHTS UP. The (future) AI reply is routed through
 *     `invokeWithGovernor` under the registered `chat.auto_reply` feature
 *     (task class `drafting` — customer-facing prose). Binding a tier is the ONE
 *     switch that turns the AI reply on; until then the deterministic ack stands
 *     in, so the customer's experience is identical and honest. When AI does
 *     run, its output is still stamped auto_generated = true and the panel still
 *     labels it "Automated" — an AI reply is never passed off as a person.
 *
 * The insert is service-role (the portal carries no JWT) and every write is
 * pinned to the passed org_id + conversation_id, both resolved from the
 * token-authenticated customer by the caller — never from client input.
 */

/**
 * The fixed acknowledgement. Deterministic and stable — the same string every
 * time, computable without a model, which is exactly why sending it to one would
 * be refused by the governor. This is what `chat.auto_reply` degrades to.
 */
export const DETERMINISTIC_CHAT_ACK =
  "Thanks — we've got your message and a team member will reply here shortly.";

/** The chainable insert shim — messages' new columns aren't in generated types. */
type MessageInsert = {
  insert: (row: unknown) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: { id: string } | null;
        error: { message: string } | null;
      }>;
    };
  };
};

/**
 * Produce the automated reply text for a customer's chat message.
 *
 * DARK-SAFE BY CONSTRUCTION. The `drafting` tier gate is checked FIRST — while
 * it is dark (the state today, and until a tier is bound in the registry), this
 * returns null before a provider is resolved or the governor is entered, so no
 * model is ever contacted and nothing is charged. The caller then posts the
 * deterministic ack.
 *
 * When a tier IS bound, the model call rides the shared text door under
 * `invokeWithGovernor`, so the £/org/month ceiling, the duplicate refusal and
 * the token/cost ledger all apply. Any non-`ran` outcome (blocked, duplicate,
 * dark) falls back to null → the deterministic ack, so the caller learns no new
 * outcome and the customer always gets a reply.
 */
async function maybeGenerateChatReply(input: {
  orgId: string;
  customerMessage: string;
}): Promise<string | null> {
  // PER-TIER OWN-CLASS GATE (mirrors server/services/ai-question.ts). The text
  // door opens on ANY generative tier, so a partial binding + a vendor key would
  // otherwise hand this `drafting` surface a live provider the governor would
  // then run ungoverned. Gate on this call's own tier before resolving one —
  // and while dark (today) this is the line that guarantees no model is called.
  if (!isTierActivated("drafting")) return null;

  const provider = getTextProvider();
  if (!provider) return null;

  const system = [
    "You are the live-chat assistant for a UK trades company, replying to a customer in their portal.",
    "Write ONE short, warm acknowledgement (1-2 sentences) confirming their message was received and a team member will reply.",
    "Do NOT promise prices, dates, or commitments. Do NOT invent facts. Plain prose, no markdown.",
  ].join("\n");

  try {
    const outcome = await invokeWithGovernor(
      "chat.auto_reply",
      "drafting",
      async () => {
        const generated = await provider.generate(input.customerMessage, {
          system,
          temperature: 0.3,
          maxTokens: 200,
          signal: AbortSignal.timeout(10_000),
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
        orgId: input.orgId,
        // A customer sent this, but the ledger's user_id is for CrewFlow users;
        // a portal customer is not one, so this stays null.
        userId: null,
        dedupeContent: input.customerMessage,
      },
    );
    if (outcome.status !== "ran") return null;
    const text = outcome.value.text.trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    // The governor records + rethrows a provider failure; degrade to the
    // deterministic ack exactly as the no-provider leg does.
    console.error("[chat-auto-reply] generation failed", err);
    return null;
  }
}

/**
 * Post the automated acknowledgement onto a customer's chat conversation.
 *
 * Called by the portal send action AFTER the inbound customer message is
 * recorded. Best-effort: a failure here is logged and swallowed — the customer's
 * own message is already saved and visible to staff, so the ack never blocks the
 * primary write. The row is:
 *   - direction 'outbound', channel 'chat', status 'sent' (in-app: the row IS
 *     the delivery — there is no external transport to queue against);
 *   - created_by null (no human authored it);
 *   - auto_generated true (provenance: the UI labels it "Automated").
 */
export async function postDeterministicChatAck(input: {
  orgId: string;
  conversationId: string;
  contactRef: string;
  customerMessage: string;
}): Promise<void> {
  try {
    // The AI-dark seam. Null today (no tier bound → no model call); the
    // deterministic ack stands in. When a tier is bound, this returns governed
    // AI prose — still stamped auto_generated below.
    const generated = await maybeGenerateChatReply({
      orgId: input.orgId,
      customerMessage: input.customerMessage,
    });
    const body = generated ?? DETERMINISTIC_CHAT_ACK;

    const admin = createAdminClient();
    const { error } = await (
      admin.from("messages" as never) as unknown as MessageInsert
    )
      .insert({
        org_id: input.orgId,
        conversation_id: input.conversationId,
        direction: "outbound",
        channel: "chat",
        to_addr: input.contactRef,
        body,
        status: "sent",
        provider_id: null,
        failure_reason: null,
        created_by: null,
        auto_generated: true,
      })
      .select("id")
      .single();
    if (error) {
      console.error("[chat-auto-reply] ack insert failed", error.message);
    }
  } catch (e) {
    // Never let the acknowledgement break the customer's send.
    console.error(
      "[chat-auto-reply] postDeterministicChatAck threw",
      e instanceof Error ? e.message : String(e),
    );
  }
}
