"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireHq } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  aiReceptionistChecklistSchema,
  aiReceptionistNotesSchema,
  aiReceptionistStatusSchema,
} from "@/lib/ai-receptionist/schema";

/**
 * HQ-side AI receptionist setup actions.
 *
 *   - setStatus      → move not_started → in_progress → testing → live
 *   - toggleChecklist → stamp / clear a test_*_at timestamp
 *   - updateNotes    → set hq_notes free-text
 *   - markConfigured → shortcut: status=live + configured_at/by
 *
 * Every action audits via recordAdminActivity and revalidates both the
 * HQ list page and the customer-facing settings page.
 */

export async function setAiReceptionistStatus(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = aiReceptionistStatusSchema.safeParse({
    id: formData.get("id"),
    status: formData.get("status"),
  });
  if (!parsed.success) {
    redirect("/admin/ai-receptionist?error=invalid_input");
  }

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { status: parsed.data?.status };
  // Moving to 'live' implicitly stamps configured_at/configured_by.
  if (parsed.data?.status === "live") {
    update.configured_at = now;
    update.configured_by = admin.id;
  }
  // Moving away from 'live' clears the configured stamp so it&rsquo;s clear
  // the setup isn&rsquo;t verified end-to-end.
  if (parsed.data?.status !== "live") {
    update.configured_at = null;
    update.configured_by = null;
  }

  const { error, data } = await (
    supabase.from("ai_receptionist_setups" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => {
          select: (cols: string) => {
            single: () => Promise<{
              data: { org_id: string } | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    }
  )
    .update(update)
    .eq("id", parsed.data!.id)
    .select("org_id")
    .single();

  if (error) {
    console.error("[admin/ai-receptionist] setStatus failed", error);
    redirect(`/admin/ai-receptionist/${parsed.data!.id}?error=update_failed`);
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: `ai_receptionist.status_${parsed.data!.status}`,
    targetTable: "ai_receptionist_setups",
    targetId: parsed.data!.id,
    metadata: {
      status: parsed.data!.status,
      org_id: data?.org_id ?? null,
    },
  });

  revalidatePath("/admin/ai-receptionist");
  revalidatePath(`/admin/ai-receptionist/${parsed.data!.id}`);
  revalidatePath("/settings");
  revalidatePath("/settings/ai-receptionist");
  redirect(`/admin/ai-receptionist/${parsed.data!.id}?saved=status`);
}

export async function toggleAiReceptionistChecklist(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = aiReceptionistChecklistSchema.safeParse({
    id: formData.get("id"),
    key: formData.get("key"),
    toggle: formData.get("toggle"),
  });
  if (!parsed.success) {
    redirect("/admin/ai-receptionist?error=invalid_input");
  }

  const supabase = createAdminClient();
  const now = parsed.data!.toggle === "true" ? new Date().toISOString() : null;

  const update: Record<string, unknown> = { [parsed.data!.key]: now };

  const { error, data } = await (
    supabase.from("ai_receptionist_setups" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => {
          select: (cols: string) => {
            single: () => Promise<{
              data: { org_id: string } | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    }
  )
    .update(update)
    .eq("id", parsed.data!.id)
    .select("org_id")
    .single();

  if (error) {
    console.error("[admin/ai-receptionist] checklist toggle failed", error);
    redirect(`/admin/ai-receptionist/${parsed.data!.id}?error=update_failed`);
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: `ai_receptionist.${parsed.data!.key}.${parsed.data!.toggle === "true" ? "checked" : "unchecked"}`,
    targetTable: "ai_receptionist_setups",
    targetId: parsed.data!.id,
    metadata: {
      key: parsed.data!.key,
      stamped_at: now,
      org_id: data?.org_id ?? null,
    },
  });

  revalidatePath(`/admin/ai-receptionist/${parsed.data!.id}`);
  revalidatePath("/admin/ai-receptionist");
  revalidatePath("/settings/ai-receptionist");
  redirect(`/admin/ai-receptionist/${parsed.data!.id}?saved=checklist`);
}

export async function updateAiReceptionistNotes(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = aiReceptionistNotesSchema.safeParse({
    id: formData.get("id"),
    hq_notes: formData.get("hq_notes") ?? "",
  });
  if (!parsed.success) {
    redirect("/admin/ai-receptionist?error=invalid_input");
  }

  const supabase = createAdminClient();

  const { error } = await (
    supabase.from("ai_receptionist_setups" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
      };
    }
  )
    .update({ hq_notes: parsed.data?.hq_notes ?? null })
    .eq("id", parsed.data!.id);

  if (error) {
    console.error("[admin/ai-receptionist] updateNotes failed", error);
    redirect(`/admin/ai-receptionist/${parsed.data!.id}?error=update_failed`);
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "ai_receptionist.notes_updated",
    targetTable: "ai_receptionist_setups",
    targetId: parsed.data!.id,
    metadata: { length: (parsed.data?.hq_notes ?? "").length },
  });

  revalidatePath(`/admin/ai-receptionist/${parsed.data!.id}`);
  redirect(`/admin/ai-receptionist/${parsed.data!.id}?saved=notes`);
}

/**
 * Shortcut: move status=live + stamp configured_at/by. Useful once all
 * 6 checklist items are ticked. Equivalent to calling setStatus with
 * status='live' but mounted on a separate button for clarity.
 */
export async function markAiReceptionistConfigured(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const id = String(formData.get("id") ?? "");
  if (!id.match(/^[0-9a-f-]{36}$/i)) {
    redirect("/admin/ai-receptionist?error=invalid_input");
  }

  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { error, data } = await (
    supabase.from("ai_receptionist_setups" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => {
          select: (cols: string) => {
            single: () => Promise<{
              data: { org_id: string } | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    }
  )
    .update({
      status: "live",
      configured_at: now,
      configured_by: admin.id,
    })
    .eq("id", id)
    .select("org_id")
    .single();

  if (error) {
    console.error("[admin/ai-receptionist] markConfigured failed", error);
    redirect(`/admin/ai-receptionist/${id}?error=update_failed`);
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "ai_receptionist.marked_configured",
    targetTable: "ai_receptionist_setups",
    targetId: id,
    metadata: { configured_at: now, org_id: data?.org_id ?? null },
  });

  revalidatePath("/admin/ai-receptionist");
  revalidatePath(`/admin/ai-receptionist/${id}`);
  revalidatePath("/settings");
  revalidatePath("/settings/ai-receptionist");
  redirect(`/admin/ai-receptionist/${id}?saved=configured`);
}
