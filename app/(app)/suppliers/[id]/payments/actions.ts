"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";

import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { createClient } from "@/lib/supabase/server";
import {
  recordSupplierPayment,
  voidSupplierPayment,
} from "@/server/services/supplier-payments";
import { supplierPaymentSchema, voidSupplierPaymentSchema } from "@/lib/suppliers/schema";
import { cisBillDetailsSchema, cisPaymentSchema } from "@/lib/cis/schema";
import { recordCisPayment, saveBillCisDetails } from "@/server/services/cis-deduction";
import { type FormState, formError, formSuccess } from "@/lib/forms/state";

/**
 * H2-CIS M2 server actions — recording and voiding supplier payments.
 *
 * OWNER/ADMIN ONLY. A server action is a POST endpoint, so a non-admin member
 * can replay it regardless of what the UI shows; the role is re-checked here so
 * they get a sentence instead of a policy violation. The REAL boundaries are the
 * admin-only RLS on both ledger tables and the `is_org_admin` gate inside
 * `record_supplier_payment`, which refuse a direct PostgREST caller identically.
 *
 * NOTE ON CIS AND COST: nothing in this file writes `finances`. Recording a
 * payment — with or without a CIS deduction — cannot change a job's cost or
 * margin. That is enforced structurally by the schema, not by care taken here.
 */

const isManager = (role: string): boolean => role === "owner" || role === "admin";

const idSchema = z.string().uuid();

type Values = Record<string, unknown>;

const FORBIDDEN = "Only an owner or admin can record supplier payments.";
const CIS_FORBIDDEN = "Only an owner or admin can set a bill's CIS details.";

function revalidate(supplierId: string): void {
  revalidatePath(`/suppliers/${supplierId}/payments`);
  revalidatePath(`/suppliers/${supplierId}`);
  revalidatePath("/suppliers");
}

// ---------------------------------------------------------------------------
// Record a payment
// ---------------------------------------------------------------------------

export async function recordPayment(
  supplierId: string,
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);
  if (!idSchema.safeParse(supplierId).success) return formError("Invalid supplier id.");

  // The allocation lines arrive as a JSON string in a hidden field (the array
  // shape FormData cannot carry) — same seam as the money-in allocate form.
  let allocations: unknown = [];
  try {
    allocations = JSON.parse(String(formData.get("allocations") ?? "[]"));
  } catch {
    return formError("Couldn't read the bill lines. Refresh the page and try again.");
  }

  const parsed = supplierPaymentSchema.safeParse({
    gross_amount: formData.get("gross_amount") ?? "",
    cis_withheld: formData.get("cis_withheld") ?? "0",
    paid_at: formData.get("paid_at") ?? "",
    method: formData.get("method") ?? "bank_transfer",
    reference: formData.get("reference") ?? "",
    notes: formData.get("notes") ?? "",
    allocations,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = typeof issue?.path[0] === "string" ? (issue.path[0] as string) : null;
    return {
      ok: false,
      error: issue?.message ?? "Check the payment details and try again.",
      fieldErrors: key ? { [key]: issue?.message ?? "" } : {},
      values: {},
      submittedAt: Date.now(),
    };
  }
  const input = parsed.data;

  // ── Idempotency / double-submit guard ────────────────────────────────────
  // A retried POST or a double-click racing the client-side disable would
  // otherwise record the SAME payment twice — real cash out, counted twice, and
  // (worse) the same CIS deduction reported to HMRC twice. The DB caps cannot
  // catch it: each duplicate is a distinct payment_id, each within its own
  // gross. So look for an identical payment from the same user in the last few
  // seconds and treat a match as a no-op. Mirrors payments/allocate-actions.ts.
  const supabase = await createClient();
  type DupeQ = {
    select: (c: string) => DupeQ;
    eq: (k: string, v: unknown) => DupeQ;
    is: (k: string, v: unknown) => DupeQ;
    gte: (k: string, v: unknown) => DupeQ;
    limit: (n: number) => DupeQ;
    maybeSingle: () => Promise<{ data: { id: string } | null }>;
  };
  const DEDUPE_WINDOW_MS = 10_000;
  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  let dupQuery = (supabase.from("supplier_payments" as never) as unknown as DupeQ)
    .select("id")
    .eq("org_id", ctx.org.id)
    .eq("supplier_id", supplierId)
    .eq("gross_amount", input.gross_amount)
    .eq("cis_withheld", input.cis_withheld)
    .eq("paid_at", input.paid_at)
    .eq("method", input.method)
    .eq("created_by", user.id)
    .gte("created_at", sinceIso)
    .limit(1);
  dupQuery = input.reference
    ? dupQuery.eq("reference", input.reference)
    : dupQuery.is("reference", null);
  const { data: existing } = await dupQuery.maybeSingle();
  if (existing) {
    console.warn("[supplier-payments] duplicate submit suppressed", {
      orgId: ctx.org.id,
      paymentId: existing.id,
    });
    revalidate(supplierId);
    return formSuccess({ successMessage: "Payment recorded." });
  }

  const result = await recordSupplierPayment(ctx.org.id, supplierId, input);
  if (!result.ok) return formError(result.error);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "supplier.payment.recorded",
    targetTable: "supplier_payments",
    targetId: result.data,
    metadata: {
      supplier_id: supplierId,
      gross_amount: input.gross_amount,
      cis_withheld: input.cis_withheld,
      net_paid: Math.round((input.gross_amount - input.cis_withheld) * 100) / 100,
      method: input.method,
      allocations: input.allocations.length,
    },
  }).catch(() => {});

  revalidate(supplierId);
  return formSuccess({
    successMessage:
      input.cis_withheld > 0
        ? `Payment recorded. £${input.cis_withheld.toFixed(2)} CIS withheld — this is HMRC's, not a saving, and the job cost is unchanged.`
        : "Payment recorded.",
  });
}

// ---------------------------------------------------------------------------
// H2-CIS M3 — the deduction basis of one bill
// ---------------------------------------------------------------------------

/**
 * Save what part of a bill is materials, what the CITB levy took off, and how VAT
 * is treated. This is the DEDUCTION BASIS — get it wrong and the return is wrong,
 * which is why the database freezes it the moment a CIS payment lands.
 */
export async function saveBillDetails(
  supplierId: string,
  financeId: string,
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(CIS_FORBIDDEN);
  if (!idSchema.safeParse(supplierId).success) return formError("Invalid supplier id.");
  if (!idSchema.safeParse(financeId).success) return formError("Invalid bill id.");

  const parsed = cisBillDetailsSchema.safeParse({
    materials_amount: formData.get("materials_amount") ?? "0",
    citb_levy_amount: formData.get("citb_levy_amount") ?? "0",
    vat_treatment: formData.get("vat_treatment") ?? "standard",
    reverse_charge_vat_rate: formData.get("reverse_charge_vat_rate") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = typeof issue?.path[0] === "string" ? (issue.path[0] as string) : null;
    return {
      ok: false,
      error: issue?.message ?? "Check the CIS details and try again.",
      fieldErrors: key ? { [key]: issue?.message ?? "" } : {},
      values: {},
      submittedAt: Date.now(),
    };
  }

  const result = await saveBillCisDetails(
    ctx.org.id,
    supplierId,
    financeId,
    parsed.data,
    user.id,
  );
  if (!result.ok) return formError(result.error);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "supplier.bill.cis_details_saved",
    targetTable: "cis_bill_details",
    targetId: financeId,
    metadata: {
      supplier_id: supplierId,
      materials_amount: parsed.data.materials_amount,
      citb_levy_amount: parsed.data.citb_levy_amount,
      vat_treatment: parsed.data.vat_treatment,
    },
  }).catch(() => {});

  revalidate(supplierId);
  return formSuccess({ successMessage: "CIS details saved." });
}

// ---------------------------------------------------------------------------
// H2-CIS M3 — record a CIS payment
// ---------------------------------------------------------------------------

/**
 * Record a payment with the CIS deduction WORKED OUT rather than typed in.
 *
 * THE RATE IS NOT AN INPUT. Neither is the basis, the deduction, or the amount
 * withheld — all four are derived inside `record_cis_supplier_payment` from the
 * subcontractor's HMRC verification state and the bills, and a SECURITY DEFINER
 * trigger independently recomputes and refuses anything that disagrees. A forged
 * `cis_rate` in the POST body cannot be honoured because it is never read.
 *
 * `expected_rate` IS read, but only as an assertion to check: if the form was
 * rendered at 20% and the subcontractor has since been re-verified at 30%, the
 * write is REFUSED rather than posted at a rate the operator never saw.
 */
export async function recordCisPaymentAction(
  supplierId: string,
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);
  if (!idSchema.safeParse(supplierId).success) return formError("Invalid supplier id.");

  let allocations: unknown = [];
  try {
    allocations = JSON.parse(String(formData.get("allocations") ?? "[]"));
  } catch {
    return formError("Couldn't read the bill lines. Refresh the page and try again.");
  }

  const parsed = cisPaymentSchema.safeParse({
    paid_at: formData.get("paid_at") ?? "",
    method: formData.get("method") ?? "bank_transfer",
    reference: formData.get("reference") ?? "",
    notes: formData.get("notes") ?? "",
    expected_rate: formData.get("expected_rate") ?? "",
    allocations,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = typeof issue?.path[0] === "string" ? (issue.path[0] as string) : null;
    return {
      ok: false,
      error: issue?.message ?? "Check the payment details and try again.",
      fieldErrors: key ? { [key]: issue?.message ?? "" } : {},
      values: {},
      submittedAt: Date.now(),
    };
  }
  const input = parsed.data;

  // ── Idempotency / double-submit guard ────────────────────────────────────
  // Identical reasoning to recordPayment above, and MORE important here: a
  // duplicated CIS payment reports the same deduction to HMRC twice. Matched on
  // the settled total (Σ allocations), which is what the RPC derives gross_amount
  // from — the withheld amount is not known client-side and cannot be matched on.
  const settled =
    Math.round(input.allocations.reduce((sum, a) => sum + a.amount, 0) * 100) / 100;
  const supabase = await createClient();
  type DupeQ = {
    select: (c: string) => DupeQ;
    eq: (k: string, v: unknown) => DupeQ;
    is: (k: string, v: unknown) => DupeQ;
    gte: (k: string, v: unknown) => DupeQ;
    limit: (n: number) => DupeQ;
    maybeSingle: () => Promise<{ data: { id: string } | null }>;
  };
  const sinceIso = new Date(Date.now() - 10_000).toISOString();
  let dupQuery = (supabase.from("supplier_payments" as never) as unknown as DupeQ)
    .select("id")
    .eq("org_id", ctx.org.id)
    .eq("supplier_id", supplierId)
    .eq("gross_amount", settled)
    .eq("paid_at", input.paid_at)
    .eq("method", input.method)
    .eq("created_by", user.id)
    .gte("created_at", sinceIso)
    .limit(1);
  dupQuery = input.reference
    ? dupQuery.eq("reference", input.reference)
    : dupQuery.is("reference", null);
  const { data: existing } = await dupQuery.maybeSingle();
  if (existing) {
    console.warn("[cis-payments] duplicate submit suppressed", {
      orgId: ctx.org.id,
      paymentId: existing.id,
    });
    revalidate(supplierId);
    return formSuccess({ successMessage: "Payment recorded." });
  }

  const result = await recordCisPayment(ctx.org.id, supplierId, input);
  if (!result.ok) return formError(result.error);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "supplier.payment.cis_recorded",
    targetTable: "supplier_payments",
    targetId: result.data,
    metadata: {
      supplier_id: supplierId,
      settled,
      method: input.method,
      allocations: input.allocations.length,
      // The rate the CLIENT believed applied. The rate actually used is frozen in
      // cis_payment_snapshots by the database — this is only what was on screen.
      expected_rate: input.expected_rate ?? null,
    },
  }).catch(() => {});

  revalidate(supplierId);
  return formSuccess({
    successMessage:
      "Payment recorded. The CIS deduction was worked out from the labour element and the " +
      "verified rate, and is now locked to this payment.",
  });
}

// ---------------------------------------------------------------------------
// Void a payment (the only correction path)
// ---------------------------------------------------------------------------

export async function voidPayment(
  supplierId: string,
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);
  if (!idSchema.safeParse(supplierId).success) return formError("Invalid supplier id.");

  const parsed = voidSupplierPaymentSchema.safeParse({
    payment_id: formData.get("payment_id") ?? "",
    void_reason: formData.get("void_reason") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Say why the payment is being voided.");
  }

  const result = await voidSupplierPayment(
    ctx.org.id,
    parsed.data.payment_id,
    parsed.data.void_reason,
    user.id,
  );
  if (!result.ok) return formError(result.error);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "supplier.payment.voided",
    targetTable: "supplier_payments",
    targetId: parsed.data.payment_id,
    metadata: { supplier_id: supplierId, reason: parsed.data.void_reason },
  }).catch(() => {});

  revalidate(supplierId);
  return formSuccess({
    successMessage: "Payment voided. It stays on the record — now record the correct one.",
  });
}
