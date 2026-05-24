"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { MILESTONE_IDS, type MilestoneId } from "@/lib/retention/signals";

/**
 * Server action — mark a milestone as celebrated so the dashboard
 * stops re-surfacing it. Idempotent. State lives in
 * organizations.onboarding_state.celebrated_milestones[] (no new
 * column).
 */
export async function dismissMilestone(formData: FormData): Promise<void> {
  const id = String(formData.get("milestone_id") ?? "");
  if (!(MILESTONE_IDS as ReadonlyArray<string>).includes(id)) return;

  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data } = await supabase
    .from("organizations")
    .select("onboarding_state")
    .eq("id", ctx.org.id)
    .maybeSingle();
  const state = ((data?.onboarding_state ?? {}) as Record<string, unknown>) ?? {};
  const existing = Array.isArray(state.celebrated_milestones)
    ? (state.celebrated_milestones as string[])
    : [];
  if (existing.includes(id)) {
    // Already celebrated. Nothing to do.
    revalidatePath("/dashboard");
    return;
  }

  const next = {
    ...state,
    celebrated_milestones: [...existing, id as MilestoneId],
  };
  await supabase
    .from("organizations")
    .update({ onboarding_state: next as never })
    .eq("id", ctx.org.id);
  revalidatePath("/dashboard");
}
