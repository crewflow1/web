"use server";

import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  createPermitSchema, updatePermitSchema, permitIdSchema, addConditionSchema,
  conditionIdSchema, orNull, TRANSITION_STAMP, type CreatePermitInput,
} from "@/lib/health-safety/permits-schema";
import { canIssue } from "@/lib/health-safety/permits";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Permit-to-Work server actions. Tenant (user-JWT) client only → RLS-scoped; the
 * service-role client is never used here. The DB is the authority for the
 * lifecycle, the issue-gate and immutability; these actions validate shape,
 * re-check readiness, and surface DB refusals honestly (count 0 = not found /
 * not permitted, never a false success).
 *
 * These actions return `FormState` (the client navigates via `redirectTo`
 * through <StateForm>, a full document load) instead of calling `redirect()`.
 * A Server-Action redirect between routes under /health-safety/permits/* loses
 * a race in the Next 15.5 client router (upstream vercel/next.js#83386): the
 * rejected redirect error can strand React's still-suspended commit, so the
 * row is written but the URL never changes and no error surfaces. Measured on
 * this exact page under `next start`: same-route ?saved= updates lost 60% of
 * reps. See components/forms/StateForm.tsx and the fleet fix (8e4a846).
 *
 * No revalidatePath, deliberately: every permits surface renders per-request
 * (cookie-authed reads, no Next data cache), and the client router treats
 * dynamic content as immediately stale — the post-navigation document load is
 * always fresh. Revalidating only added weight to the racy action response.
 */

type FromChain = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
// Bind `this` to the client — extracting `.from` unbound makes `this` undefined and
// supabase-js throws "Cannot read properties of undefined (reading 'rest')".
const tbl = (c: unknown) => (c as FromChain).from.bind(c);
const firstError = (issues: { message: string }[]) => issues[0]?.message ?? "Invalid input";
const base = "/health-safety/permits";

function permitFields(formData: FormData) {
  return {
    permitType: formData.get("permitType"),
    title: formData.get("title"),
    scope: formData.get("scope"),
    location: formData.get("location") ?? "",
    jobId: (formData.get("jobId") as string) || null,
    riskAssessmentId: (formData.get("riskAssessmentId") as string) || null,
    responsiblePerson: formData.get("responsiblePerson") ?? "",
    isolationDetails: formData.get("isolationDetails") ?? "",
    emergencyArrangements: formData.get("emergencyArrangements") ?? "",
    validFrom: (formData.get("validFrom") as string) || null,
    validUntil: (formData.get("validUntil") as string) || null,
  };
}
function permitRow(v: CreatePermitInput) {
  return {
    permit_type: v.permitType, title: v.title, scope: v.scope,
    location: orNull(v.location), job_id: v.jobId ?? null,
    risk_assessment_id: v.riskAssessmentId ?? null,
    responsible_person: orNull(v.responsiblePerson),
    isolation_details: orNull(v.isolationDetails),
    emergency_arrangements: orNull(v.emergencyArrangements),
    valid_from: orNull(v.validFrom), valid_until: orNull(v.validUntil),
  };
}

export async function createPermit(_prev: FormState, formData: FormData): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();
  const parsed = createPermitSchema.safeParse(permitFields(formData));
  if (!parsed.success) return formError(firstError(parsed.error.issues));
  const id = randomUUID();
  const supabase = await createClient();
  const { error } = await tbl(supabase)("permits_to_work").insert({
    id, org_id: ctx.org.id, created_by: user.id, ...permitRow(parsed.data),
  });
  if (error) return formError(error.message);
  return formSuccess({ redirectTo: `${base}/${id}?saved=created` });
}

export async function updatePermit(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  const parsed = updatePermitSchema.safeParse({ id: formData.get("id"), ...permitFields(formData) });
  if (!parsed.success) return formError(firstError(parsed.error.issues));
  const { id } = parsed.data;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("permits_to_work")
    .update(permitRow(parsed.data), { count: "exact" })
    .eq("id", id).eq("org_id", ctx.org.id).eq("status", "draft");
  if (error) return formError(error.message);
  if (!count) return formError("Only draft permits can be edited.");
  return formSuccess({ redirectTo: `${base}/${id}?saved=updated` });
}

export async function addPermitCondition(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  const parsed = addConditionSchema.safeParse({
    permitId: formData.get("permitId"), label: formData.get("label"),
    required: formData.get("required") ?? undefined, sortOrder: (formData.get("sortOrder") as string) || 0,
  });
  if (!parsed.success) return formError(firstError(parsed.error.issues));
  const supabase = await createClient();
  const { error } = await tbl(supabase)("permit_conditions").insert({
    org_id: ctx.org.id, permit_id: parsed.data.permitId, label: parsed.data.label,
    required: parsed.data.required === "on" || parsed.data.required === true,
    sort_order: parsed.data.sortOrder ?? 0,
  });
  if (error) return formError(error.message);
  return formSuccess({ redirectTo: `${base}/${parsed.data.permitId}?saved=condition` });
}

export async function deletePermitCondition(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  const parsed = conditionIdSchema.safeParse({ id: formData.get("id"), permitId: formData.get("permitId") });
  if (!parsed.success) return formError("That condition link looks wrong — reload and try again.");
  const { id, permitId } = parsed.data;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("permit_conditions").delete({ count: "exact" }).eq("id", id).eq("org_id", ctx.org.id);
  if (error) return formError(error.message);
  if (!count) return formError("Condition not found — it may already be removed.");
  return formSuccess({ redirectTo: `${base}/${permitId}?saved=condition_removed` });
}

export async function confirmPermitCondition(_prev: FormState, formData: FormData): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();
  const parsed = conditionIdSchema.safeParse({ id: formData.get("id"), permitId: formData.get("permitId") });
  if (!parsed.success) return formError("That condition link looks wrong — reload and try again.");
  const { id, permitId } = parsed.data;
  const confirm = (formData.get("confirmed") ?? "on") !== "off";
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("permit_conditions")
    .update(confirm
      ? { confirmed: true, confirmed_by: user.id, confirmed_at: new Date().toISOString() }
      : { confirmed: false, confirmed_by: null, confirmed_at: null }, { count: "exact" })
    .eq("id", id).eq("org_id", ctx.org.id);
  if (error) return formError(error.message);
  if (!count) return formError("Condition not found — it may already be removed.");
  return formSuccess({ redirectTo: `${base}/${permitId}?saved=condition` });
}

export async function issuePermit(_prev: FormState, formData: FormData): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();
  const parsed = permitIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return formError("That permit link looks wrong — reload and try again.");
  const id = parsed.data.id;
  const supabase = await createClient();
  const { data: p, error: permitError } = await tbl(supabase)("permits_to_work")
    .select("id, status, permit_type, title, scope, valid_from, valid_until, permit_conditions(required, confirmed)")
    .eq("id", id).eq("org_id", ctx.org.id).maybeSingle();
  // A failed guard read must not masquerade as "not found" — throw instead.
  if (permitError) throw readFailure("permits: issue guard", permitError);
  if (!p) return formError("Permit not found.");
  const gate = canIssue(p, (p.permit_conditions ?? []).map((c: { required: boolean; confirmed: boolean }) => ({ required: c.required, confirmed: c.confirmed })));
  if (!gate.ok) return formError(gate.reasons[0]!);
  const { data: reference, error: numErr } = await (supabase as unknown as {
    rpc: (fn: string, a: Record<string, unknown>) => Promise<{ data: string | null; error: { message: string } | null }>;
  }).rpc("next_ptw_number", { target_org: ctx.org.id });
  if (numErr || !reference) return formError("Could not allocate a permit number — try again.");
  const { error, count } = await tbl(supabase)("permits_to_work")
    .update({ status: "issued", reference, issued_at: new Date().toISOString(), issued_by: user.id }, { count: "exact" })
    .eq("id", id).eq("org_id", ctx.org.id).eq("status", "draft");
  if (error) return formError(error.message);
  if (!count) return formError("Permit not found, or it is no longer a draft.");
  await recordAdminActivity({ actorId: user.id, actorEmail: user.email ?? null, action: "permit.issued", targetTable: "permits_to_work", targetId: id, metadata: { reference } }).catch(() => {});
  return formSuccess({ redirectTo: `${base}/${id}?saved=issued` });
}

/** activate / suspend / close / cancel — the DB trigger validates the transition. */
export async function transitionPermit(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  const parsed = permitIdSchema.safeParse({ id: formData.get("id") });
  const verb = String(formData.get("verb") ?? "");
  const map = TRANSITION_STAMP[verb];
  if (!parsed.success || !map) return formError("That status change isn't available — reload and try again.");
  const id = parsed.data!.id;
  const supabase = await createClient();
  const patch: Record<string, unknown> = { status: map!.status };
  if (map!.stamp) patch[map!.stamp] = new Date().toISOString();
  if (verb === "close") patch.closeout_notes = orNull(formData.get("closeoutNotes") as string);
  const { error, count } = await tbl(supabase)("permits_to_work")
    .update(patch, { count: "exact" }).eq("id", id).eq("org_id", ctx.org.id);
  if (error) return formError(error.message);
  if (!count) return formError("Permit not found.");
  return formSuccess({ redirectTo: `${base}/${id}?saved=${map!.status}` });
}
