"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireHq } from "@/server/auth/hq";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  addChannel,
  addContact,
  addLocation,
  addRecommendation,
  addResearchReport,
  createCompany,
  deleteChannel,
  deleteContact,
  enqueueAiTask,
  logInteraction,
  promoteOutcomeToMemory,
  promoteResearchToMemory,
  setCompanyStatus,
  updateCompany,
  type AiTaskWriteInput,
  type ChannelWriteInput,
  type CompanyWriteInput,
  type ContactWriteInput,
  type LocationWriteInput,
  type RecommendationWriteInput,
  type ResearchWriteInput,
  type TimelineWriteInput,
} from "@/server/services/hq-sales";
import {
  AI_TASK_PRIORITIES,
  CHANNEL_STATUSES,
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

/** A `datetime-local` value at `key` → ISO string, or null when blank/invalid. */
function dateTimeOrNull(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseOccurredAt(formData: FormData): string | null {
  return dateTimeOrNull(formData, "occurred_at");
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
      // Company Intelligence — reserved, nullable signals.
      revenueEstimateGbp: nullableInt(formData, "revenue_estimate_gbp"),
      growthScore: clampScore(formData.get("growth_score")),
      constructionSector: nullableStr(formData, "construction_sector", 160),
      softwareUsed: normalizeList(str(formData, "software_used")),
      estimatedSoftwareSpendGbp: nullableInt(formData, "estimated_software_spend_gbp"),
      fleetSize: nullableInt(formData, "fleet_size"),
      staffSize: nullableInt(formData, "staff_size"),
      websiteQualityScore: clampScore(formData.get("website_quality_score")),
      marketingQualityScore: clampScore(formData.get("marketing_quality_score")),
      hiringActivityScore: clampScore(formData.get("hiring_activity_score")),
      digitalMaturityScore: clampScore(formData.get("digital_maturity_score")),
    },
  };
}

export async function createCompanyAction(formData: FormData): Promise<void> {
  const admin = await requireHq();
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
  const admin = await requireHq();
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
  const admin = await requireHq();
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
  const admin = await requireHq();
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
  const admin = await requireHq();
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
  const admin = await requireHq();
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
  const admin = await requireHq();
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
  const admin = await requireHq();
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
  const admin = await requireHq();
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

// ---------------------------------------------------------------------
// Locations — multiple physical sites per company.
// ---------------------------------------------------------------------

const locationCore = z.object({
  company_id: z.string().uuid(),
  generated_by: z.enum(GENERATED_BY),
});

export async function addLocationAction(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = locationCore.safeParse({
    company_id: formData.get("company_id"),
    generated_by: formData.get("generated_by") ?? "human",
  });
  if (!parsed.success) {
    const cid = str(formData, "company_id");
    fail(
      UUID_RE.test(cid) ? `/admin/sales/companies/${cid}` : "/admin/sales/companies",
      "Couldn't add location — check the form.",
    );
  }

  const ai = parsed.data.generated_by === "ai";
  const input: LocationWriteInput = {
    label: nullableStr(formData, "label", 120),
    isPrimary: bool(formData, "is_primary"),
    isHeadquarters: bool(formData, "is_headquarters"),
    addressLine1: nullableStr(formData, "address_line1", 300),
    addressLine2: nullableStr(formData, "address_line2", 300),
    city: nullableStr(formData, "city", 160),
    county: nullableStr(formData, "county", 160),
    region: nullableStr(formData, "region", 160),
    postcode: nullableStr(formData, "postcode", 32),
    country: nullableStr(formData, "country", 120) ?? "United Kingdom",
    phone: nullableStr(formData, "phone", 60),
    notes: clip(formData, "notes", 4000),
    generatedBy: parsed.data.generated_by,
    model: ai ? nullableStr(formData, "model", 120) : null,
    aiEmployeeId: ai ? uuidOrNull(formData, "ai_employee_id") : null,
  };

  // Don't create empty rows — require at least one locating field.
  if (!input.label && !input.addressLine1 && !input.city && !input.postcode) {
    fail(
      `/admin/sales/companies/${parsed.data.company_id}`,
      "Add a label, address, town or postcode for the location.",
    );
  }

  const result = await addLocation(parsed.data.company_id, input, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail(`/admin/sales/companies/${parsed.data.company_id}`, result.error || "Couldn't add location.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.location_added",
    targetTable: "hq_sales_locations",
    targetId: result.id,
    metadata: { company_id: parsed.data.company_id },
  });

  revalidatePath(`/admin/sales/companies/${parsed.data.company_id}`);
  redirect(`/admin/sales/companies/${parsed.data.company_id}?saved=location`);
}

// ---------------------------------------------------------------------
// Channels — multiple phones / emails / LinkedIn / social accounts.
// ---------------------------------------------------------------------

const channelCore = z.object({
  company_id: z.string().uuid(),
  channel_type: z.string().regex(SLUG_RE),
  value: z.string().trim().min(1).max(500),
  generated_by: z.enum(GENERATED_BY),
});

export async function addChannelAction(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = channelCore.safeParse({
    company_id: formData.get("company_id"),
    channel_type: formData.get("channel_type"),
    value: formData.get("value"),
    generated_by: formData.get("generated_by") ?? "human",
  });
  if (!parsed.success) {
    const cid = str(formData, "company_id");
    fail(
      UUID_RE.test(cid) ? `/admin/sales/companies/${cid}` : "/admin/sales/companies",
      "A channel type and value are required.",
    );
  }

  const ai = parsed.data.generated_by === "ai";
  const statusRaw = str(formData, "status");
  const status = (CHANNEL_STATUSES as readonly string[]).includes(statusRaw)
    ? statusRaw
    : "active";
  const input: ChannelWriteInput = {
    channelType: parsed.data.channel_type,
    value: parsed.data.value,
    label: nullableStr(formData, "label", 120),
    contactId: uuidOrNull(formData, "contact_id"),
    locationId: uuidOrNull(formData, "location_id"),
    isPrimary: bool(formData, "is_primary"),
    isVerified: bool(formData, "is_verified"),
    status,
    generatedBy: parsed.data.generated_by,
    model: ai ? nullableStr(formData, "model", 120) : null,
    aiEmployeeId: ai ? uuidOrNull(formData, "ai_employee_id") : null,
  };

  const result = await addChannel(parsed.data.company_id, input, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail(`/admin/sales/companies/${parsed.data.company_id}`, result.error || "Couldn't add channel.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.channel_added",
    targetTable: "hq_sales_channels",
    targetId: result.id,
    metadata: {
      company_id: parsed.data.company_id,
      channel_type: input.channelType,
    },
  });

  revalidatePath(`/admin/sales/companies/${parsed.data.company_id}`);
  redirect(`/admin/sales/companies/${parsed.data.company_id}?saved=channel`);
}

const deleteChannelSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
});

export async function deleteChannelAction(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = deleteChannelSchema.safeParse({
    id: formData.get("id"),
    company_id: formData.get("company_id"),
  });
  if (!parsed.success) {
    fail("/admin/sales/companies", "Invalid channel request");
  }

  const result = await deleteChannel(parsed.data.id, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail(`/admin/sales/companies/${parsed.data.company_id}`, result.error || "Couldn't remove channel.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.channel_deleted",
    targetTable: "hq_sales_channels",
    targetId: parsed.data.id,
    metadata: { company_id: parsed.data.company_id },
  });

  revalidatePath(`/admin/sales/companies/${parsed.data.company_id}`);
  redirect(`/admin/sales/companies/${parsed.data.company_id}?saved=channel_removed`);
}

// ---------------------------------------------------------------------
// AI Task Queue — enqueue a task for a future autonomous worker. No
// execution happens here; the row is the durable foundation + audit.
// ---------------------------------------------------------------------

const taskCore = z.object({
  task_type: z.string().regex(SLUG_RE),
  priority: z.enum(AI_TASK_PRIORITIES),
});

export async function enqueueAiTaskAction(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const companyId = uuidOrNull(formData, "company_id");
  // Company-scoped tasks return to the company; global tasks to the queue.
  const back = companyId
    ? `/admin/sales/companies/${companyId}`
    : "/admin/sales/tasks";

  const parsed = taskCore.safeParse({
    task_type: formData.get("task_type"),
    priority: formData.get("priority") ?? "normal",
  });
  if (!parsed.success) {
    fail(back, "Choose a task type and priority.");
  }

  const maxRetriesRaw = nullableInt(formData, "max_retries");
  const input: AiTaskWriteInput = {
    companyId,
    contactId: uuidOrNull(formData, "contact_id"),
    taskType: parsed.data.task_type,
    priority: parsed.data.priority,
    scheduledAt: dateTimeOrNull(formData, "scheduled_at"),
    maxRetries: maxRetriesRaw == null ? 3 : Math.min(10, maxRetriesRaw),
    assignedAiEmployeeId: uuidOrNull(formData, "assigned_ai_employee_id"),
    payload: null,
    dedupeKey: nullableStr(formData, "dedupe_key", 200),
  };

  const result = await enqueueAiTask(input, { id: admin.id, email: admin.email });
  if (!result.ok) {
    fail(back, result.error || "Couldn't schedule task.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.task_enqueued",
    targetTable: "hq_sales_ai_tasks",
    targetId: result.id,
    metadata: {
      company_id: companyId,
      task_type: input.taskType,
      priority: input.priority,
    },
  });

  revalidatePath("/admin/sales/tasks");
  if (companyId) revalidatePath(`/admin/sales/companies/${companyId}`);
  redirect(`${back}?saved=task`);
}

// ---------------------------------------------------------------------
// Promote a winning OUTCOME (objection / cold call / demo) into the
// Shared Memory Engine. Opt-in, audited, idempotent (Directive 002+003).
// ---------------------------------------------------------------------

const promoteOutcomeSchema = z.object({
  event_id: z.string().uuid(),
  company_id: z.string().uuid(),
});

export async function promoteOutcomeAction(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = promoteOutcomeSchema.safeParse({
    event_id: formData.get("event_id"),
    company_id: formData.get("company_id"),
  });
  if (!parsed.success) {
    fail("/admin/sales/companies", "Invalid promotion request");
  }

  const result = await promoteOutcomeToMemory(parsed.data.event_id, {
    id: admin.id,
    email: admin.email,
  });
  if (!result.ok) {
    fail(`/admin/sales/companies/${parsed.data.company_id}`, result.error || "Couldn't promote to Shared Memory.");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "hq_sales.outcome_promoted",
    targetTable: "hq_sales_timeline_events",
    targetId: parsed.data.event_id,
    metadata: { company_id: parsed.data.company_id, memory_id: result.id },
  });

  revalidatePath(`/admin/sales/companies/${parsed.data.company_id}`);
  redirect(`/admin/sales/companies/${parsed.data.company_id}?saved=promoted`);
}
