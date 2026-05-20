"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";

const uuid = z.string().uuid();

/** Mark all the caller's unread notifications as read. */
export async function markNotificationsRead() {
  const user = await requireUser();
  const supabase = await createClient();
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("read_at", null);
  revalidatePath("/", "layout");
}

/** Mark a single notification read (e.g. user clicked through). */
export async function markOneNotificationRead(id: string) {
  if (!uuid.safeParse(id).success) return;
  const user = await requireUser();
  const supabase = await createClient();
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("id", id);
  revalidatePath("/", "layout");
}
