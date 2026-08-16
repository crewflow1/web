"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { convertDestination } from "@/server/services/assistant-review";

/**
 * Reviewer actions for the WhatsApp assistant pending_review queue (MP Wave R4).
 *
 * A HUMAN resolves each queued draft: CONVERT (hand it to the real, session-bound
 * variation/task writer via a deep link — the doctrine forbids the AI committing
 * work, so the operator prices + submits the actual domain write) or DISMISS.
 *
 * Human-approved AND org-pinned: the update rides the USER-JWT client (RLS gates
 * the tenant boundary) with an explicit `.eq("org_id", ctx.org.id)` ACTIVE-org
 * pin (RLS admits every org the caller belongs to, so without the pin a dual-org
 * member could resolve another of their orgs' queue), and only transitions a row
 * still in `pending_review` (`.eq("status","pending_review")`) so a double-submit
 * or a race can never re-resolve a settled item.
 */

const idSchema = z.string().uuid();
const decisionSchema = z.enum(["convert", "dismiss"]);

export async function resolveAssistantAction(
  id: string,
  formData: FormData,
): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/inbox/review?error=bad_id");

  const decision = decisionSchema.safeParse(formData.get("decision"));
  if (!decision.success) redirect("/inbox/review?error=bad_decision");

  const note = (formData.get("note") ?? "").toString().slice(0, 2000) || null;
  const nextStatus = decision.data === "convert" ? "converted" : "dismissed";

  const supabase = await createClient();
  type Upd = PromiseLike<{
    data: Array<{ action_type: string; target_table: string | null; target_id: string | null }> | null;
    error: { message: string } | null;
  }> & {
    eq: (k: string, v: unknown) => Upd;
    select: (cols: string) => Upd;
  };
  const { data, error } = await (
    supabase.from("whatsapp_assistant_actions" as never) as unknown as {
      update: (row: unknown) => Upd;
    }
  )
    .update({
      status: nextStatus,
      review_resolution: decision.data,
      review_note: note,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .eq("status", "pending_review")
    .select("action_type, target_table, target_id");

  if (error) {
    console.error("[assistant-review] resolve failed", error);
    redirect("/inbox/review?error=update_failed");
  }

  const row = data?.[0];
  // No row updated ⇒ already resolved or not in this org — nothing to do.
  if (!row) redirect("/inbox/review?error=already_resolved");

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: `whatsapp_assistant_action.${decision.data}`,
    targetTable: "whatsapp_assistant_actions",
    targetId: id,
    metadata: { action_type: row.action_type, decision: decision.data },
  });

  revalidatePath("/inbox/review");

  if (decision.data === "convert") {
    const jobId = row.target_table === "jobs" ? row.target_id : null;
    redirect(convertDestination({ action_type: row.action_type, job_id: jobId }));
  }
  redirect("/inbox/review");
}
