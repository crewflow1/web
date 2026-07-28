"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgContext } from "@/server/auth/session";
import {
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
} from "@/server/services/notifications-service";

/**
 * Customer-side notification actions (HQ-8).
 *
 * Auth requires an org context (uses requireOrgContext), and every mutation
 * is pinned to the ACTIVE org.
 *
 * The header used to read "RLS scopes everything to the user's org/account".
 * It does not: `current_org_ids()` returns EVERY org the viewer belongs to, so
 * for a dual-org user these actions reached the other org's notification rows
 * — `markAllRead` most of all, since it carried no id and no org filter and
 * therefore cleared BOTH orgs' unread queues in one click. The org id is now
 * passed explicitly so the scope is visible here rather than assumed.
 */

const idSchema = z.object({ id: z.string().uuid() });

export async function markRead(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = idSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect("/notifications?error=invalid_input");
  await markNotificationRead(parsed.data.id, {
    audience: "customer",
    orgId: ctx.org.id,
  });
  revalidatePath("/notifications");
  redirect("/notifications");
}

export async function markAllRead(): Promise<void> {
  const { ctx } = await requireOrgContext();
  await markAllNotificationsRead({ audience: "customer", orgId: ctx.org.id });
  revalidatePath("/notifications");
  redirect("/notifications?saved=all_read");
}

export async function dismiss(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = idSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect("/notifications?error=invalid_input");
  await dismissNotification(parsed.data.id, {
    audience: "customer",
    orgId: ctx.org.id,
  });
  revalidatePath("/notifications");
  redirect("/notifications?saved=dismissed");
}
