"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  raiseNcrSchema,
  updateNcrSchema,
  ncrIdSchema,
  closeNcrSchema,
  proposeActionSchema,
  decideActionSchema,
  completeActionSchema,
  orNull,
} from "@/lib/quality/schema";

/**
 * Works Quality — NCR server actions (M2).
 *
 * Every write runs on the tenant (user-JWT) client so RLS scopes it to the
 * org; the service-role client is never used here. The DB is the authority:
 * NCR-NNNN allocation, org derivation, the transition graph, the DERIVED
 * middle statuses (marker-gated), the write-once corrective-action decision
 * and the pinned closure verification all live in migration 20261081 — these
 * actions validate shape and surface DB refusals honestly. A count-0 update
 * means "not found / not permitted", never a false success.
 *
 * NOTHING here writes to `finances`, and there is no AI on any path.
 *
 * Route-swap depth is 3 (/quality/ncrs/[id]), inside the Next 15.5 deep-swap
 * commit race threshold (depth >= 4), so M1's plain redirect() idiom holds.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type FromChain = { from: (t: string) => any };
// Bind `this` — `.from` is a prototype method; unbound it throws on first use.
const tbl = (c: unknown) => (c as FromChain).from.bind(c);
/* eslint-enable @typescript-eslint/no-explicit-any */

function firstError(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Invalid input";
}

// ---------------------------------------------------------------------------
// Raise / edit
// ---------------------------------------------------------------------------
export async function raiseNcr(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const itemId = String(formData.get("itemId") ?? "");
  const parsed = raiseNcrSchema.safeParse({
    itemId,
    sourceSignoffId: (formData.get("sourceSignoffId") as string) || null,
    title: formData.get("title"),
    description: formData.get("description"),
    severity: formData.get("severity"),
    responsibleUserId: (formData.get("responsibleUserId") as string) || null,
    responsibleSubcontractor: formData.get("responsibleSubcontractor") ?? "",
    dueDate: formData.get("dueDate") ?? "",
  });
  if (!parsed.success) {
    redirect(
      `/quality/ncrs/new?itemId=${encodeURIComponent(itemId)}&error=${encodeURIComponent(firstError(parsed.error.issues))}`,
    );
  }
  const v = parsed.data;
  const id = randomUUID();
  const supabase = await createClient();
  // reference is ALLOCATED BY THE DB (client value ignored); org_id is
  // trigger-derived from the item; raised_by is pinned to the session by the
  // trigger. The placeholder reference below only satisfies NOT NULL on the
  // wire — the trigger overwrites it before the row exists.
  const { error } = await tbl(supabase)("non_conformance_reports").insert({
    id,
    org_id: ctx.org.id,
    inspection_plan_item_id: v.itemId,
    source_signoff_id: v.sourceSignoffId ?? null,
    reference: "NCR-PENDING",
    title: v.title,
    description: v.description,
    severity: v.severity,
    responsible_user_id: v.responsibleUserId ?? null,
    responsible_subcontractor: orNull(v.responsibleSubcontractor),
    due_date: orNull(v.dueDate),
    raised_by: user.id,
  });
  if (error) {
    redirect(
      `/quality/ncrs/new?itemId=${encodeURIComponent(v.itemId)}&error=${encodeURIComponent(error.message)}`,
    );
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "non_conformance.raised",
    targetTable: "non_conformance_reports",
    targetId: id,
    metadata: { item_id: v.itemId, severity: v.severity },
  }).catch(() => {});

  revalidatePath("/quality/ncrs");
  redirect(`/quality/ncrs/${id}?saved=raised`);
}

export async function updateNcr(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = updateNcrSchema.safeParse({
    id: formData.get("id"),
    title: formData.get("title"),
    description: formData.get("description"),
    severity: formData.get("severity"),
    responsibleUserId: (formData.get("responsibleUserId") as string) || null,
    responsibleSubcontractor: formData.get("responsibleSubcontractor") ?? "",
    dueDate: formData.get("dueDate") ?? "",
  });
  if (!parsed.success) {
    const id = String(formData.get("id") ?? "");
    redirect(`/quality/ncrs/${id}?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }
  const v = parsed.data;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("non_conformance_reports")
    .update(
      {
        title: v.title,
        description: v.description,
        severity: v.severity,
        responsible_user_id: v.responsibleUserId ?? null,
        responsible_subcontractor: orNull(v.responsibleSubcontractor),
        due_date: orNull(v.dueDate),
      },
      { count: "exact" },
    )
    .eq("id", v.id)
    .eq("org_id", ctx.org.id)
    .eq("status", "open"); // belt-and-braces; the DB trigger is the real gate
  if (error) redirect(`/quality/ncrs/${v.id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/quality/ncrs/${v.id}?error=not_editable`);
  revalidatePath(`/quality/ncrs/${v.id}`);
  redirect(`/quality/ncrs/${v.id}?saved=updated`);
}

// ---------------------------------------------------------------------------
// Corrective actions
// ---------------------------------------------------------------------------
export async function proposeCorrectiveAction(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const ncrId = String(formData.get("ncrId") ?? "");
  const parsed = proposeActionSchema.safeParse({
    ncrId,
    description: formData.get("description"),
    assignedTo: (formData.get("assignedTo") as string) || null,
    dueDate: formData.get("dueDate") ?? "",
  });
  if (!parsed.success) {
    redirect(`/quality/ncrs/${ncrId}?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }
  const v = parsed.data;
  const supabase = await createClient();
  // The AFTER trigger cascades the NCR to corrective_action_proposed through
  // the marker seam — this action never touches the NCR's status itself.
  const { error } = await tbl(supabase)("ncr_corrective_actions").insert({
    org_id: ctx.org.id, // trigger-derived from the NCR; passed for RLS
    ncr_id: v.ncrId,
    description: v.description,
    assigned_to: v.assignedTo ?? null,
    due_date: orNull(v.dueDate),
  });
  if (error) {
    const code = /duplicate key|unique/i.test(error.message)
      ? "proposal_already_pending"
      : encodeURIComponent(error.message);
    redirect(`/quality/ncrs/${v.ncrId}?error=${code}`);
  }
  revalidatePath(`/quality/ncrs/${v.ncrId}`);
  redirect(`/quality/ncrs/${v.ncrId}?saved=action_proposed`);
}

export async function decideCorrectiveAction(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = decideActionSchema.safeParse({
    id: formData.get("id"),
    ncrId: formData.get("ncrId"),
    decision: formData.get("decision"),
    decisionReason: formData.get("decisionReason") ?? "",
  });
  if (!parsed.success) {
    const ncrId = String(formData.get("ncrId") ?? "");
    redirect(`/quality/ncrs/${ncrId}?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }
  const v = parsed.data;
  const supabase = await createClient();
  // Write-once: only a still-undecided row matches. decided_by/decided_at are
  // re-pinned server-side by the trigger; the admin gate is DB-enforced.
  const { error, count } = await tbl(supabase)("ncr_corrective_actions")
    .update(
      {
        decision: v.decision,
        decision_reason: orNull(v.decisionReason),
        decided_by: user.id,
        decided_at: new Date().toISOString(),
      },
      { count: "exact" },
    )
    .eq("id", v.id)
    .eq("org_id", ctx.org.id)
    .is("decision", null);
  if (error) redirect(`/quality/ncrs/${v.ncrId}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/quality/ncrs/${v.ncrId}?error=already_decided`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: `ncr_corrective_action.${v.decision}`,
    targetTable: "ncr_corrective_actions",
    targetId: v.id,
    metadata: { ncr_id: v.ncrId, reason: orNull(v.decisionReason) },
  }).catch(() => {});

  revalidatePath(`/quality/ncrs/${v.ncrId}`);
  redirect(`/quality/ncrs/${v.ncrId}?saved=action_${v.decision}`);
}

export async function completeCorrectiveAction(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = completeActionSchema.safeParse({
    id: formData.get("id"),
    ncrId: formData.get("ncrId"),
    completionComment: formData.get("completionComment"),
  });
  if (!parsed.success) {
    const ncrId = String(formData.get("ncrId") ?? "");
    redirect(`/quality/ncrs/${ncrId}?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }
  const v = parsed.data;
  const supabase = await createClient();
  // completed_at is server-pinned by the trigger; only an ACCEPTED,
  // not-yet-completed action matches.
  const { error, count } = await tbl(supabase)("ncr_corrective_actions")
    .update(
      {
        completed_at: new Date().toISOString(),
        completion_comment: v.completionComment,
      },
      { count: "exact" },
    )
    .eq("id", v.id)
    .eq("org_id", ctx.org.id)
    .eq("decision", "accepted")
    .is("completed_at", null);
  if (error) redirect(`/quality/ncrs/${v.ncrId}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/quality/ncrs/${v.ncrId}?error=not_completable`);
  revalidatePath(`/quality/ncrs/${v.ncrId}`);
  redirect(`/quality/ncrs/${v.ncrId}?saved=action_completed`);
}

// ---------------------------------------------------------------------------
// Close / cancel
// ---------------------------------------------------------------------------
export async function closeNcr(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = closeNcrSchema.safeParse({
    id: formData.get("id"),
    closureComment: formData.get("closureComment"),
  });
  if (!parsed.success) {
    const id = String(formData.get("id") ?? "");
    redirect(`/quality/ncrs/${id}?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }
  const v = parsed.data;
  const supabase = await createClient();
  // verified_by/verified_at are re-pinned to the session by the trigger — the
  // verifier attests as themselves, exactly like an inspection sign-off.
  const { error, count } = await tbl(supabase)("non_conformance_reports")
    .update(
      {
        status: "closed",
        closure_comment: v.closureComment,
        verified_by: user.id,
        verified_at: new Date().toISOString(),
      },
      { count: "exact" },
    )
    .eq("id", v.id)
    .eq("org_id", ctx.org.id)
    .eq("status", "completed");
  if (error) redirect(`/quality/ncrs/${v.id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/quality/ncrs/${v.id}?error=not_closable`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "non_conformance.closed",
    targetTable: "non_conformance_reports",
    targetId: v.id,
    metadata: { closure_comment: v.closureComment },
  }).catch(() => {});

  revalidatePath("/quality/ncrs");
  revalidatePath(`/quality/ncrs/${v.id}`);
  redirect(`/quality/ncrs/${v.id}?saved=closed`);
}

export async function cancelNcr(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = ncrIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/quality/ncrs?error=bad_id`);
  const id = parsed.data.id;
  const supabase = await createClient();
  // The DB decides who may cancel from which state (raiser-or-admin before an
  // approved fix, admin after) — surface its refusal honestly.
  const { error, count } = await tbl(supabase)("non_conformance_reports")
    .update({ status: "cancelled" }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .in("status", ["open", "corrective_action_proposed", "corrective_action_approved", "completed"]);
  if (error) redirect(`/quality/ncrs/${id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/quality/ncrs/${id}?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "non_conformance.cancelled",
    targetTable: "non_conformance_reports",
    targetId: id,
    metadata: {},
  }).catch(() => {});

  revalidatePath("/quality/ncrs");
  revalidatePath(`/quality/ncrs/${id}`);
  redirect(`/quality/ncrs/${id}?saved=cancelled`);
}
