"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  SUPPORT_CATEGORIES,
  SUPPORT_PRIORITIES,
} from "@/lib/hq/support";

/**
 * Customer-side support actions (HQ-7).
 *
 * Auth: requireOrgContext() → user has a session AND a confirmed
 * org membership. RLS on support_tickets / support_messages enforces
 * the org boundary at the DB layer; the actions just bind the user
 * identity onto the row.
 *
 * Both actions ALSO write to admin_activity_log via the service-role
 * helper so HQ sees the customer's actions in its timeline (the
 * directive's "Activity log on every ticket action" line).
 */

const createSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(10_000),
  priority: z.enum(SUPPORT_PRIORITIES).default("normal"),
  category: z.enum(SUPPORT_CATEGORIES).default("other"),
});

export async function createSupportTicket(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = createSchema.safeParse({
    subject: formData.get("subject"),
    body: formData.get("body"),
    priority: formData.get("priority") ?? "normal",
    category: formData.get("category") ?? "other",
  });
  if (!parsed.success) {
    redirect(
      `/support/new?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "invalid_input")}`,
    );
  }

  const supabase = await createClient();

  // 1. Create the ticket. RLS WITH CHECK + the BEFORE INSERT trigger
  //    assign ticket_number atomically.
  const { data: ticketRow, error: tErr } = await supabase
    .from("support_tickets" as never)
    .insert({
      org_id: ctx.membership.org_id,
      subject: parsed.data.subject,
      body: parsed.data.body, // unused on the table but kept for symmetry
      priority: parsed.data.priority,
      category: parsed.data.category,
      created_by: user.id,
      status: "open",
    } as unknown as never)
    .select("id, ticket_number" as never)
    .single();
  if (tErr || !ticketRow) {
    console.error("[customer-support] createSupportTicket failed", tErr);
    redirect("/support/new?error=create_failed");
  }
  const ticket = ticketRow as unknown as {
    id: string;
    ticket_number: number;
  };

  // 2. Seed the first message with the body so the thread isn't empty.
  const { error: mErr } = await supabase
    .from("support_messages" as never)
    .insert({
      ticket_id: ticket.id,
      org_id: ctx.membership.org_id,
      author_id: user.id,
      author_kind: "customer",
      internal: false,
      body: parsed.data.body,
    } as unknown as never);
  if (mErr) {
    console.error("[customer-support] seed message failed", mErr);
    // Don't redirect — ticket exists, the customer just won't see
    // their opening body. Better than losing the whole ticket.
  }

  // 3. Audit log on the HQ side so /admin/customers/<id> + the new
  //    /admin/support timeline both see "Customer raised ticket #N".
  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "support.ticket_created",
    targetTable: "support_tickets",
    targetId: ticket.id,
    metadata: {
      org_id: ctx.membership.org_id,
      ticket_number: ticket.ticket_number,
      priority: parsed.data.priority,
      category: parsed.data.category,
    },
  });

  revalidatePath("/support");
  redirect(`/support/${ticket.id}?saved=1`);
}

const replySchema = z.object({
  ticket_id: z.string().uuid(),
  body: z.string().trim().min(1).max(10_000),
});

export async function replyToSupportTicket(
  formData: FormData,
): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = replySchema.safeParse({
    ticket_id: formData.get("ticket_id"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    redirect(`/support?error=invalid_input`);
  }

  const supabase = await createClient();
  const { error: mErr } = await supabase
    .from("support_messages" as never)
    .insert({
      ticket_id: parsed.data.ticket_id,
      org_id: ctx.membership.org_id,
      author_id: user.id,
      author_kind: "customer",
      internal: false,
      body: parsed.data.body,
    } as unknown as never);
  if (mErr) {
    console.error("[customer-support] replyToSupportTicket failed", mErr);
    redirect(`/support/${parsed.data.ticket_id}?error=reply_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "support.customer_reply",
    targetTable: "support_tickets",
    targetId: parsed.data.ticket_id,
    metadata: { org_id: ctx.membership.org_id },
  });

  revalidatePath(`/support/${parsed.data.ticket_id}`);
  revalidatePath(`/support`);
  redirect(`/support/${parsed.data.ticket_id}?saved=reply`);
}
