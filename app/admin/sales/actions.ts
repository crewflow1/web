"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  addContact,
  addRecommendation,
  addResearchReport,
  createCompany,
  deleteContact,
  logInteraction,
  promoteResearchToMemory,
  setCompanyStatus,
  updateCompany,
  type CompanyWriteInput,
  type ContactWriteInput,
  type RecommendationWriteInput,
  type ResearchWriteInput,
  type TimelineWriteInput,
} from "@/server/services/hq-sales";
import {
  EVENT_DIRECTIONS,
  GENERATED_BY,
  INTERACTION_EVENT_TYPES,
  PIPELINE_STATUSES,
  RISK_LEVELS,
  SENIORITIES,
  clampScore,
  normalizeList,
  normalizeTags,
} from "@/lib/sales/model";

/**
 * CrewFlow HQ — Sales AI Platform, server actions (CEO Directive 003).
 *
 * HQ operator only. Every action re-checks isSuperAdminEmail — the
 * /admin/* layout already 404s non-allowlisted users, so this is
 * defence-in-depth against a request that reaches the action URL
 * directly. Each write is audited to admin_activity_log AND produces a
 * per-company timeline event inside the service (the company's own audit
 * trail). The two together mean every change — human or AI-attributed —
 * is fully traceable, per the directive's security mandate.
 *
 * FOUNDATION ONLY. No action here runs research or sends outreach; AI
 * attribution (`generated_by`, `model`, `ai_employee_id`) is recorded so
 * future autonomous work stays traceable, but humans drive every write.
 */

async function requireAdmin(): Promise<{ id: string; email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? "" };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9_]{1,60}$/;

// ---------------------------------------------------------------------
// FormData helpers (pure, defensive).
// ---------------------------------------------------------------------

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function nullableStr(formData: FormData, key: string, max: number): string | null {
  const v = str(formData, key);
  if (!v) return null;
  return v.length > max ? v.slice(0, max) : v;
}

function clip(formData: FormData, key: string, max: number): string {
  const v = str(formData, key);
  return v.length > max ? v.slice(0, max) : v;
}

/** Non-negative integer (whole GBP / counts), or null. Strips separators. */
function nullableInt(formData: FormData, key: string): number | null {
  const raw = str(formData, key).replace(/[,\s£]/g, "");
  if (!raw) return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function uuidOrNull(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  return UUID_RE.test(v) ? v : null;
}

function bool(formData: FormData, key: string): boolean {
  const v = str(formData, key);
  return v === "on" || v === "true" || v === "1";
}

/** A `datetime-local` value → ISO string, or null when blank/invalid. */
function parseOccurredAt(formData: FormData): string | null {
  const v = str(formData, "occurred_at");
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

// ---------------------------------------------------------------------
// Company create / update.
// ---------------------------------------------------------------------

const companyCore = z.object({
  name: z.string().trim().min(1).max(300),
  status: z.enum(PIPELINE_STATUSES),
  source: z.string().regex(SLUG_RE),
});

function buildCompanyInput(
  formData: FormData,
):
  | { ok: true; value: CompanyWriteInput }
  | { ok: false } {
  const parsed = companyCore.safeParse({
    name: formData.get("name"),
    status: formData.get("status"),
    source: formData.get("source"),
  });
  if (!parsed.success) return { ok: false };
  const d = parsed.data;

  return {
    ok: true,
    value: {
      name: d.name,
      summary: clip(formData, "summary", 4000),
      website: nullableStr(formData, "website", 500),
      industry: nullableStr(formData, "industry", 160),
      employeeCount: nullableInt(formData, "employee_count"),
      annualTurnoverGbp: nullableInt(formData, "annual_turnover_gbp"),
      location: nullableStr(formData, "location", 300),
      region: nullableStr(formData, "region", 160),
      county: nullableStr(formData, "county", 160),
      country: nullableStr(formData, "country", 120) ?? "United Kingdom",
      primaryEmail: nullableStr(formData, "primary_email", 320),
      primaryPhone: nullableStr(formData, "primary_phone", 60),
      linkedinUrl: nullableStr(formData, "linkedin_url", 500),
      instagramUrl: nullableStr(formData, "instagram_url", 500),
      facebookUrl: nullableStr(formData, "facebook_url", 500),
      companiesHouseUrl: nullableStr(formData, "companies_house_url", 500),
      companiesHouseNumber: nullableStr(formData, "companies_house_number", 40),
      websiteTechnology: normalizeList(str(formData, "website_technology")),
      crmScore: clampScore(formData.get("crm_score")),
      aiQualificationScore: clampScore(formData.get("ai_qualification_score")),
      estimatedDealValueGbp: nullableInt(formData, "estimated_deal_value_gbp"),
      status: d.status,
      source: d.source,
      assignedToEmail: nullableStr(formData, "assigned_to_email", 320),
      tags: normalizeTags(str(formData, "tags")),
    },
  };
}

export async function createCompanyAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const built = buildCompanyInput(formData);
  if (!built.ok) {
    fail("/admin/sales/companies/new", "Company name, status and source are required.");
  }

  const result = await createCompany(built.value, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail("/admin/sales/companies/new", result.error || "Couldn't save company.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.company_created",
    targetTable: "hq_sales_companies",
    targetId: result.id,
    metadata: {
      name: built.value.name,
      status: built.value.status,
      source: built.value.source,
    },
  });

  revalidatePath("/admin/sales");
  revalidatePath("/admin/sales/companies");
  revalidatePath("/admin/sales/activity");
  revalidatePath(`/admin/sales/companies/${result.id}`);
  redirect(`/admin/sales/companies/${result.id}?saved=created`);
}

export async function updateCompanyAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = str(formData, "id");
  if (!UUID_RE.test(id)) {
    fail("/admin/sales/companies", "Invalid company id");
  }

  const built = buildCompanyInput(formData);
  if (!built.ok) {
    fail(`/admin/sales/companies/${id}/edit`, "Company name, status and source are required.");
  }

  const result = await updateCompany(id, built.value, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail(`/admin/sales/companies/${id}/edit`, result.error || "Couldn't update company.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.company_updated",
    targetTable: "hq_sales_companies",
    targetId: id,
    metadata: { name: built.value.name, status: built.value.status },
  });

  revalidatePath("/admin/sales");
  revalidatePath("/admin/sales/companies");
  revalidatePath(`/admin/sales/companies/${id}`);
  redirect(`/admin/sales/companies/${id}?saved=updated`);
}

// ---------------------------------------------------------------------
// Quick pipeline status change (from the detail header).
// ---------------------------------------------------------------------

const statusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(PIPELINE_STATUSES),
});

export async function setCompanyStatusAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = statusSchema.safeParse({
    id: formData.get("id"),
    status: formData.get("status"),
  });
  if (!parsed.success) {
    fail("/admin/sales/companies", "Invalid status request");
  }

  const result = await setCompanyStatus(parsed.data.id, parsed.data.status, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail(`/admin/sales/companies/${parsed.data.id}`, result.error || "Couldn't change status.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.status_changed",
    targetTable: "hq_sales_companies",
    targetId: parsed.data.id,
    metadata: { status: parsed.data.status },
  });

  revalidatePath("/admin/sales");
  revalidatePath("/admin/sales/companies");
  revalidatePath("/admin/sales/analytics");
  revalidatePath(`/admin/sales/companies/${parsed.data.id}`);
  redirect(`/admin/sales/companies/${parsed.data.id}?saved=status`);
}

// ---------------------------------------------------------------------
// Contacts (add / delete). Editing a contact is a future enhancement.
// ---------------------------------------------------------------------

const contactCore = z.object({
  company_id: z.string().uuid(),
  full_name: z.string().trim().min(1).max(200),
  seniority: z.enum(SENIORITIES),
});

export async function addContactAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = contactCore.safeParse({
    company_id: formData.get("company_id"),
    full_name: formData.get("full_name"),
    seniority: formData.get("seniority"),
  });
  if (!parsed.success) {
    const cid = str(formData, "company_id");
    fail(
      UUID_RE.test(cid) ? `/admin/sales/companies/${cid}` : "/admin/sales/companies",
      "A contact name is required.",
    );
  }

  const input: ContactWriteInput = {
    fullName: parsed.data.full_name,
    title: nullableStr(formData, "title", 200),
    seniority: parsed.data.seniority,
    email: nullableStr(formData, "email", 320),
    phone: nullableStr(formData, "phone", 60),
    linkedinUrl: nullableStr(formData, "linkedin_url", 500),
    isPrimary: bool(formData, "is_primary"),
    isDecisionMaker: bool(formData, "is_decision_maker"),
    notes: clip(formData, "notes", 4000),
  };

  const result = await addContact(parsed.data.company_id, input, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail(`/admin/sales/companies/${parsed.data.company_id}`, result.error || "Couldn't add contact.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.contact_added",
    targetTable: "hq_sales_contacts",
    targetId: result.id,
    metadata: { company_id: parsed.data.company_id, full_name: input.fullName },
  });

  revalidatePath(`/admin/sales/companies/${parsed.data.company_id}`);
  redirect(`/admin/sales/companies/${parsed.data.company_id}?saved=contact`);
}

const deleteContactSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
});

export async function deleteContactAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = deleteContactSchema.safeParse({
    id: formData.get("id"),
    company_id: formData.get("company_id"),
  });
  if (!parsed.success) {
    fail("/admin/sales/companies", "Invalid contact request");
  }

  const result = await deleteContact(parsed.data.id, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail(`/admin/sales/companies/${parsed.data.company_id}`, result.error || "Couldn't remove contact.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.contact_deleted",
    targetTable: "hq_sales_contacts",
    targetId: parsed.data.id,
    metadata: { company_id: parsed.data.company_id },
  });

  revalidatePath(`/admin/sales/companies/${parsed.data.company_id}`);
  redirect(`/admin/sales/companies/${parsed.data.company_id}?saved=contact_removed`);
}

// ---------------------------------------------------------------------
// Research reports (permanent).
// ---------------------------------------------------------------------

const researchCore = z.object({
  company_id: z.string().uuid(),
  generated_by: z.enum(GENERATED_BY),
  risk_level: z.enum(RISK_LEVELS),
});

export async function addResearchAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = researchCore.safeParse({
    company_id: formData.get("company_id"),
    generated_by: formData.get("generated_by"),
    risk_level: formData.get("risk_level"),
  });
  if (!parsed.success) {
    const cid = str(formData, "company_id");
    fail(
      UUID_RE.test(cid) ? `/admin/sales/companies/${cid}` : "/admin/sales/companies",
      "Couldn't save research — check the form.",
    );
  }

  const ai = parsed.data.generated_by === "ai";
  const input: ResearchWriteInput = {
    summary: clip(formData, "summary", 8000),
    painPoints: normalizeList(str(formData, "pain_points")),
    likelihoodScore: clampScore(formData.get("likelihood_score")),
    estimatedSoftwareSpendGbp: nullableInt(formData, "estimated_software_spend_gbp"),
    estimatedSpendNote: clip(formData, "estimated_spend_note", 2000),
    bestAngle: clip(formData, "best_angle", 4000),
    openingLine: clip(formData, "opening_line", 2000),
    recommendedFollowUp: clip(formData, "recommended_follow_up", 4000),
    riskAssessment: clip(formData, "risk_assessment", 4000),
    riskLevel: parsed.data.risk_level,
    generatedBy: parsed.data.generated_by,
    model: ai ? nullableStr(formData, "model", 120) : null,
    aiEmployeeId: ai ? uuidOrNull(formData, "ai_employee_id") : null,
  };

  const result = await addResearchReport(parsed.data.company_id, input, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail(`/admin/sales/companies/${parsed.data.company_id}`, result.error || "Couldn't save research.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.research_added",
    targetTable: "hq_sales_research_reports",
    targetId: result.id,
    metadata: {
      company_id: parsed.data.company_id,
      generated_by: parsed.data.generated_by,
    },
  });

  revalidatePath("/admin/sales");
  revalidatePath("/admin/sales/activity");
  revalidatePath(`/admin/sales/companies/${parsed.data.company_id}`);
  redirect(`/admin/sales/companies/${parsed.data.company_id}?saved=research`);
}

// ---------------------------------------------------------------------
// Recommendations.
// ---------------------------------------------------------------------

const recoCore = z.object({
  company_id: z.string().uuid(),
  generated_by: z.enum(GENERATED_BY),
});

export async function addRecommendationAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = recoCore.safeParse({
    company_id: formData.get("company_id"),
    generated_by: formData.get("generated_by"),
  });
  if (!parsed.success) {
    const cid = str(formData, "company_id");
    fail(
      UUID_RE.test(cid) ? `/admin/sales/companies/${cid}` : "/admin/sales/companies",
      "Couldn't save recommendation — check the form.",
    );
  }

  const ai = parsed.data.generated_by === "ai";
  const input: RecommendationWriteInput = {
    whyBuy: clip(formData, "why_buy", 4000),
    keyFeatures: normalizeList(str(formData, "key_features")),
    likelyObjections: normalizeList(str(formData, "likely_objections")),
    recommendedPricing: clip(formData, "recommended_pricing", 2000),
    recommendedPlan: nullableStr(formData, "recommended_plan", 120),
    recommendedPriceGbp: nullableInt(formData, "recommended_price_gbp"),
    bestSalesperson: nullableStr(formData, "best_salesperson", 200),
    bestTimeToCall: clip(formData, "best_time_to_call", 500),
    followUpSchedule: clip(formData, "follow_up_schedule", 4000),
    followUpSteps: null,
    generatedBy: parsed.data.generated_by,
    model: ai ? nullableStr(formData, "model", 120) : null,
    aiEmployeeId: ai ? uuidOrNull(formData, "ai_employee_id") : null,
  };

  const result = await addRecommendation(parsed.data.company_id, input, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail(`/admin/sales/companies/${parsed.data.company_id}`, result.error || "Couldn't save recommendation.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.recommendation_added",
    targetTable: "hq_sales_recommendations",
    targetId: result.id,
    metadata: {
      company_id: parsed.data.company_id,
      generated_by: parsed.data.generated_by,
    },
  });

  revalidatePath("/admin/sales");
  revalidatePath(`/admin/sales/companies/${parsed.data.company_id}`);
  redirect(`/admin/sales/companies/${parsed.data.company_id}?saved=recommendation`);
}

// ---------------------------------------------------------------------
// Timeline interactions (email / call / note / meeting / demo / …).
// ---------------------------------------------------------------------

export async function logInteractionAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const companyId = str(formData, "company_id");
  const eventType = str(formData, "event_type");
  const direction = str(formData, "direction");

  const validType = (INTERACTION_EVENT_TYPES as readonly string[]).includes(eventType);
  const validDirection = (EVENT_DIRECTIONS as readonly string[]).includes(direction);
  if (!UUID_RE.test(companyId) || !validType || !validDirection) {
    fail(
      UUID_RE.test(companyId) ? `/admin/sales/companies/${companyId}` : "/admin/sales/companies",
      "Couldn't log the interaction — check the form.",
    );
  }

  const input: TimelineWriteInput = {
    eventType,
    direction,
    subject: nullableStr(formData, "subject", 300),
    body: clip(formData, "body", 20000),
    outcome: nullableStr(formData, "outcome", 80),
    occurredAt: parseOccurredAt(formData),
    contactId: uuidOrNull(formData, "contact_id"),
  };

  const result = await logInteraction(companyId, input, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail(`/admin/sales/companies/${companyId}`, result.error || "Couldn't log interaction.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.interaction_logged",
    targetTable: "hq_sales_timeline_events",
    targetId: result.id,
    metadata: { company_id: companyId, event_type: eventType },
  });

  revalidatePath("/admin/sales");
  revalidatePath("/admin/sales/activity");
  revalidatePath(`/admin/sales/companies/${companyId}`);
  redirect(`/admin/sales/companies/${companyId}?saved=logged`);
}

// ---------------------------------------------------------------------
// Promote a research report into the Shared Memory Engine (Directive 002
// bridge). Opt-in, audited, idempotent.
// ---------------------------------------------------------------------

const promoteSchema = z.object({
  report_id: z.string().uuid(),
  company_id: z.string().uuid(),
});

export async function promoteResearchAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = promoteSchema.safeParse({
    report_id: formData.get("report_id"),
    company_id: formData.get("company_id"),
  });
  if (!parsed.success) {
    fail("/admin/sales/companies", "Invalid promotion request");
  }

  const result = await promoteResearchToMemory(parsed.data.report_id, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail(`/admin/sales/companies/${parsed.data.company_id}`, result.error || "Couldn't promote to Shared Memory.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.research_promoted",
    targetTable: "hq_sales_research_reports",
    targetId: parsed.data.report_id,
    metadata: { company_id: parsed.data.company_id, memory_id: result.id },
  });

  revalidatePath(`/admin/sales/companies/${parsed.data.company_id}`);
  redirect(`/admin/sales/companies/${parsed.data.company_id}?saved=promoted`);
}
