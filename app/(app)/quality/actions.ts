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
  inviteWitnessSchema,
  witnessOutcomeSchema,
  startRevisionSchema,
  orNull,
} from "@/lib/quality/schema";
import type { PlanItemRow } from "@/lib/quality/schema";
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
    witnessInvitationId: (formData.get("witnessInvitationId") as string) || "",
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
    // The DB validates the invitation belongs to THIS item and is not cancelled.
    witness_invitation_id: v.witnessInvitationId ? v.witnessInvitationId : null,
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

// ---------------------------------------------------------------------------
// Witness invitations (M2)
//
// Staff invite a NAMED third party to a witness/approve control point on an
// issued plan, and staff record whether they attended. The DB enforces the
// control-point/issued gates and pins the attendance provenance; portal
// visibility for the customer is deferred (see migration 20261081 header).
// ---------------------------------------------------------------------------
export async function inviteWitness(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const planId = String(formData.get("planId") ?? "");
  const parsed = inviteWitnessSchema.safeParse({
    itemId: formData.get("itemId"),
    planId,
    witnessName: formData.get("witnessName"),
    witnessOrganisation: formData.get("witnessOrganisation"),
    witnessEmail: formData.get("witnessEmail") ?? "",
    scheduledFor: formData.get("scheduledFor") ?? "",
  });
  if (!parsed.success) {
    redirect(`/quality/${planId}?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }
  const v = parsed.data;
  const supabase = await createClient();
  // org_id is trigger-DERIVED from the item; passed only for the RLS check.
  const { error } = await tbl(supabase)("inspection_witness_invitations").insert({
    org_id: ctx.org.id,
    inspection_plan_item_id: v.itemId,
    witness_name: v.witnessName,
    witness_organisation: v.witnessOrganisation,
    witness_email: orNull(v.witnessEmail),
    scheduled_for: orNull(v.scheduledFor),
  });
  if (error) redirect(`/quality/${v.planId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/quality/${v.planId}`);
  redirect(`/quality/${v.planId}?saved=witness_invited`);
}

export async function recordWitnessOutcome(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = witnessOutcomeSchema.safeParse({
    id: formData.get("id"),
    planId: formData.get("planId"),
    outcome: formData.get("outcome"),
  });
  if (!parsed.success) redirect(`/quality?error=bad_id`);
  const v = parsed.data;
  const supabase = await createClient();
  // The trigger pins attendance_recorded_by/at server-side and refuses any
  // move off a terminal outcome; count-gated so a 0-row match is never a
  // false success.
  const { error, count } = await tbl(supabase)("inspection_witness_invitations")
    .update({ status: v.outcome }, { count: "exact" })
    .eq("id", v.id)
    .eq("org_id", ctx.org.id)
    .eq("status", "invited");
  if (error) redirect(`/quality/${v.planId}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/quality/${v.planId}?error=not_found`);
  revalidatePath(`/quality/${v.planId}`);
  redirect(`/quality/${v.planId}?saved=witness_recorded`);
}

// ---------------------------------------------------------------------------
// Revision lineage (M2)
//
// New-draft-from-current: copy the ISSUED plan's header AND every item — hold
// points included — into a draft carrying (root_plan_id, revision_number + 1).
// Issuing the draft later goes through the untouched issue_inspection_plan
// RPC, which supersedes this plan atomically. The one-draft-per-series partial
// unique refuses a concurrent second revision draft, loudly.
// ---------------------------------------------------------------------------
export async function createPlanRevision(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = startRevisionSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/quality?error=bad_id`);
  const id = parsed.data.id;

  // ACTIVE-org pinned read of the source plan + items.
  const loaded = await getPlan(ctx.org.id, id);
  if (!loaded) redirect(`/quality?error=not_found`);
  const { plan, items } = loaded;
  if (plan.status !== "issued") {
    redirect(`/quality/${id}?error=revision_source_not_issued`);
  }

  const newId = randomUUID();
  const supabase = await createClient();
  const { error } = await tbl(supabase)("inspection_test_plans").insert({
    id: newId,
    org_id: ctx.org.id,
    job_id: plan.job_id,
    title: plan.title,
    work_package: plan.work_package,
    location: plan.location,
    specification_ref: plan.specification_ref,
    prepared_by: plan.prepared_by,
    plan_date: plan.plan_date,
    notes: plan.notes,
    created_by: user.id,
    root_plan_id: plan.root_plan_id,
    revision_number: plan.revision_number + 1,
  });
  if (error) {
    const code = /duplicate key|unique/i.test(error.message)
      ? "revision_already_in_progress"
      : encodeURIComponent(error.message);
    redirect(`/quality/${id}?error=${code}`);
  }

  // Carry every check forward, hold points included. Every column supplied on
  // every row: a PostgREST batch sends explicit NULLs for columns present in
  // any row, so a heterogeneous batch would bypass the column DEFAULTs.
  if (items.length > 0) {
    const { error: itemsError } = await tbl(supabase)("inspection_plan_items").insert(
      items.map((i: PlanItemRow) => ({
        org_id: ctx.org.id, // trigger-derived from the parent; passed for RLS
        inspection_test_plan_id: newId,
        item_number: i.item_number,
        title: i.title,
        acceptance_criteria: i.acceptance_criteria,
        inspection_method: i.inspection_method,
        specification_ref: i.specification_ref,
        control_point: i.control_point,
        is_hold_point: i.is_hold_point,
        required: i.required,
      })),
    );
    if (itemsError) {
      // Leave nothing half-built: the draft (and any items that landed) can be
      // removed — it is a draft, so the delete triggers allow it.
      await tbl(supabase)("inspection_test_plans")
        .delete()
        .eq("id", newId)
        .eq("org_id", ctx.org.id);
      redirect(`/quality/${id}?error=${encodeURIComponent(itemsError.message)}`);
    }
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "inspection_plan.revision_started",
    targetTable: "inspection_test_plans",
    targetId: newId,
    metadata: { source_plan_id: id, revision_number: plan.revision_number + 1 },
  }).catch(() => {});

  revalidatePath("/quality");
  redirect(`/quality/${newId}?saved=revision_created`);
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
