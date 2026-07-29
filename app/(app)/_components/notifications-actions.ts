"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";

const uuid = z.string().uuid();

/**
 * Notification read-state actions.
 *
 * Both are pinned to the ACTIVE org as well as the caller's user id.
 * `notifications` carries an `org_id` (20260527000000_notifications.sql) and
 * the bell in app/(app)/layout.tsx reads it pinned to `ctx.org.id` (#468) — so
 * the list the user is looking at is one company's. These actions previously
 * took only the signed-in identity and scoped by `user_id` alone, which for a
 * dual-org member spans BOTH companies: "mark all read" silently cleared the
 * OTHER company's unread badge, and the notices behind it were never seen.
 * Low harm, same class as the rest of the write slice.
 */

/** Mark the caller's unread notifications in the ACTIVE org as read. */
export async function markNotificationsRead() {
  const { ctx, user } = await requireOrgContext();
  const supabase = await createClient();
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("org_id", ctx.org.id)
    .is("read_at", null);
  revalidatePath("/", "layout");
}

/** Mark a single notification read (e.g. user clicked through). */
export async function markOneNotificationRead(id: string) {
  if (!uuid.safeParse(id).success) return;
  const { ctx, user } = await requireOrgContext();
  const supabase = await createClient();
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("org_id", ctx.org.id)
    .eq("id", id);
  revalidatePath("/", "layout");
}
