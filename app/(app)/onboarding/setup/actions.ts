"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  CHECKLIST_STEP_ORDER,
  type ChecklistStepId,
} from "@/lib/onboarding/checklist";

/**
 * Guided onboarding server actions.
 *
 * All state lives in `organizations.onboarding_state` (jsonb). We
 * never add new columns — the directive's "preserve existing
 * architecture" rule.
 *
 * Shape of the jsonb:
 *   {
 *     "dismissed_steps": ["logo", "imports"],   // skipped by user
 *     "started_at": "2026-05-24T15:00:00Z",     // first /onboarding/setup visit
 *     "completed_at": "2026-05-24T16:00:00Z"    // when pct first hit 100
 *     // ...other keys preserved
 *   }
 *
 * Idempotent: each action no-ops if the requested state is already set.
 */

function isValidStepId(id: string): id is ChecklistStepId {
  return (CHECKLIST_STEP_ORDER as ReadonlyArray<string>).includes(id);
}

async function readState(): Promise<Record<string, unknown>> {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("onboarding_state")
    .eq("id", ctx.org.id)
    .maybeSingle();
  const raw = data?.onboarding_state;
  return (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
}

async function writeState(next: Record<string, unknown>): Promise<void> {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  // The generated `Json` type doesn't accept `Record<string, unknown>`
  // directly (its union excludes wider object types). Cast through
  // `never` — the column is jsonb and accepts any object shape.
  await supabase
    .from("organizations")
    .update({ onboarding_state: next as never })
    .eq("id", ctx.org.id);
  revalidatePath("/onboarding/setup");
  revalidatePath("/dashboard");
}

/**
 * Mark `started_at` if not already set. Called best-effort from the
 * setup page itself on first render.
 */
export async function markStarted(): Promise<void> {
  const state = await readState();
  if (typeof state.started_at === "string") return;
  await writeState({ ...state, started_at: new Date().toISOString() });
}

/**
 * Mark `completed_at` when the operator hits 100%. Called from the
 * complete page (server component) so a refresh on /complete idempotently
 * stamps the timestamp once.
 */
export async function markCompleted(): Promise<void> {
  const state = await readState();
  if (typeof state.completed_at === "string") return;
  await writeState({ ...state, completed_at: new Date().toISOString() });
}

/**
 * Add a step id to `dismissed_steps`. Owners/admins only — the action
 * shape mirrors the existing dashboard checklist dismiss/restore.
 */
export async function skipStep(formData: FormData): Promise<void> {
  const id = String(formData.get("step_id") ?? "");
  if (!isValidStepId(id)) {
    redirect("/onboarding/setup?error=unknown_step");
  }
  const state = await readState();
  const existing = Array.isArray(state.dismissed_steps)
    ? (state.dismissed_steps as string[])
    : [];
  if (existing.includes(id)) {
    redirect("/onboarding/setup");
  }
  await writeState({
    ...state,
    dismissed_steps: [...existing, id],
  });
  redirect("/onboarding/setup?saved=skipped");
}

/**
 * Reverse a skip — bring a previously-dismissed step back.
 */
export async function unskipStep(formData: FormData): Promise<void> {
  const id = String(formData.get("step_id") ?? "");
  if (!isValidStepId(id)) {
    redirect("/onboarding/setup?error=unknown_step");
  }
  const state = await readState();
  const existing = Array.isArray(state.dismissed_steps)
    ? (state.dismissed_steps as string[])
    : [];
  if (!existing.includes(id)) {
    redirect("/onboarding/setup");
  }
  await writeState({
    ...state,
    dismissed_steps: existing.filter((s) => s !== id),
  });
  redirect("/onboarding/setup?saved=unskipped");
}
