"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";

/**
 * Phase A — Inbox actions.
 *
 * The inbound_enquiries table is populated by /api/receptionist/inbound
 * (Twilio / WhatsApp / Meta adapters). Operators see the rows in /inbox
 * and can:
 *   - mark `ignored` (spam / wrong number)
 *   - mark `qualified` if a lead was already created (or trigger a
 *     follow-up call)
 *
 * RLS lets every org member read the table; updates go via the user
 * client so the same policy gates writes.
 */

const idSchema = z.string().uuid();
const statusSchema = z.enum(["received", "processed", "qualified", "ignored", "failed"]);

export async function markEnquiryStatus(
  id: string,
  formData: FormData,
): Promise<void> {
  const { user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/inbox?error=bad_id");

  const parsed = statusSchema.safeParse(formData.get("status"));
  if (!parsed.success) redirect("/inbox?error=bad_status");

  const supabase = await createClient();
  const { error } = await (
    supabase.from("inbound_enquiries" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
      };
    }
  )
    .update({
      status: parsed.success ? parsed.data : "received",
      processed_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    console.error("[inbox] status update failed", error);
    redirect("/inbox?error=update_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "inbound_enquiry.status_changed",
    targetTable: "inbound_enquiries",
    targetId: id,
    metadata: { status: parsed.success ? parsed.data : "received" },
  });

  revalidatePath("/inbox");
  redirect("/inbox");
}
