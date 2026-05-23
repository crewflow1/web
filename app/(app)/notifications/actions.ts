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
 * RLS scopes everything to the user's org/account. Auth requires
 * an org context (uses requireOrgContext).
 */

const idSchema = z.object({ id: z.string().uuid() });

export async function markRead(formData: FormData): Promise<void> {
  await requireOrgContext();
  const parsed = idSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect("/notifications?error=invalid_input");
  await markNotificationRead(parsed.data.id, { audience: "customer" });
  revalidatePath("/notifications");
  redirect("/notifications");
}

export async function markAllRead(): Promise<void> {
  await requireOrgContext();
  await markAllNotificationsRead({ audience: "customer" });
  revalidatePath("/notifications");
  redirect("/notifications?saved=all_read");
}

export async function dismiss(formData: FormData): Promise<void> {
  await requireOrgContext();
  const parsed = idSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect("/notifications?error=invalid_input");
  await dismissNotification(parsed.data.id, { audience: "customer" });
  revalidatePath("/notifications");
  redirect("/notifications?saved=dismissed");
}
