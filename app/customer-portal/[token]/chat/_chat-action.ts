"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "../../_helpers";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import { emitNotifications } from "@/server/services/notifications-service";
import { postDeterministicChatAck } from "@/server/services/chat-auto-reply";
import { chatContactRef } from "./_chat-reads";

/**
 * MP Phase 8 "Live Chat" — the customer's SEND action.
 *
 * The customer types in their portal chat and posts here. The whole flow, in
 * order, and why each step is where it is:
 *
 *   1. VALIDATE the token (uuid) + body (1..10000) with zod. A malformed token
 *      is encoded before it re-enters a redirect path.
 *   2. RATE-LIMIT on the shared `portal_write` budget, keyed by token — the same
 *      budget messages/uploads/requests use.
 *   3. RESOLVE the customer through the ONE authority (loadCustomerByPortalToken).
 *      Every identity-bearing value below (org_id, customer_id, contact_ref,
 *      contact_name) comes from the token-resolved customer — NEVER from the
 *      form — so a crafted field cannot file a message into another org/customer.
 *   4. UPSERT the customer's one chat thread on (org_id, channel, contact_ref);
 *      re-chatting reuses the same thread.
 *   5. INSERT the inbound message (direction 'inbound', status 'received',
 *      auto_generated false). This row is what staff see in /inbox/conversations.
 *   6. Post the automated acknowledgement (deterministic today, AI-dark seam).
 *   7. NOTIFY the org (a new customer chat message) + AUDIT-log.
 *   8. REDIRECT back to the chat tab.
 *
 * Service-role client (no JWT); org + customer pinned on every write.
 */

const TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const chatMessageSchema = z.object({
  token: z.string().uuid(),
  body: z.string().trim().min(1).max(10_000),
});

function backTo(token: string, outcome: { sent?: string; error?: string }): never {
  const qs = outcome.sent
    ? `?sent=${encodeURIComponent(outcome.sent)}`
    : `?error=${encodeURIComponent(outcome.error ?? "unknown")}`;
  redirect(`/customer-portal/${token}/chat${qs}`);
}

/** Upsert shim — conversations' columns aren't in the generated types. */
type Upsert = {
  upsert: (
    row: unknown,
    opts: { onConflict: string },
  ) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: { id: string } | null;
        error: { message: string } | null;
      }>;
    };
  };
};
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

export async function sendPortalChatMessage(formData: FormData): Promise<void> {
  const rawToken = String(formData.get("token") ?? "");
  if (!TOKEN_RE.test(rawToken)) {
    redirect(`/customer-portal/${encodeURIComponent(rawToken)}/chat?error=invalid_token`);
  }

  // Throttle portal writes per token — the shared budget.
  const rl = await consume("portal_write", rawToken, DEFAULT_LIMITS.portal_write);
  if (!rl.allowed) backTo(rawToken, { error: "rate_limited" });

  const parsed = chatMessageSchema.safeParse({
    token: rawToken,
    body: formData.get("body"),
  });
  if (!parsed.success) backTo(rawToken, { error: "invalid_input" });
  const { token, body } = parsed.data;

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) backTo(token, { error: "invalid_token" });
  const { customer } = loaded;

  const admin = createAdminClient();
  const now = new Date().toISOString();
  const contactRef = chatContactRef(customer.id);

  // (4) Upsert the customer's one chat thread. Identity is stamped from the
  // token-resolved customer; the conflict key reuses an existing thread.
  const { data: conv, error: convErr } = await (
    admin.from("conversations" as never) as unknown as Upsert
  )
    .upsert(
      {
        org_id: customer.org_id,
        channel: "chat",
        contact_ref: contactRef,
        customer_id: customer.id,
        contact_name: customer.name,
        status: "active",
        last_message_at: now,
      },
      { onConflict: "org_id,channel,contact_ref" },
    )
    .select("id")
    .single();
  if (convErr || !conv?.id) {
    console.error("[portal/chat] conversation upsert failed", convErr);
    backTo(token, { error: "could_not_send" });
  }
  const conversationId = conv!.id;

  // (5) Record the inbound customer message — what staff see in the inbox.
  const { error: msgErr } = await (
    admin.from("messages" as never) as unknown as MessageInsert
  )
    .insert({
      org_id: customer.org_id,
      conversation_id: conversationId,
      direction: "inbound",
      channel: "chat",
      to_addr: null,
      body,
      status: "received",
      provider_id: null,
      failure_reason: null,
      created_by: null,
      auto_generated: false,
    })
    .select("id")
    .single();
  if (msgErr) {
    console.error("[portal/chat] inbound message insert failed", msgErr);
    backTo(token, { error: "could_not_send" });
  }

  // (6) Automated acknowledgement — deterministic today (AI-dark seam), stamped
  // auto_generated. Best-effort inside; never blocks the send.
  await postDeterministicChatAck({
    orgId: customer.org_id,
    conversationId,
    contactRef,
    customerMessage: body,
  });

  // (7) Notify the org that a customer sent a chat message. audience 'hq' →
  // staff feed; org-pinned. Best-effort inside emitNotifications.
  await emitNotifications({
    org_id: customer.org_id,
    user_id: null,
    audience: "hq",
    type: "chat.customer_message",
    category: "support",
    title: `New chat message from ${customer.name}`,
    body: body.length > 140 ? `${body.slice(0, 137)}…` : body,
    priority: "medium",
    source_module: "conversations",
    source_id: conversationId,
    action_url: `/inbox/conversations/${conversationId}`,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      channel: "chat",
    },
  });

  await recordAdminActivity({
    actorId: null,
    actorEmail: customer.email ?? null,
    action: "portal.chat.message_sent",
    targetTable: "conversations",
    targetId: conversationId,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      customer_name: customer.name,
      source: "customer_portal",
    },
  });

  revalidatePath(`/customer-portal/${token}/chat`);
  // The staff inbox now carries the new message.
  revalidatePath("/inbox/conversations");
  revalidatePath(`/inbox/conversations/${conversationId}`);
  backTo(token, { sent: "1" });
}
