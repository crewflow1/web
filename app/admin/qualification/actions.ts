"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { startQualification } from "@/server/services/hq-qualification";

/**
 * CrewFlow HQ — Lead Qualification launcher actions (CEO Directive 003, Module 3).
 *
 * HQ operator only. Both actions re-check isSuperAdminEmail (defence in depth —
 * the /admin layout already 404s everyone else) and audit the launch to
 * admin_activity_log. They do NOT run the rubric: they enqueue a qualify_company
 * task and redirect to the live run page, which kicks the worker from the
 * browser and polls progress. That keeps the operator on a fast, observable
 * path. Unlike Research AI there is no "create from a name" path here — a
 * company must already exist (and ideally be researched) before it can be
 * qualified.
 */

export type QualificationFormState = { error: string | null };

function strOf(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

async function requireAdmin(): Promise<{ id: string; email: string | null }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? null };
}

/**
 * The launcher form (useActionState): qualify an existing company chosen by id.
 */
export async function qualifyCompanyAction(
  _prev: QualificationFormState,
  formData: FormData,
): Promise<QualificationFormState> {
  const admin = await requireAdmin();

  const companyId = strOf(formData, "company_id");
  if (!companyId) {
    return { error: "Choose a company to qualify." };
  }

  const result = await startQualification(
    { companyId },
    { id: admin.id, email: admin.email },
  );
  if (!result.ok) return { error: result.error };

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "qualification.start",
    targetTable: "hq_sales_ai_tasks",
    targetId: result.taskId,
    metadata: { company_id: result.companyId, source: "launcher" },
  });

  redirect(`/admin/qualification/${result.taskId}`);
}

/**
 * One-click "Qualify this company" for an existing company record (e.g. from
 * the company page or the candidate list). Plain action — enqueue then redirect
 * to the live run.
 */
export async function qualifyExistingCompanyAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const companyId = strOf(formData, "company_id");
  if (!companyId) redirect("/admin/qualification");

  const result = await startQualification(
    { companyId },
    { id: admin.id, email: admin.email },
  );
  if (!result.ok) {
    redirect(`/admin/qualification?error=${encodeURIComponent(result.error)}`);
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "qualification.start",
    targetTable: "hq_sales_ai_tasks",
    targetId: result.taskId,
    metadata: { company_id: result.companyId, source: "company_page" },
  });

  redirect(`/admin/qualification/${result.taskId}`);
}
