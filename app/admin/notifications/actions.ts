"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireHq } from "@/server/auth/hq";
import {
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
} from "@/server/services/notifications-service";
import { recordAdminActivity } from "@/server/services/hq-audit";

/**
 * HQ-side notification actions (HQ-8).
 *
 * Service-role under the hood. Auth gate re-checks
 * isSuperAdminEmail. Every action writes admin_activity_log so the
 * action shows up on the audit timeline.
 */

const idSchema = z.object({ id: z.string().uuid() });

export async function markReadHq(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = idSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect("/admin/notifications?error=invalid_input");
  await markNotificationRead(parsed.data.id, { audience: "hq" });
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "notification.read",
    targetTable: "notifications",
    targetId: parsed.data.id,
    metadata: {},
  });
  revalidatePath("/admin/notifications");
  redirect("/admin/notifications");
}

export async function markAllReadHq(): Promise<void> {
  const admin = await requireHq();
  await markAllNotificationsRead({ audience: "hq" });
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "notification.all_read",
    targetTable: "notifications",
    targetId: "batch",
    metadata: {},
  });
  revalidatePath("/admin/notifications");
  redirect("/admin/notifications?saved=all_read");
}

export async function dismissHq(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = idSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect("/admin/notifications?error=invalid_input");
  await dismissNotification(parsed.data.id, { audience: "hq" });
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "notification.dismissed",
    targetTable: "notifications",
    targetId: parsed.data.id,
    metadata: {},
  });
  revalidatePath("/admin/notifications");
  redirect("/admin/notifications?saved=dismissed");
}
