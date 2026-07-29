"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContext } from "@/server/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import type { DismissedStepsJson } from "@/server/services/onboarding-snapshot";
import type { ChecklistStepId } from "@/lib/onboarding/checklist";

const KNOWN_STEPS: ReadonlyArray<ChecklistStepId> = [
  "company_profile",
  "logo",
  "vat",
  "bank",
  "terms",
  "staff",
  "customers",
  "imports",
  "invoices_import",
  "first_quote",
];

/**
 * Mark an optional setup-checklist step as dismissed for the caller's
 * org. Required steps cannot be dismissed (validated at the schema
 * level — unknown ids are silently dropped).
 *
 * Persists into organizations.onboarding_state.dismissed_steps[] —
 * keeping all other keys (`company: true` etc.) untouched.
 */
export async function dismissChecklistStep(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const stepId = String(formData.get("step_id") ?? "");
  if (!KNOWN_STEPS.includes(stepId as ChecklistStepId)) return;

  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("organizations")
    .select("onboarding_state")
    .eq("id", ctx.org.id)
    .maybeSingle();
  // A failed read must never fall through to the update below with an empty
  // state — that would clobber every other onboarding_state key.
  if (error) throw readFailure("dashboard: onboarding state (dismiss step)", error);

  const current = (row?.onboarding_state ?? {}) as DismissedStepsJson;
  const existing = Array.isArray(current.dismissed_steps)
    ? current.dismissed_steps
    : [];
  const next = existing.includes(stepId) ? existing : [...existing, stepId];

  await admin
    .from("organizations")
    .update({ onboarding_state: { ...current, dismissed_steps: next } })
    .eq("id", ctx.org.id);

  revalidatePath("/dashboard");
}
