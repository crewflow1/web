"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { round2, toPounds } from "@/lib/money";

/**
 * Billing-plan server actions (H2-CASH).
 *
 * All are OWNER/ADMIN only — a billing plan is job-level commercial config. The
 * app check gives a friendly error; the DB RLS (is_org_admin on the write
 * policies) is the real boundary, so a direct PostgREST caller is also refused.
 * Invoice generation goes through the atomic `generate_stage_invoice` RPC.
 */

function isManager(role: string): boolean {
  return role === "owner" || role === "admin";
}
function num(v: FormDataEntryValue | null): number {
  return round2(toPounds(typeof v === "string" ? v : 0));
}
// Chainable `.eq()` so a by-id write can ALSO carry the active-org pin
// (`.eq("id", …).eq("org_id", ctx.org.id)`) and a read can pin both id/plan_id
// AND org_id in one statement.
type LooseWrite = PromiseLike<{ error: unknown }> & {
  eq: (k: string, val: unknown) => LooseWrite;
};
type LooseRead = PromiseLike<{ data: Array<Record<string, unknown>> | null }> & {
  eq: (k: string, val: unknown) => LooseRead;
};
const looseFrom = (c: unknown) =>
  c as unknown as {
    from: (t: string) => {
      insert: (r: Record<string, unknown>) => { select: (c: string) => { single: () => Promise<{ data: { id: string } | null; error: unknown }> } };
      update: (v: Record<string, unknown>) => LooseWrite;
      delete: () => LooseWrite;
      select: (c: string) => LooseRead;
    };
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  };

/** Create the active billing plan for a job (one active plan per job). */
export async function createBillingPlan(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return;
  const jobId = String(formData.get("job_id") ?? "");
  const structure = String(formData.get("structure") ?? "staged");
  const basis = num(formData.get("basis_amount"));
  if (!jobId) return;

  const db = looseFrom(await createClient());
  await db.from("job_billing_plans").insert({
    org_id: ctx.org.id, job_id: jobId, structure, basis_amount: basis, status: "active", created_by: user.id,
  }).select("id").single();
  revalidatePath(`/jobs/${jobId}/billing`);
}

/** Add one stage to a plan, resolving its net amount server-side. */
export async function addBillingStage(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return;
  const jobId = String(formData.get("job_id") ?? "");
  const planId = String(formData.get("plan_id") ?? "");
  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  const kind = String(formData.get("kind") ?? "stage");
  const basis = String(formData.get("basis") ?? "fixed");
  const vatRate = num(formData.get("vat_rate")) || 20;
  const dueDate = String(formData.get("due_date") ?? "") || null;
  if (!jobId || !planId || !name) return;

  const db = looseFrom(await createClient());
  // Resolve the net amount: fixed → given; percent → % of the plan basis;
  // balance → the contract remainder (basis − Σ existing). The DB Σ≤basis guard
  // is the backstop; this keeps the stored amount correct + predictable.
  // Pin BOTH reads to the active org: job_billing_plans/_stages RLS admits every
  // org the caller belongs to, so an unpinned read of a dual-org member's other
  // plan would feed the wrong basis/existing sum into the amount resolution.
  const planRows = (await db.from("job_billing_plans").select("basis_amount").eq("id", planId).eq("org_id", ctx.org.id)).data ?? [];
  const planBasis = round2(toPounds(planRows[0]?.basis_amount as number | string | null));
  const existing = (await db.from("job_billing_stages").select("amount, sequence").eq("plan_id", planId).eq("org_id", ctx.org.id)).data ?? [];
  const existingSum = existing.reduce((acc, s) => round2(acc + toPounds(s.amount as number | string | null)), 0);
  const nextSeq = existing.reduce((mx, s) => Math.max(mx, Number(s.sequence ?? 0) + 1), 0);

  let amount = 0;
  let percent: number | null = null;
  if (kind === "balance") {
    amount = round2(Math.max(0, planBasis - existingSum));
  } else if (basis === "percent") {
    percent = num(formData.get("percent"));
    // Cap a percent stage at the running remainder so k independently-rounded
    // percent stages never overshoot the basis (which the DB Σ≤basis guard would
    // otherwise reject); the last stage absorbs the penny.
    const nominal = planBasis > 0 ? round2((planBasis * percent) / 100) : 0;
    const remaining = planBasis > 0 ? round2(Math.max(0, planBasis - existingSum)) : 0;
    amount = planBasis > 0 ? Math.min(nominal, remaining) : 0;
  } else {
    amount = num(formData.get("amount"));
  }

  const { error } = await db.from("job_billing_stages").insert({
    org_id: ctx.org.id, plan_id: planId, job_id: jobId, sequence: nextSeq,
    name, kind, basis: kind === "balance" ? "fixed" : basis, percent,
    amount, vat_rate: vatRate === 0 || vatRate === 5 || vatRate === 20 ? vatRate : 20,
    due_date: dueDate, created_by: user.id,
  }).select("id").single();
  // Surface (log) a rejected insert instead of silently no-op'ing (e.g. a fixed
  // stage that over-carves the contract is refused by the Σ≤basis guard).
  if (error) console.error("[billing] addBillingStage rejected", error);
  revalidatePath(`/jobs/${jobId}/billing`);
}

/** Generate the invoice for a stage (atomic + idempotent RPC). */
export async function generateStageInvoice(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return;
  const jobId = String(formData.get("job_id") ?? "");
  const stageId = String(formData.get("stage_id") ?? "");
  if (!stageId) return;
  const db = looseFrom(await createClient());
  // The RPC (SECURITY DEFINER) gates on is_org_admin(v_stage.org_id), which a
  // dual-org admin satisfies for BOTH orgs — it does not pin the ACTIVE org.
  // Assert the stage belongs to ctx.org.id here (a foreign/absent id → clean
  // no-op) so a member working in org A can't trigger invoicing on org B's stage.
  const stageRows = (await db.from("job_billing_stages").select("id").eq("id", stageId).eq("org_id", ctx.org.id)).data ?? [];
  if (stageRows.length === 0) return;
  await db.rpc("generate_stage_invoice", { p_stage_id: stageId, p_due_date: null });
  revalidatePath(`/jobs/${jobId}/billing`);
}

/** Delete a not-yet-invoiced stage. */
export async function deleteBillingStage(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return;
  const jobId = String(formData.get("job_id") ?? "");
  const stageId = String(formData.get("stage_id") ?? "");
  if (!stageId) return;
  const db = looseFrom(await createClient());
  // Only delete a stage that hasn't been invoiced (keep the billed record).
  // Both the read and the DELETE are pinned to the active org: the stages RLS
  // spans every org the caller belongs to, so without the pin a dual-org member
  // in org A could delete org B's stage.
  const rows = (await db.from("job_billing_stages").select("invoice_id").eq("id", stageId).eq("org_id", ctx.org.id)).data ?? [];
  if (rows.length === 0 || rows[0]?.invoice_id) return;
  await db.from("job_billing_stages").delete().eq("id", stageId).eq("org_id", ctx.org.id);
  revalidatePath(`/jobs/${jobId}/billing`);
}

/** Cancel the active plan (frees the job for a fresh plan). */
export async function cancelBillingPlan(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return;
  const jobId = String(formData.get("job_id") ?? "");
  const planId = String(formData.get("plan_id") ?? "");
  if (!planId) return;
  const db = looseFrom(await createClient());
  // Pin the active org: cancelling frees the job for a fresh plan, so an
  // unpinned by-id UPDATE would let a dual-org member cancel the other org's plan.
  await db.from("job_billing_plans").update({ status: "cancelled" }).eq("id", planId).eq("org_id", ctx.org.id);
  revalidatePath(`/jobs/${jobId}/billing`);
}
