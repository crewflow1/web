"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  createPlanSchema,
  updatePlanSchema,
  planIdSchema,
  planItemSchema,
  planItemIdSchema,
  signoffSchema,
  voidSignoffSchema,
  orNull,
} from "@/lib/quality/schema";
import { canIssue } from "@/lib/quality/itp";
import { getPlan } from "./_data";

/**
 * Works Quality — ITP server actions.
 *
 * Every write runs on the tenant (user-JWT) client so RLS scopes it to the org;
 * the service-role client is never used here. The DB is the authority for the
 * hard invariants — lifecycle, immutability-on-issue, item org derivation, the
 * atomic supersede-and-issue, sign-off validation and the hold-point stamp — so
 * these actions validate shape and surface DB refusals honestly. A count-0
 * update means "not found / not permitted", never a false success.
 *
 * NOTHING here writes to `finances`, and there is no AI on any path.
 *
 * Route-swap depth is 2 (/quality/[id]), well inside the Next 15.5 deep-swap
 * commit race (depth >= 4), so the plain redirect() idiom the RAMS actions use
 * is correct here — the FormState + window.location.assign workaround is not
 * needed and would be cargo-culting.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type FromChain = { from: (t: string) => any };
// Bind `this` — `.from` is a prototype method; extracting it unbound makes
// `this` undefined and supabase-js throws on the first call.
const tbl = (c: unknown) => (c as FromChain).from.bind(c);
type RpcChain = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function firstError(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Invalid input";
}

// ---------------------------------------------------------------------------
// Plan header
// ---------------------------------------------------------------------------
export async function createInspectionPlan(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = createPlanSchema.safeParse({
    title: formData.get("title"),
    workPackage: formData.get("workPackage"),
    jobId: formData.get("jobId"),
    location: formData.get("location") ?? "",
    specificationRef: formData.get("specificationRef") ?? "",
    preparedBy: (formData.get("preparedBy") as string) || null,
    planDate: formData.get("planDate") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    redirect(`/quality/new?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }

  const v = parsed.data;
  const id = randomUUID();
  const supabase = await createClient();
  const { error } = await tbl(supabase)("inspection_test_plans").insert({
    id,
    org_id: ctx.org.id,
    job_id: v.jobId,
    title: v.title,
    work_package: v.workPackage,
    location: orNull(v.location),
    specification_ref: orNull(v.specificationRef),
    prepared_by: v.preparedBy ?? null,
    plan_date: orNull(v.planDate),
    notes: orNull(v.notes),
    created_by: user.id,
  });
  if (error) redirect(`/quality/new?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/quality");
  redirect(`/quality/${id}?saved=created`);
}

export async function updateInspectionPlan(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = updatePlanSchema.safeParse({
    id: formData.get("id"),
    title: formData.get("title"),
    workPackage: formData.get("workPackage"),
    jobId: formData.get("jobId"),
    location: formData.get("location") ?? "",
    specificationRef: formData.get("specificationRef") ?? "",
    preparedBy: (formData.get("preparedBy") as string) || null,
    planDate: formData.get("planDate") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) redirect(`/quality?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  const v = parsed.data;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("inspection_test_plans")
    .update(
      {
        title: v.title,
        work_package: v.workPackage,
        job_id: v.jobId,
        location: orNull(v.location),
        specification_ref: orNull(v.specificationRef),
        prepared_by: v.preparedBy ?? null,
        plan_date: orNull(v.planDate),
        notes: orNull(v.notes),
      },
      { count: "exact" },
    )
    .eq("id", v.id)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft"); // belt-and-braces; the DB trigger is the real gate
  if (error) redirect(`/quality/${v.id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/quality/${v.id}?error=not_editable`);
  revalidatePath(`/quality/${v.id}`);
  redirect(`/quality/${v.id}?saved=updated`);
}

// ---------------------------------------------------------------------------
// Issue / withdraw
// ---------------------------------------------------------------------------
export async function issuePlan(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = planIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/quality?error=bad_id`);
  const id = parsed.data.id;

  // Friendly pre-check. The DB re-enforces the gate and does the supersede
  // atomically; this only produces a readable message.
  // ACTIVE-org pinned: an unpinned read would let a dual-org member drive the
  // issue flow against the other company's plan.
  const loaded = await getPlan(ctx.org.id, id);
  if (!loaded) redirect(`/quality?error=not_found`);
  const gate = canIssue({
    status: loaded.plan.status,
    title: loaded.plan.title,
    workPackage: loaded.plan.work_package,
    jobId: loaded.plan.job_id,
    itemCount: loaded.items.length,
  });
  if (!gate.ok) redirect(`/quality/${id}?error=${encodeURIComponent(gate.reasons[0]!)}`);

  const supabase = await createClient();
  const { data: reference, error } = await (supabase as unknown as RpcChain).rpc(
    "issue_inspection_plan",
    { p_id: id },
  );
  if (error || !reference) {
    redirect(`/quality/${id}?error=${encodeURIComponent(error?.message ?? "issue_failed")}`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "inspection_plan.issued",
    targetTable: "inspection_test_plans",
    targetId: id,
    metadata: { reference: String(reference) },
  }).catch(() => {});

  revalidatePath("/quality");
  revalidatePath(`/quality/${id}`);
  redirect(`/quality/${id}?saved=issued`);
}

export async function withdrawPlan(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = planIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/quality?error=bad_id`);
  const id = parsed.data.id;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("inspection_test_plans")
    .update({ status: "withdrawn" }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .in("status", ["draft", "issued"]);
  if (error) redirect(`/quality/${id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/quality/${id}?error=not_found`);
  revalidatePath("/quality");
  revalidatePath(`/quality/${id}`);
  redirect(`/quality/${id}?saved=withdrawn`);
}

// ---------------------------------------------------------------------------
// Items (only on a draft — the DB trigger enforces it)
// ---------------------------------------------------------------------------
export async function addPlanItem(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const planId = String(formData.get("planId") ?? "");
  const parsed = planItemSchema.safeParse({
    planId,
    itemNumber: formData.get("itemNumber"),
    title: formData.get("title"),
    acceptanceCriteria: formData.get("acceptanceCriteria"),
    inspectionMethod: formData.get("inspectionMethod") ?? "",
    specificationRef: formData.get("specificationRef") ?? "",
    controlPoint: formData.get("controlPoint") ?? "inspect",
    isHoldPoint: formData.get("isHoldPoint") === "on",
    // An unchecked checkbox sends nothing, so `!== "off"` would make the box
    // un-un-checkable. The form always sends a hidden "off" and adds "on" only
    // when ticked; ask for the tick, never for the absence of one.
    required: formData.getAll("required").includes("on"),
  });
  if (!parsed.success) {
    redirect(`/quality/${planId}?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }
  const v = parsed.data;
  const supabase = await createClient();
  // org_id is authoritatively DERIVED from the parent by a DB trigger; the
  // caller's org is passed only so the RLS insert-check passes for the normal
  // (same-org) case.
  const { error } = await tbl(supabase)("inspection_plan_items").insert({
    org_id: ctx.org.id,
    inspection_test_plan_id: v.planId,
    item_number: v.itemNumber,
    title: v.title,
    acceptance_criteria: v.acceptanceCriteria,
    inspection_method: orNull(v.inspectionMethod),
    specification_ref: orNull(v.specificationRef),
    control_point: v.controlPoint,
    // A hold point is always required (DB CHECK ipi_hold_point_is_required) —
    // don't let the form produce a row the database will refuse.
    is_hold_point: v.isHoldPoint ?? false,
    required: v.isHoldPoint ? true : (v.required ?? true),
  });
  if (error) {
    const code = /duplicate key|unique/i.test(error.message) ? "duplicate_item_number" : encodeURIComponent(error.message);
    redirect(`/quality/${v.planId}?error=${code}`);
  }
  revalidatePath(`/quality/${v.planId}`);
  redirect(`/quality/${v.planId}?saved=item_added`);
}

export async function deletePlanItem(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = planItemIdSchema.safeParse({
    id: formData.get("id"),
    planId: formData.get("planId"),
  });
  if (!parsed.success) redirect(`/quality?error=bad_id`);
  const { id, planId } = parsed.data;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("inspection_plan_items")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) redirect(`/quality/${planId}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/quality/${planId}?error=not_found`);
  revalidatePath(`/quality/${planId}`);
  redirect(`/quality/${planId}?saved=item_removed`);
}

// ---------------------------------------------------------------------------
// Sign-offs
//
// The record is immutable once written and the hold-point gate is stamped by the
// database. NOTHING here refuses a sign-off because a hold point is open — the
// gate is a WARN seam (see lib/quality/itp.ts holdPointWarnings for why).
// ---------------------------------------------------------------------------
export async function recordSignoff(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const planId = String(formData.get("planId") ?? "");
  const parsed = signoffSchema.safeParse({
    itemId: formData.get("itemId"),
    planId,
    result: formData.get("result"),
    comments: formData.get("comments") ?? "",
    signedName: formData.get("signedName"),
    inspectedAt: formData.get("inspectedAt"),
    witnessName: formData.get("witnessName") ?? "",
    witnessOrganisation: formData.get("witnessOrganisation") ?? "",
  });
  if (!parsed.success) {
    redirect(`/quality/${planId}?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }
  const v = parsed.data;

  // The version anchor is the plan's CURRENT issued reference, read under the
  // ACTIVE-org pin. The DB re-checks that it still matches at insert time, so a
  // plan superseded between this read and the write is refused rather than
  // mis-anchored.
  const supabase = await createClient();
  const { data: plan, error: planErr } = await tbl(supabase)("inspection_test_plans")
    .select("id, reference, status")
    .eq("id", v.planId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  // A failed guard read must not masquerade as "not found".
  if (planErr) throw readFailure("quality: signoff guard", planErr);
  if (!plan) redirect(`/quality?error=not_found`);
  if (plan.status !== "issued" || !plan.reference) {
    redirect(`/quality/${v.planId}?error=not_issued`);
  }

  const { error } = await tbl(supabase)("inspection_signoffs").insert({
    org_id: ctx.org.id, // trigger-derived from the item; passed for the RLS check
    inspection_plan_item_id: v.itemId,
    plan_version: plan.reference,
    result: v.result,
    comments: orNull(v.comments),
    inspected_by: user.id, // RLS + trigger both pin this to auth.uid()
    signed_name: v.signedName,
    inspected_at: v.inspectedAt,
    witness_name: orNull(v.witnessName),
    witness_organisation: orNull(v.witnessOrganisation),
  });
  if (error) {
    const code = /duplicate key|unique/i.test(error.message)
      ? "already_signed_off"
      : encodeURIComponent(error.message);
    redirect(`/quality/${v.planId}?error=${code}`);
  }
  revalidatePath("/quality");
  revalidatePath(`/quality/${v.planId}`);
  redirect(`/quality/${v.planId}?saved=signed_off`);
}

/**
 * Void a sign-off. This is the ONLY way to retract one — a recorded inspection
 * is immutable, so the correction path is void-and-redo (the RAMS/permit
 * precedent for issued evidence). The voided row stays for the audit trail.
 */
export async function voidSignoff(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = voidSignoffSchema.safeParse({
    id: formData.get("id"),
    planId: formData.get("planId"),
    voidReason: formData.get("voidReason"),
  });
  if (!parsed.success) {
    const planId = String(formData.get("planId") ?? "");
    redirect(`/quality/${planId}?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }
  const v = parsed.data;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("inspection_signoffs")
    .update(
      {
        voided_at: new Date().toISOString(), // re-pinned server-side by the trigger
        voided_by: user.id,
        void_reason: v.voidReason,
      },
      { count: "exact" },
    )
    .eq("id", v.id)
    .eq("org_id", ctx.org.id)
    .is("voided_at", null);
  if (error) redirect(`/quality/${v.planId}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/quality/${v.planId}?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "inspection_signoff.voided",
    targetTable: "inspection_signoffs",
    targetId: v.id,
    metadata: { reason: v.voidReason },
  }).catch(() => {});

  revalidatePath("/quality");
  revalidatePath(`/quality/${v.planId}`);
  redirect(`/quality/${v.planId}?saved=voided`);
}
