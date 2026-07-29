"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import {
  notifyOnSupportReplyToHq,
} from "@/lib/notifications/events";
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

  // Which conversation is this? The same action serves both:
  //   customer_id IS NULL     → this org talking to CrewFlow HQ. The org is
  //                             CrewFlow's customer, so 'customer' is correct
  //                             and HQ should be notified. Unchanged.
  //   customer_id IS NOT NULL → this org talking to its OWN customer via the
  //                             portal. Here 'customer' means the homeowner,
  //                             so stamping it made the org's reply render as
  //                             the homeowner's own message — and pinged
  //                             CrewFlow about a conversation it isn't part of.
  // A foreign ticket_id must resolve to no row so we fail closed rather than
  // guessing an actor. RLS alone does NOT achieve that: `support_tickets`'
  // policy is `org_id in current_org_ids()`, which admits every org the caller
  // belongs to, so a dual-org member working in org A could post a reply into
  // org B's ticket thread — the message row stamped `org_id: ctx.org.id` (A)
  // while hanging off B's ticket, and, for an HQ thread, an HQ notification
  // carrying B's ticket number and subject line attributed to A. Hence the
  // explicit ACTIVE-org pin.
  const { data: tRow } = await supabase
    .from("support_tickets" as never)
    .select("subject, ticket_number, customer_id" as never)
    .eq("id" as never, parsed.data.ticket_id)
    .eq("org_id" as never, ctx.membership.org_id as never)
    .maybeSingle();
  const tInfo = tRow as unknown as {
    subject?: string;
    ticket_number?: number;
    customer_id?: string | null;
  } | null;
  if (!tInfo) {
    redirect(`/support?error=not_found`);
  }
  const isCustomerThread = tInfo.customer_id != null;

  const { error: mErr } = await supabase
    .from("support_messages" as never)
    .insert({
      ticket_id: parsed.data.ticket_id,
      org_id: ctx.membership.org_id,
      author_id: user.id,
      author_kind: isCustomerThread ? "org" : "customer",
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
    action: isCustomerThread ? "support.org_reply" : "support.customer_reply",
    targetTable: "support_tickets",
    targetId: parsed.data.ticket_id,
    metadata: {
      org_id: ctx.membership.org_id,
      ...(isCustomerThread ? { customer_id: tInfo.customer_id } : {}),
    },
  });

  // Notify HQ that the customer replied — high priority, drives the
  // "needs attention" sort on /admin/support.
  //
  // Only for the CrewFlow helpdesk conversation. notifyOnSupportReplyToHq
  // targets CrewFlow HQ, which is not a party to an org↔customer thread —
  // firing it there would page CrewFlow every time a builder answered their own
  // homeowner. This mirrors the portal's own reply action, which audits and
  // revalidates but deliberately emits no HQ notification.
  if (!isCustomerThread) {
    await emitNotifications(
      notifyOnSupportReplyToHq({
        org_id: ctx.membership.org_id,
        ticket_id: parsed.data.ticket_id,
        ticket_number: tInfo.ticket_number ?? 0,
        subject: tInfo.subject ?? "Ticket reply",
        body_preview: parsed.data.body.slice(0, 200),
      }),
    );
  }

  revalidatePath(`/support/${parsed.data.ticket_id}`);
  revalidatePath(`/support`);
  // The customer's own portal view of this thread must pick the reply up.
  revalidatePath(`/customer-portal`, "layout");
  redirect(`/support/${parsed.data.ticket_id}?saved=reply`);
}
