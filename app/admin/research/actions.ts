"use server";

import { redirect } from "next/navigation";
import { requireHq } from "@/server/auth/hq";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { startResearch } from "@/server/services/hq-research";

/**
 * CrewFlow HQ — Research AI launcher actions (CEO Directive 005, Phase 1).
 *
 * HQ operator only. Both actions re-check isSuperAdminEmail (defence in depth —
 * the /admin layout already 404s everyone else) and audit the launch to
 * admin_activity_log. They do NOT run the pipeline: they enqueue a
 * research_company task and redirect to the live run page, which kicks the
 * worker from the browser and polls progress. That keeps the operator on a
 * fast, observable path instead of blocking on a 60s server action.
 */

export type ResearchFormState = { error: string | null };

function strOf(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/**
 * The launcher form (useActionState): research a brand-new prospect from a
 * name / website / Companies House number, creating the company record if it
 * doesn't exist yet.
 */
export async function researchCompanyAction(
  _prev: ResearchFormState,
  formData: FormData,
): Promise<ResearchFormState> {
  const admin = await requireHq();

  const companyId = strOf(formData, "company_id") || null;
  const name = strOf(formData, "name");
  const website = strOf(formData, "website");
  const companiesHouseNumber = strOf(formData, "companies_house_number");

  if (!companyId && !name && !website) {
    return { error: "Enter a company name or website to research." };
  }

  const result = await startResearch(
    { companyId, name, website, companiesHouseNumber },
    { id: admin.id, email: admin.email },
  );
  if (!result.ok) return { error: result.error };

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "research.start",
    targetTable: "hq_sales_ai_tasks",
    targetId: result.taskId,
    metadata: { company_id: result.companyId, source: "launcher" },
  });

  redirect(`/admin/research/${result.taskId}`);
}

/**
 * One-click "Research this company" for an existing company record (e.g. from
 * the company page). Plain action — enqueue then redirect to the live run.
 */
export async function researchExistingCompanyAction(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const companyId = strOf(formData, "company_id");
  if (!companyId) redirect("/admin/research");

  const result = await startResearch({ companyId }, { id: admin.id, email: admin.email });
  if (!result.ok) {
    redirect(`/admin/research?error=${encodeURIComponent(result.error)}`);
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "research.start",
    targetTable: "hq_sales_ai_tasks",
    targetId: result.taskId,
    metadata: { company_id: result.companyId, source: "company_page" },
  });

  redirect(`/admin/research/${result.taskId}`);
}
