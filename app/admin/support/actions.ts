"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireHq } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import {
  notifyOnSupportReplyToCustomer,
  notifyOnSupportStatusChanged,
  notifyOnSupportPriorityUrgent,
} from "@/lib/notifications/events";
import {
  SUPPORT_STATUSES,
  SUPPORT_PRIORITIES,
  SUPPORT_CATEGORIES,
} from "@/lib/hq/support";

/**
 * HQ-side support actions (HQ-7).
 *
 * All actions:
 *   1. Re-check isSuperAdminEmail (defence in depth).
 *   2. Use the service-role admin client (bypasses RLS by design —
 *      HQ sees every tenant).
 *   3. Write a row to admin_activity_log via recordAdminActivity so
 *      both /admin/customers/<id> + /admin/support/<id> render the
 *      action on their timelines.
 */

const ticketIdSchema = z.string().uuid();

// --------------------------------------------------------------------
// Reply (customer-visible OR internal note)
// --------------------------------------------------------------------

const replySchema = z.object({
  ticket_id: ticketIdSchema,
  body: z.string().trim().min(1).max(10_000),
  internal: z.enum(["true", "false"]).default("false"),
});

export async function replyAsHq(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = replySchema.safeParse({
    ticket_id: formData.get("ticket_id"),
    body: formData.get("body"),
    internal: formData.get("internal") ?? "false",
  });
  if (!parsed.success) redirect(`/admin/support?error=invalid_input`);

  const supabase = createAdminClient();
  // We need the org_id to denorm into the message row.
  const { data: ticket } = await supabase
    .from("support_tickets" as never)
    .select("org_id" as never)
    .eq("id", parsed.data.ticket_id)
    .maybeSingle();
  if (!ticket) {
    redirect(`/admin/support?error=ticket_not_found`);
  }
  const orgId = (ticket as unknown as { org_id: string }).org_id;

  const isInternal = parsed.data.internal === "true";
  const { error: mErr } = await supabase
    .from("support_messages" as never)
    .insert({
      ticket_id: parsed.data.ticket_id,
      org_id: orgId,
      author_id: admin.id,
      author_kind: "hq",
      internal: isInternal,
      body: parsed.data.body,
    } as unknown as never);
  if (mErr) {
    console.error("[admin-support] replyAsHq failed", mErr);
    redirect(`/admin/support/${parsed.data.ticket_id}?error=reply_failed`);
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: isInternal ? "support.internal_note" : "support.hq_reply",
    targetTable: "support_tickets",
    targetId: parsed.data.ticket_id,
    metadata: {
      org_id: orgId,
      internal: isInternal,
      body_preview: parsed.data.body.slice(0, 200),
    },
  });

  // Also write a per-org audit row so /admin/customers/<id> shows the
  // ticket activity on the customer timeline.
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: isInternal ? "support.internal_note" : "support.hq_reply",
    targetTable: "organizations",
    targetId: orgId,
    metadata: {
      ticket_id: parsed.data.ticket_id,
      internal: isInternal,
    },
  });

  // Notify the customer of the HQ reply (skipped for internal notes —
  // those are HQ-only by definition).
  if (!isInternal) {
    // Pull ticket subject + number so the notification body is
    // useful. Best-effort — failure to fetch shouldn't break the
    // reply.
    const { data: tRow } = await supabase
      .from("support_tickets" as never)
      .select("subject, ticket_number" as never)
      .eq("id" as never, parsed.data.ticket_id)
      .maybeSingle();
    const ticketInfo = tRow as unknown as {
      subject?: string;
      ticket_number?: number;
    } | null;
    await emitNotifications(
      notifyOnSupportReplyToCustomer({
        org_id: orgId,
        ticket_id: parsed.data.ticket_id,
        ticket_number: ticketInfo?.ticket_number ?? 0,
        subject: ticketInfo?.subject ?? "Your ticket",
        body_preview: parsed.data.body.slice(0, 200),
      }),
    );
  }

  revalidatePath(`/admin/support/${parsed.data.ticket_id}`);
  revalidatePath(`/admin/support`);
  revalidatePath(`/admin/customers/${orgId}`);
  redirect(`/admin/support/${parsed.data.ticket_id}?saved=reply`);
}

// --------------------------------------------------------------------
// Status / priority / category / assignment
// --------------------------------------------------------------------

const statusSchema = z.object({
  ticket_id: ticketIdSchema,
  status: z.enum(SUPPORT_STATUSES),
});

export async function setTicketStatus(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = statusSchema.safeParse({
    ticket_id: formData.get("ticket_id"),
    status: formData.get("status"),
  });
  if (!parsed.success) redirect(`/admin/support?error=invalid_input`);

  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: parsed.data.status };
  if (parsed.data.status === "resolved") patch.resolved_at = now;
  if (parsed.data.status === "closed") patch.closed_at = now;
  if (parsed.data.status === "open" || parsed.data.status === "in_progress") {
    patch.resolved_at = null;
    patch.closed_at = null;
  }

  const { error, data } = await supabase
    .from("support_tickets" as never)
    .update(patch as never)
    .eq("id", parsed.data.ticket_id)
    .select("org_id, ticket_number" as never)
    .maybeSingle();
  if (error) {
    console.error("[admin-support] setTicketStatus failed", error);
    redirect(`/admin/support/${parsed.data.ticket_id}?error=status_failed`);
  }
  const row = data as unknown as {
    org_id: string;
    ticket_number: number;
  } | null;
  const orgId = row?.org_id ?? null;

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "support.status_changed",
    targetTable: "support_tickets",
    targetId: parsed.data.ticket_id,
    metadata: { new_status: parsed.data.status, org_id: orgId },
  });
  if (orgId) {
    await recordAdminActivity({
      actorId: admin.id,
      actorEmail: admin.email,
      action: "support.status_changed",
      targetTable: "organizations",
      targetId: orgId,
      metadata: { ticket_id: parsed.data.ticket_id, new_status: parsed.data.status },
    });
    // Notify the customer of the status change.
    await emitNotifications(
      notifyOnSupportStatusChanged({
        org_id: orgId,
        ticket_id: parsed.data.ticket_id,
        ticket_number: row?.ticket_number ?? 0,
        new_status: parsed.data.status,
      }),
    );
  }
  revalidatePath(`/admin/support/${parsed.data.ticket_id}`);
  revalidatePath(`/admin/support`);
  redirect(`/admin/support/${parsed.data.ticket_id}?saved=status`);
}

const prioritySchema = z.object({
  ticket_id: ticketIdSchema,
  priority: z.enum(SUPPORT_PRIORITIES),
});

export async function setTicketPriority(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = prioritySchema.safeParse({
    ticket_id: formData.get("ticket_id"),
    priority: formData.get("priority"),
  });
  if (!parsed.success) redirect(`/admin/support?error=invalid_input`);
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("support_tickets" as never)
    .update({ priority: parsed.data.priority } as never)
    .eq("id", parsed.data.ticket_id)
    .select("org_id, ticket_number, subject" as never)
    .maybeSingle();
  const row = data as unknown as {
    org_id: string;
    ticket_number: number;
    subject: string;
  } | null;
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "support.priority_changed",
    targetTable: "support_tickets",
    targetId: parsed.data.ticket_id,
    metadata: { new_priority: parsed.data.priority },
  });
  // Urgent priority pings HQ as a separate, loud notification.
  if (parsed.data.priority === "urgent" && row) {
    await emitNotifications(
      notifyOnSupportPriorityUrgent({
        org_id: row.org_id,
        ticket_id: parsed.data.ticket_id,
        ticket_number: row.ticket_number,
        subject: row.subject,
      }),
    );
  }
  revalidatePath(`/admin/support/${parsed.data.ticket_id}`);
  revalidatePath(`/admin/support`);
  redirect(`/admin/support/${parsed.data.ticket_id}?saved=priority`);
}

const categorySchema = z.object({
  ticket_id: ticketIdSchema,
  category: z.enum(SUPPORT_CATEGORIES),
});

export async function setTicketCategory(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = categorySchema.safeParse({
    ticket_id: formData.get("ticket_id"),
    category: formData.get("category"),
  });
  if (!parsed.success) redirect(`/admin/support?error=invalid_input`);
  const supabase = createAdminClient();
  await supabase
    .from("support_tickets" as never)
    .update({ category: parsed.data.category } as never)
    .eq("id", parsed.data.ticket_id);
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "support.category_changed",
    targetTable: "support_tickets",
    targetId: parsed.data.ticket_id,
    metadata: { new_category: parsed.data.category },
  });
  revalidatePath(`/admin/support/${parsed.data.ticket_id}`);
  revalidatePath(`/admin/support`);
  redirect(`/admin/support/${parsed.data.ticket_id}?saved=category`);
}

const assignSchema = z.object({
  ticket_id: ticketIdSchema,
  // empty string = unassign
  assigned_to: z.string().uuid().or(z.literal("")),
});

export async function assignTicket(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = assignSchema.safeParse({
    ticket_id: formData.get("ticket_id"),
    assigned_to: formData.get("assigned_to") ?? "",
  });
  if (!parsed.success) redirect(`/admin/support?error=invalid_input`);
  const supabase = createAdminClient();
  const assignedTo =
    parsed.data.assigned_to === "" ? null : parsed.data.assigned_to;
  await supabase
    .from("support_tickets" as never)
    .update({ assigned_to: assignedTo } as never)
    .eq("id", parsed.data.ticket_id);
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "support.assigned",
    targetTable: "support_tickets",
    targetId: parsed.data.ticket_id,
    metadata: { assigned_to: assignedTo },
  });
  revalidatePath(`/admin/support/${parsed.data.ticket_id}`);
  revalidatePath(`/admin/support`);
  redirect(`/admin/support/${parsed.data.ticket_id}?saved=assign`);
}
