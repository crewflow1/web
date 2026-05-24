"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "./_helpers";
import { recordAdminActivity } from "@/server/services/hq-audit";

/**
 * Phase 3 — Portal message → support ticket.
 *
 * The customer types from `/customer-portal/[token]/messages`. We:
 *   1. Validate the token (only way to identify the customer).
 *   2. Create a `support_tickets` row attributed to this customer/org.
 *      Source field is `portal` so HQ knows where it came from.
 *   3. Insert the first `support_messages` row.
 *   4. Audit-log the action.
 *
 * The existing /admin/support and tenant /support pages will pick up
 * the ticket automatically — we never had to teach them about portal
 * specifically.
 */

const schema = z.object({
  token: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "bad token",
    ),
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
});

export async function sendPortalMessage(formData: FormData): Promise<void> {
  const parsed = schema.safeParse({
    token: formData.get("token"),
    subject: formData.get("subject"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    const t = String(formData.get("token") ?? "");
    redirect(
      `/customer-portal/${t}/messages?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "invalid_input")}`,
    );
  }

  const { token, subject, body } = parsed.data;

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    redirect(`/customer-portal/${token}/messages?error=invalid_token`);
  }
  const { customer, org } = loaded;

  const admin = createAdminClient();

  // Insert ticket + first message in two writes — the ticket_number
  // trigger needs the INSERT to complete before we can reference it.
  const { data: ticket, error: tErr } = await (
    admin.from("support_tickets" as never) as unknown as {
      insert: (row: unknown) => {
        select: (cols: string) => {
          single: () => Promise<{
            data: { id: string } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .insert({
      org_id: customer.org_id,
      subject,
      status: "open",
      priority: "normal",
      category: "other",
      created_by: null,
      // Convention: portal-originated tickets carry the customer_id in
      // a notes-prefix so HQ ops can correlate. The schema doesn't
      // have a `source` column on support_tickets yet — adding one is
      // a future migration. For now we tag in the first message.
    })
    .select("id")
    .single();

  if (tErr || !ticket?.id) {
    console.error("[portal/message] ticket insert failed", tErr);
    redirect(
      `/customer-portal/${token}/messages?error=${encodeURIComponent("could_not_open_ticket")}`,
    );
  }

  const ticketId = ticket.id;

  const { error: mErr } = await admin
    .from("support_messages" as never)
    .insert({
      ticket_id: ticketId,
      org_id: customer.org_id,
      author_id: null,
      author_kind: "customer",
      internal: false,
      body: `[Portal message from ${customer.name}]\n\n${body}`,
    } as never);

  if (mErr) {
    console.error("[portal/message] message insert failed", mErr);
    redirect(
      `/customer-portal/${token}/messages?error=${encodeURIComponent("could_not_send")}`,
    );
  }

  // Audit log so HQ sees "customer X opened ticket Y via portal".
  await recordAdminActivity({
    actorId: null,
    actorEmail: customer.email ?? null,
    action: "portal.message.sent",
    targetTable: "support_tickets",
    targetId: ticketId,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      customer_name: customer.name,
      source: "customer_portal",
    },
  });

  revalidatePath(`/customer-portal/${token}/messages`);
  // Touch the relevant HQ + tenant inboxes so they see the new ticket.
  revalidatePath(`/admin/support`);
  revalidatePath(`/support`);
  // Silence noise: `org` only used for typing.
  void org;
  redirect(`/customer-portal/${token}/messages?saved=sent`);
}
