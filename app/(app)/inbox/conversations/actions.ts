"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { readFailure } from "@/lib/supabase/read-failure";
import { sendInboxReply } from "@/server/services/inbox-send";
import { normalizeAddress } from "@/lib/comms/policy";
import { toE164 } from "@/lib/phone";
import { INBOX_CHANNELS, type InboxChannel } from "@/lib/inbox/channels";

/**
 * P3 Inbox — the reply composer + new-conversation server actions.
 *
 * Mirrors the two-way support pattern (app/(app)/support/actions.ts): user-JWT writes so
 * RLS gates them, an explicit ACTIVE-ORG pin on every resolve (RLS admits all the caller's
 * orgs), a LOUD thread resolve (a query error throws — never reads as "not found"), and
 * the DB trigger owns the conversation counter. The outbound SEND is dark-safe: it rides
 * `sendInboxReply`, which QUEUES (never crashes, never sends) when the channel's provider
 * is unset — the state in CI/dev/prod today.
 */

const replySchema = z.object({
  conversation_id: z.string().uuid(),
  body: z.string().trim().min(1).max(10_000),
});

const startSchema = z.object({
  channel: z.enum(INBOX_CHANNELS),
  contact: z.string().trim().min(1).max(320),
  contact_name: z.string().trim().max(200).optional(),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(10_000),
});

const archiveSchema = z.object({
  conversation_id: z.string().uuid(),
  status: z.enum(["active", "archived"]),
});

/** Canonical contact identity for a channel: an email is lower-cased bare; a number → E.164. */
function normaliseContact(channel: InboxChannel, contact: string): string {
  if (channel === "email") return normalizeAddress(contact);
  return toE164(contact) ?? contact.trim().toLowerCase();
}

/** Chainable insert/update shims — the new columns are not yet in the generated types. */
type InsertReturning = {
  insert: (row: unknown) => {
    select: (cols: string) => {
      single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
    };
  };
};
type Upsert = {
  upsert: (
    row: unknown,
    opts: { onConflict: string },
  ) => {
    select: (cols: string) => {
      single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
    };
  };
};
type UpdateChain = PromiseLike<{ error: { message: string } | null }> & {
  eq: (k: string, v: unknown) => UpdateChain;
};
type ConvResolve = {
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<{
          data: {
            id: string;
            channel: string;
            contact_ref: string | null;
            subject: string | null;
          } | null;
          error: { message: string; code?: string } | null;
        }>;
      };
    };
  };
};

/**
 * Send one composed reply on an existing conversation. Resolves the thread (loud,
 * org-pinned) to learn its channel + destination, carries the reply over the dark-safe
 * seam, then records the outbound message (its status reflects sent/queued/failed).
 */
export async function replyToConversation(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const parsed = replySchema.safeParse({
    conversation_id: formData.get("conversation_id"),
    body: formData.get("body"),
  });
  if (!parsed.success) redirect("/inbox/conversations?error=invalid_input");
  const { conversation_id, body } = parsed.data;

  const supabase = await createClient();
  const resolveClient = supabase.from("conversations" as never) as unknown as ConvResolve;
  const { data: conv, error: convErr } = await resolveClient
    .select("id, channel, contact_ref, subject")
    .eq("id", conversation_id)
    .eq("org_id", ctx.membership.org_id)
    .maybeSingle();
  if (convErr) throw readFailure("inbox: reply thread resolve", convErr);
  if (!conv) redirect("/inbox/conversations?error=not_found");

  const channel = (INBOX_CHANNELS as readonly string[]).includes(conv.channel)
    ? (conv.channel as InboxChannel)
    : "chat";

  const send = await sendInboxReply({
    channel,
    destination: conv.contact_ref,
    body,
    subject: conv.subject,
  });

  const insertClient = supabase.from("messages" as never) as unknown as InsertReturning;
  const { error: msgErr } = await insertClient
    .insert({
      org_id: ctx.membership.org_id,
      conversation_id,
      direction: "outbound",
      channel,
      to_addr: send.destination,
      body,
      status: send.status,
      provider_id: send.providerMessageId,
      failure_reason: send.failureReason,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (msgErr) {
    console.error("[inbox] outbound message record failed", msgErr);
    redirect(`/inbox/conversations/${conversation_id}?error=reply_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "inbox.reply_sent",
    targetTable: "messages",
    targetId: conversation_id,
    metadata: { channel, status: send.status, failure_reason: send.failureReason },
  });

  revalidatePath(`/inbox/conversations/${conversation_id}`);
  revalidatePath("/inbox/conversations");
  redirect(`/inbox/conversations/${conversation_id}?sent=${send.status}`);
}

/**
 * Start a NEW outbound conversation with a contact and send the first message. Upserts the
 * thread on the contact-identity key so re-messaging a known contact reuses their thread.
 */
export async function startConversation(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const parsed = startSchema.safeParse({
    channel: formData.get("channel"),
    contact: formData.get("contact"),
    contact_name: formData.get("contact_name") || undefined,
    subject: formData.get("subject") || undefined,
    body: formData.get("body"),
  });
  if (!parsed.success) redirect("/inbox/conversations/new?error=invalid_input");
  const { channel, contact, contact_name, subject, body } = parsed.data;
  const contactRef = normaliseContact(channel, contact);

  const supabase = await createClient();
  const upsertClient = supabase.from("conversations" as never) as unknown as Upsert;
  const { data: conv, error: convErr } = await upsertClient
    .upsert(
      {
        org_id: ctx.membership.org_id,
        channel,
        contact_ref: contactRef,
        contact_name: contact_name ?? null,
        subject: subject ?? null,
        status: "active",
        last_message_at: new Date().toISOString(),
      },
      { onConflict: "org_id,channel,contact_ref" },
    )
    .select("id")
    .single();
  if (convErr || !conv?.id) {
    console.error("[inbox] conversation upsert failed", convErr);
    redirect("/inbox/conversations/new?error=create_failed");
  }
  const conversationId = conv!.id;

  const send = await sendInboxReply({ channel, destination: contactRef, body, subject });

  const insertClient = supabase.from("messages" as never) as unknown as InsertReturning;
  const { error: msgErr } = await insertClient
    .insert({
      org_id: ctx.membership.org_id,
      conversation_id: conversationId,
      direction: "outbound",
      channel,
      to_addr: send.destination,
      body,
      status: send.status,
      provider_id: send.providerMessageId,
      failure_reason: send.failureReason,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (msgErr) {
    console.error("[inbox] first outbound message record failed", msgErr);
    redirect(`/inbox/conversations/${conversationId}?error=reply_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "inbox.conversation_started",
    targetTable: "conversations",
    targetId: conversationId,
    metadata: { channel, status: send.status },
  });

  revalidatePath("/inbox/conversations");
  redirect(`/inbox/conversations/${conversationId}?sent=${send.status}`);
}

/** Archive or reactivate a conversation (members may update; org-pinned). */
export async function setConversationStatus(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const parsed = archiveSchema.safeParse({
    conversation_id: formData.get("conversation_id"),
    status: formData.get("status"),
  });
  if (!parsed.success) redirect("/inbox/conversations?error=invalid_input");
  const { conversation_id, status } = parsed.data;

  const supabase = await createClient();
  const updateClient = supabase.from("conversations" as never) as unknown as {
    update: (row: unknown) => UpdateChain;
  };
  const { error } = await updateClient
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", conversation_id)
    .eq("org_id", ctx.membership.org_id);
  if (error) {
    console.error("[inbox] conversation status update failed", error);
    redirect(`/inbox/conversations/${conversation_id}?error=status_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "inbox.conversation_status_changed",
    targetTable: "conversations",
    targetId: conversation_id,
    metadata: { status },
  });

  revalidatePath("/inbox/conversations");
  revalidatePath(`/inbox/conversations/${conversation_id}`);
  redirect(status === "archived" ? "/inbox/conversations" : `/inbox/conversations/${conversation_id}`);
}
