"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "./_helpers";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import { readFailure } from "@/lib/supabase/read-failure";
import { emitNotifications } from "@/server/services/notifications-service";
import { notifyOnPortalReplyToOrg } from "@/lib/notifications/events";

/**
 * Phase 3 — Portal reply to an existing support thread.
 *
 * `sendPortalMessage` only ever OPENS a new ticket; this APPENDS to one the
 * customer already owns, completing two-way messaging from the portal. It is
 * the portal peer of the tenant `replyToSupportTicket`, but deliberately
 * mirrors `sendPortalMessage` (this repo's other portal write) rather than the
 * tenant action: the portal has no Supabase JWT, and the audience here is the
 * customer↔org conversation, NOT CrewFlow HQ — so we never emit an HQ
 * notification. We DO emit a TENANT-ORG notification (org-wide, audience
 * 'customer') so staff learn a customer replied instead of having to happen
 * upon it.
 *
 * Flow:
 *   1. Validate token + ticket_id + body.
 *   2. Rate-limit per token (shared portal_write budget).
 *   3. Re-verify the ticket belongs to THIS customer (org_id + customer_id +
 *      id) — a crafted ticket_id from another customer/org fails closed.
 *   4. Insert one support_messages row (author_kind 'customer', internal
 *      false). The support_messages_after_insert trigger stamps the ticket's
 *      reply telemetry and nudges its status — that deterministic state stays
 *      owned by the DB; we never write those columns here.
 *   5. Audit-log so HQ + tenant timelines see the reply.
 *   6. Emit ONE org-scoped notification (notifyOnPortalReplyToOrg) so the
 *      tenant's staff see the reply in-app. org_id is the whole isolation
 *      boundary; no message body is carried.
 */

const schema = z.object({
  token: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "bad token",
    ),
  ticket_id: z.string().uuid(),
  body: z.string().trim().min(1).max(10_000),
});

export async function replyToPortalThread(formData: FormData): Promise<void> {
  const parsed = schema.safeParse({
    token: formData.get("token"),
    ticket_id: formData.get("ticket_id"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    const t = String(formData.get("token") ?? "");
    const tid = String(formData.get("ticket_id") ?? "");
    redirect(
      `/customer-portal/${t}/messages/${tid}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "invalid_input")}`,
    );
  }

  const { token, ticket_id, body } = parsed.data;

  // Throttle portal writes per token to block reply spam.
  const rl = await consume("portal_write", token, DEFAULT_LIMITS.portal_write);
  if (!rl.allowed) {
    redirect(
      `/customer-portal/${token}/messages/${ticket_id}?error=${encodeURIComponent("Too many messages. Please wait a moment and try again.")}`,
    );
  }

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    redirect(
      `/customer-portal/${token}/messages/${ticket_id}?error=invalid_token`,
    );
  }
  const { customer } = loaded;

  const admin = createAdminClient();

  // SECURITY: re-verify the ticket is THIS customer's before appending. The
  // portal runs under the service-role admin client (no JWT, so RLS cannot
  // scope it); org_id + customer_id + id is the ONLY thing stopping a crafted
  // ticket_id from letting a customer post into another customer's (or org's)
  // thread. Fails closed to an error redirect when the ticket isn't theirs.
  type TicketLookup = {
    eq: (k: string, v: unknown) => TicketLookup;
    maybeSingle: () => Promise<{
      data: { id: string; ticket_number: number; subject: string } | null;
      error: { message: string } | null;
    }>;
  };
  const { data: ticket, error: ticketError } = await (
    admin.from("support_tickets" as never) as unknown as {
      select: (cols: string) => TicketLookup;
    }
  )
    .select("id, ticket_number, subject")
    .eq("id", ticket_id)
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .maybeSingle();
  // Loud fail (stays fail-closed): a query failure must not tell the customer
  // their ticket doesn't exist.
  if (ticketError) throw readFailure("portal: thread ownership", ticketError);

  if (!ticket) {
    redirect(
      `/customer-portal/${token}/messages/${ticket_id}?error=ticket_not_found`,
    );
  }

  const { error: mErr } = await admin
    .from("support_messages" as never)
    .insert({
      ticket_id: ticket.id,
      org_id: customer.org_id,
      author_id: null,
      author_kind: "customer",
      internal: false,
      body: `[Portal reply from ${customer.name}]\n\n${body}`,
    } as never);

  if (mErr) {
    console.error("[portal/reply] message insert failed", mErr);
    redirect(
      `/customer-portal/${token}/messages/${ticket_id}?error=${encodeURIComponent("could_not_send")}`,
    );
  }

  // Audit log so HQ sees "customer X replied to ticket Y via portal".
  await recordAdminActivity({
    actorId: null,
    actorEmail: customer.email ?? null,
    action: "portal.message.reply",
    targetTable: "support_tickets",
    targetId: ticket.id,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      customer_name: customer.name,
      ticket_number: ticket.ticket_number,
      source: "customer_portal",
    },
  });

  // Tell the tenant's staff, in-app, that their customer replied — the portal
  // reply was previously silent. Org-scoped (audience 'customer', user_id null →
  // every org member); no body carried. emitNotifications is best-effort and
  // swallows its own errors, so a notification failure never fails the reply.
  await emitNotifications(
    notifyOnPortalReplyToOrg({
      org_id: customer.org_id,
      ticket_id: ticket.id,
      ticket_number: ticket.ticket_number,
      customer_name: customer.name,
    }),
  );

  revalidatePath(`/customer-portal/${token}/messages/${ticket_id}`);
  revalidatePath(`/customer-portal/${token}/messages`);
  // Touch the relevant HQ + tenant inboxes so they see the new reply.
  revalidatePath(`/admin/support`);
  revalidatePath(`/support`);
  redirect(`/customer-portal/${token}/messages/${ticket_id}?saved=reply`);
}
