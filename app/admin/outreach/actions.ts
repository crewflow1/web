"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { runOutreachTask, startOutreach } from "@/server/services/hq-outreach";

/**
 * CrewFlow HQ — Outreach AI launcher actions (CEO Directive 010, Phase 4).
 *
 * The FIRST callers of the code-complete `startOutreach` runner entry point
 * (server/services/hq-outreach.ts) — the runner shipped with no UI, so the
 * capability was built but unreachable. HQ operator only: both actions
 * re-check isSuperAdminEmail (defence in depth — the /admin layout already
 * 404s everyone else via requireHqPage) and audit the launch to
 * admin_activity_log, mirroring the Research/Qualification launcher actions.
 *
 * DRAFT ONLY, honestly dark: the enqueued `generate_email` task produces an
 * immutable hq_drafts artifact for a human to review — nothing is ever sent
 * from here. While the LLM tier is unbound the Draft Engine's deterministic
 * fallback produces the draft (provenance 'deterministic'), which the section
 * page displays as exactly that. After enqueueing we drive the queue once
 * (claim-one-and-exit, atomic + idempotent — a concurrent cron kick is
 * harmless) so the operator sees a finished draft on return, not a stuck
 * "queued" row waiting for the next cron tick.
 */

export type OutreachFormState = { error: string | null };

function strOf(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

async function requireAdmin(): Promise<{ id: string; email: string | null }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? null };
}

async function launchOutreach(
  admin: { id: string; email: string | null },
  companyId: string,
  source: string,
): Promise<string | null> {
  const result = await startOutreach(
    { companyId },
    { id: admin.id, email: admin.email },
  );
  if (!result.ok) return result.error;

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "outreach.start",
    targetTable: "hq_ai_tasks",
    targetId: result.taskId,
    metadata: { company_id: result.companyId, source },
  });

  // Drive the queue once so the draft exists when the section page re-renders.
  // Best-effort: a failure here is already recorded on the task + timeline and
  // shows in the runs list — never block the redirect on it.
  try {
    await runOutreachTask(result.taskId);
  } catch (e) {
    console.error("[admin/outreach] run kick failed", e);
  }
  return null;
}

/** The launcher form (useActionState): draft outreach for a chosen company. */
export async function draftOutreachAction(
  _prev: OutreachFormState,
  formData: FormData,
): Promise<OutreachFormState> {
  const admin = await requireAdmin();

  const companyId = strOf(formData, "company_id");
  if (!companyId) {
    return { error: "Choose a company to draft outreach for." };
  }

  const error = await launchOutreach(admin, companyId, "launcher");
  if (error) return { error };

  redirect("/admin/outreach");
}

/** One-click "Draft outreach" for a listed qualified company. */
export async function draftOutreachForCompanyAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const companyId = strOf(formData, "company_id");
  if (!companyId) redirect("/admin/outreach");

  const error = await launchOutreach(admin, companyId, "company_row");
  if (error) {
    redirect(`/admin/outreach?error=${encodeURIComponent(error)}`);
  }
  redirect("/admin/outreach");
}
