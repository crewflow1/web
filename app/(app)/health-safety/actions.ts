"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  createRaSchema, updateRaSchema, raIdSchema, hazardSchema, hazardIdSchema, orNull,
} from "@/lib/health-safety/schema";
import { canIssue } from "@/lib/health-safety/rams";
import { getRiskAssessment } from "./_data";

/**
 * Health & Safety — RAMS server actions.
 *
 * Every write runs on the tenant (user-JWT) client so RLS scopes it to the org;
 * the service-role client is never used here. The DB is the authority for the
 * hard invariants — immutability-on-issue, hazard org derivation, cross-org job
 * rejection — so these actions validate shape and surface DB refusals honestly
 * (a count-0 update means "not found / not permitted", never a false success).
 * risk_assessments post-dates the generated types → precise per-call casts.
 */

type FromChain = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};
// Bind `this` to the client — `.from` is a prototype method, so extracting it
// unbound (const f = client.from; f(...)) makes `this` undefined and supabase-js
// throws "Cannot read properties of undefined (reading 'rest')" on the first call.
const tbl = (c: unknown) => (c as FromChain).from.bind(c);

function firstError(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Invalid input";
}

// ---------------------------------------------------------------------------
// RAMS header
// ---------------------------------------------------------------------------
export async function createRiskAssessment(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = createRaSchema.safeParse({
    title: formData.get("title"),
    activity: formData.get("activity"),
    location: formData.get("location") ?? "",
    jobId: (formData.get("jobId") as string) || null,
    assessorId: (formData.get("assessorId") as string) || null,
    assessmentDate: formData.get("assessmentDate") ?? "",
    reviewDate: formData.get("reviewDate") ?? "",
    ppe: formData.getAll("ppe").map(String).filter(Boolean),
    methodStatement: formData.get("methodStatement") ?? "",
  });
  if (!parsed.success) redirect(`/health-safety/new?error=${encodeURIComponent(firstError(parsed.error.issues))}`);

  const v = parsed.data;
  const id = randomUUID();
  const supabase = await createClient();
  const { error } = await tbl(supabase)("risk_assessments").insert({
    id,
    org_id: ctx.org.id,
    job_id: v.jobId ?? null,
    title: v.title,
    activity: v.activity,
    location: orNull(v.location),
    assessor_id: v.assessorId ?? null,
    assessment_date: orNull(v.assessmentDate),
    review_date: orNull(v.reviewDate),
    ppe: v.ppe ?? [],
    method_statement: orNull(v.methodStatement),
    created_by: user.id,
  });
  if (error) redirect(`/health-safety/new?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/health-safety");
  redirect(`/health-safety/${id}?saved=created`);
}

export async function updateRiskAssessment(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = updateRaSchema.safeParse({
    id: formData.get("id"),
    title: formData.get("title"),
    activity: formData.get("activity"),
    location: formData.get("location") ?? "",
    jobId: (formData.get("jobId") as string) || null,
    assessorId: (formData.get("assessorId") as string) || null,
    assessmentDate: formData.get("assessmentDate") ?? "",
    reviewDate: formData.get("reviewDate") ?? "",
    ppe: formData.getAll("ppe").map(String).filter(Boolean),
    methodStatement: formData.get("methodStatement") ?? "",
  });
  if (!parsed.success) redirect(`/health-safety?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  const v = parsed.data;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("risk_assessments")
    .update({
      title: v.title, activity: v.activity, location: orNull(v.location),
      job_id: v.jobId ?? null, assessor_id: v.assessorId ?? null,
      assessment_date: orNull(v.assessmentDate), review_date: orNull(v.reviewDate),
      ppe: v.ppe ?? [], method_statement: orNull(v.methodStatement),
    }, { count: "exact" })
    .eq("id", v.id)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft"); // belt-and-braces; the DB trigger is the real gate
  if (error) redirect(`/health-safety/${v.id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/health-safety/${v.id}?error=not_editable`);
  revalidatePath(`/health-safety/${v.id}`);
  redirect(`/health-safety/${v.id}?saved=updated`);
}

// ---------------------------------------------------------------------------
// Issue / supersede / withdraw
// ---------------------------------------------------------------------------
export async function issueRiskAssessment(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = raIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/health-safety?error=bad_id`);
  const id = parsed.data.id;
  const supabase = await createClient();

  // Load current state (RLS-scoped) + hazard count to gate the transition.
  const { data: ra } = await tbl(supabase)("risk_assessments")
    .select("id, title, activity, assessor_id, status, risk_assessment_hazards(count)")
    .eq("id", id).eq("org_id", ctx.org.id).maybeSingle();
  if (!ra) redirect(`/health-safety?error=not_found`);
  const hazardCount = ra.risk_assessment_hazards?.[0]?.count ?? 0;
  const gate = canIssue({ status: ra.status, title: ra.title, activity: ra.activity, assessorId: ra.assessor_id, hazardCount });
  if (!gate.ok) redirect(`/health-safety/${id}?error=${encodeURIComponent(gate.reasons[0]!)}`);

  // Allocate the per-org reference; the unique (org_id, reference) backstops races.
  const { data: reference, error: numErr } = await (supabase as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: string | null; error: { message: string } | null }>;
  }).rpc("next_ra_number", { target_org: ctx.org.id });
  if (numErr || !reference) redirect(`/health-safety/${id}?error=numbering_failed`);

  const { error, count } = await tbl(supabase)("risk_assessments")
    .update({ status: "issued", reference, issued_at: new Date().toISOString(), issued_by: user.id }, { count: "exact" })
    .eq("id", id).eq("org_id", ctx.org.id).eq("status", "draft");
  if (error) redirect(`/health-safety/${id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/health-safety/${id}?error=not_found`);

  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null,
    action: "risk_assessment.issued", targetTable: "risk_assessments", targetId: id,
    metadata: { reference },
  }).catch(() => {});
  revalidatePath(`/health-safety/${id}`);
  redirect(`/health-safety/${id}?saved=issued`);
}

async function transition(formData: FormData, to: "superseded" | "withdrawn"): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = raIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/health-safety?error=bad_id`);
  const id = parsed.data.id;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("risk_assessments")
    .update({ status: to }, { count: "exact" })
    .eq("id", id).eq("org_id", ctx.org.id).eq("status", "issued");
  if (error) redirect(`/health-safety/${id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/health-safety/${id}?error=not_found`);
  revalidatePath(`/health-safety/${id}`);
  redirect(`/health-safety/${id}?saved=${to}`);
}
export async function supersedeRiskAssessment(formData: FormData): Promise<void> { await transition(formData, "superseded"); }
export async function withdrawRiskAssessment(formData: FormData): Promise<void> { await transition(formData, "withdrawn"); }

// ---------------------------------------------------------------------------
// Revisions — an issued RAMS is never edited in place. A revision is a NEW draft
// copied from the issued snapshot (header + hazards); issuing it atomically
// supersedes the prior revision (see issue_rams_revision, 20261022). The DB is
// the authority (one-draft-per-series + one-issued-per-series + the atomic RPC);
// these actions validate shape and surface refusals honestly.
// ---------------------------------------------------------------------------
export async function createRamsRevision(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = raIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/health-safety?error=bad_id`);
  const sourceId = parsed.data.id;

  // ACTIVE-org pin: the new revision is stamped `org_id: ctx.org.id` below, so
  // an unpinned source read let a dual-org member copy the OTHER company's
  // issued RAMS (title, activity, hazards) into this org's register.
  const source = await getRiskAssessment(ctx.org.id, sourceId);
  if (!source) redirect(`/health-safety?error=not_found`);
  const { ra, hazards } = source;
  // Only an issued (current or superseded) record is a snapshot worth revising.
  if (ra.status !== "issued") redirect(`/health-safety/${sourceId}?error=only_issued_can_be_revised`);

  const newId = randomUUID();
  const supabase = await createClient();
  const { error } = await tbl(supabase)("risk_assessments").insert({
    id: newId,
    org_id: ctx.org.id,
    job_id: ra.job_id,
    title: ra.title,
    activity: ra.activity,
    location: ra.location,
    assessor_id: ra.assessor_id,
    assessment_date: ra.assessment_date,
    review_date: ra.review_date,
    ppe: ra.ppe ?? [],
    method_statement: ra.method_statement,
    root_risk_assessment_id: ra.root_risk_assessment_id,
    revision_number: ra.revision_number + 1,
    supersedes_id: ra.id,
    created_by: user.id,
  });
  // The one-draft-per-series partial unique index turns a concurrent second
  // revision into a friendly "already in progress", never a duplicate.
  if (error) {
    const code = /duplicate key|unique/i.test(error.message) ? "revision_in_progress" : encodeURIComponent(error.message);
    redirect(`/health-safety/${sourceId}?error=${code}`);
  }

  // Copy the hazards into the new draft (org_id is trigger-derived from the parent).
  if (hazards.length > 0) {
    await tbl(supabase)("risk_assessment_hazards").insert(
      hazards.map((h) => ({
        org_id: ctx.org.id,
        risk_assessment_id: newId,
        hazard: h.hazard,
        who_at_risk: h.who_at_risk,
        likelihood: h.likelihood,
        severity: h.severity,
        control_measures: h.control_measures,
        residual_likelihood: h.residual_likelihood,
        residual_severity: h.residual_severity,
        sort_order: h.sort_order,
      })),
    );
  }

  revalidatePath(`/health-safety/${newId}`);
  redirect(`/health-safety/${newId}?saved=revision_created`);
}

export async function issueRamsRevision(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = raIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/health-safety?error=bad_id`);
  const id = parsed.data.id;
  const supabase = await createClient();

  // Friendly pre-check (the DB re-enforces the gate + supersede atomically).
  const { data: ra } = await tbl(supabase)("risk_assessments")
    .select("id, title, activity, assessor_id, status, risk_assessment_hazards(count)")
    .eq("id", id).eq("org_id", ctx.org.id).maybeSingle();
  if (!ra) redirect(`/health-safety?error=not_found`);
  const hazardCount = ra.risk_assessment_hazards?.[0]?.count ?? 0;
  const gate = canIssue({ status: ra.status, title: ra.title, activity: ra.activity, assessorId: ra.assessor_id, hazardCount });
  if (!gate.ok) redirect(`/health-safety/${id}?error=${encodeURIComponent(gate.reasons[0]!)}`);

  const { data: reference, error } = await (supabase as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: string | null; error: { message: string } | null }>;
  }).rpc("issue_rams_revision", { p_id: id });
  if (error || !reference) redirect(`/health-safety/${id}?error=${encodeURIComponent(error?.message ?? "issue_failed")}`);

  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null,
    action: "risk_assessment.revised", targetTable: "risk_assessments", targetId: id,
    metadata: { reference },
  }).catch(() => {});
  revalidatePath(`/health-safety/${id}`);
  redirect(`/health-safety/${id}?saved=issued`);
}

// ---------------------------------------------------------------------------
// Hazards (only on a draft — the DB trigger enforces it)
// ---------------------------------------------------------------------------
export async function addHazard(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = hazardSchema.safeParse({
    riskAssessmentId: formData.get("riskAssessmentId"),
    hazard: formData.get("hazard"),
    whoAtRisk: formData.get("whoAtRisk") ?? "",
    likelihood: formData.get("likelihood"),
    severity: formData.get("severity"),
    controlMeasures: formData.get("controlMeasures"),
    residualLikelihood: (formData.get("residualLikelihood") as string) || null,
    residualSeverity: (formData.get("residualSeverity") as string) || null,
    sortOrder: (formData.get("sortOrder") as string) || 0,
  });
  const raId = String(formData.get("riskAssessmentId") ?? "");
  if (!parsed.success) redirect(`/health-safety/${raId}?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  const v = parsed.data;
  const supabase = await createClient();
  // org_id is authoritatively derived from the parent by a DB trigger; we pass
  // the caller's org so the RLS insert-check passes for the normal (same-org) case.
  const { error } = await tbl(supabase)("risk_assessment_hazards").insert({
    org_id: ctx.org.id,
    risk_assessment_id: v.riskAssessmentId,
    hazard: v.hazard,
    who_at_risk: orNull(v.whoAtRisk),
    likelihood: v.likelihood, severity: v.severity,
    control_measures: v.controlMeasures,
    residual_likelihood: v.residualLikelihood ?? null,
    residual_severity: v.residualSeverity ?? null,
    sort_order: v.sortOrder ?? 0,
  });
  if (error) redirect(`/health-safety/${v.riskAssessmentId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/health-safety/${v.riskAssessmentId}`);
  redirect(`/health-safety/${v.riskAssessmentId}?saved=hazard`);
}

export async function deleteHazard(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = hazardIdSchema.safeParse({ id: formData.get("id"), riskAssessmentId: formData.get("riskAssessmentId") });
  if (!parsed.success) redirect(`/health-safety?error=bad_id`);
  const { id, riskAssessmentId } = parsed.data;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("risk_assessment_hazards")
    .delete({ count: "exact" }).eq("id", id).eq("org_id", ctx.org.id);
  if (error) redirect(`/health-safety/${riskAssessmentId}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/health-safety/${riskAssessmentId}?error=not_found`);
  revalidatePath(`/health-safety/${riskAssessmentId}`);
  redirect(`/health-safety/${riskAssessmentId}?saved=hazard_removed`);
}
