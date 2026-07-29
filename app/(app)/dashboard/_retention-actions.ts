"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  MILESTONE_IDS,
  type MilestoneId,
  type NudgeId,
} from "@/lib/retention/signals";

/** Stable nudge ids that can be dismissed. Keep in sync with the
 *  `NudgeId` union in lib/retention/signals.ts. */
const DISMISSIBLE_NUDGES: ReadonlyArray<NudgeId> = [
  "finish_onboarding",
  "add_first_customer",
  "create_first_quote",
  "send_first_invoice",
  "import_history",
  "chase_overdue",
  "upload_logo",
  "configure_tax",
  "add_staff",
  "reply_support",
  "review_alerts",
  "weekly_summary",
  "inactive_quote_drought_soft",
  "inactive_quote_drought",
  "complete_company_profile",
];

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

  const { data, error } = await supabase
    .from("organizations")
    .select("onboarding_state")
    .eq("id", ctx.org.id)
    .maybeSingle();
  // A failed read must never fall through to the update below with an empty
  // state — that would clobber every other onboarding_state key.
  if (error) throw readFailure("dashboard: onboarding state (dismiss milestone)", error);
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

/**
 * Phase 2 — dismiss a dashboard nudge. Writes the id to
 * organizations.onboarding_state.dismissed_nudges[]. Idempotent.
 * Required onboarding nudges (the ones the customer literally
 * can't work without) are NOT in DISMISSIBLE_NUDGES — the form
 * just rejects them silently.
 */
export async function dismissNudge(formData: FormData): Promise<void> {
  const id = String(formData.get("nudge_id") ?? "");
  if (!(DISMISSIBLE_NUDGES as ReadonlyArray<string>).includes(id)) return;

  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("onboarding_state")
    .eq("id", ctx.org.id)
    .maybeSingle();
  // Same read-modify-write hazard as dismissMilestone — throw before the write.
  if (error) throw readFailure("dashboard: onboarding state (dismiss nudge)", error);
  const state =
    ((data?.onboarding_state ?? {}) as Record<string, unknown>) ?? {};
  const existing = Array.isArray(state.dismissed_nudges)
    ? (state.dismissed_nudges as string[])
    : [];
  if (existing.includes(id)) {
    revalidatePath("/dashboard");
    return;
  }
  await supabase
    .from("organizations")
    .update({
      onboarding_state: {
        ...state,
        dismissed_nudges: [...existing, id as NudgeId],
      } as never,
    })
    .eq("id", ctx.org.id);
  revalidatePath("/dashboard");
}
