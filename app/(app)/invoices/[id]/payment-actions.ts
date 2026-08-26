"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext, requireManagementRole } from "@/server/auth/session";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";
import { addPaymentSchema } from "@/lib/payments/schema";
import { z } from "zod";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

const uuid = z.string().uuid();

type PaymentValues = Record<string, unknown>;

/**
 * Manually record a payment against an invoice.
 * Status auto-derives from the trigger:
 *   sum(payments) >= total  → 'paid'
 *   0 < sum(payments) < total → 'partially_paid'
 */
export async function addInvoicePayment(
  invoiceId: string,
  _prevState: FormState<PaymentValues>,
  formData: FormData,
): Promise<FormState<PaymentValues>> {
  const { ctx, user } = await requireOrgContext();
  requireManagementRole(ctx); // money mutation (fix 1)
  if (!uuid.safeParse(invoiceId).success) return formError("Invalid invoice id.");

  const result = validateFormData(formData, addPaymentSchema);
  if (!result.ok) return result.state as FormState<PaymentValues>;

  const supabase = await createClient();
  // Capture the lookup error explicitly: a transient SELECT failure used to
  // fall through to the `!inv` branch below and report "Invoice not found",
  // which is misleading (the invoice exists; the DB was briefly unreachable).
  const { data: inv, error: invErr } = await supabase
    .from("invoices")
    .select("id, total, org_id")
    .eq("id", invoiceId)
    // ACTIVE-org pin (#456 read-side class). RLS admits every org the viewer
    // belongs to; without this a dual-org member could record a payment against
    // the OTHER org's invoice (the row's org_id is stamped straight onto the
    // inserted payment). Pinning makes a foreign invoice a clean "not found".
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (invErr) {
    console.error("[invoice-payment] invoice lookup failed", {
      invoiceId,
      code: invErr.code,
      message: invErr.message,
    });
    return formError(
      "Couldn't load the invoice just now. Please try again.",
      result.data as PaymentValues,
    );
  }
  if (!inv) {
    return formError("Invoice not found.", result.data as PaymentValues);
  }

  // Idempotency / double-submit guard.
  // The submit button is disabled client-side while pending, but that does
  // NOT stop a retried request (e.g. the browser re-POSTing after a transient
  // network blip, or an impatient double click that races the disable) from
  // recording the same money twice. Before inserting we look for an identical
  // payment from the same user in the last few seconds; if one exists we treat
  // this call as an idempotent no-op and report success rather than duplicating
  // the payment. The match is tight enough (same invoice + amount + date +
  // reference + user, within 10s) that two genuinely distinct payments can't
  // collide in practice.
  const DEDUPE_WINDOW_MS = 10_000;
  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  let dupQuery = supabase
    .from("invoice_payments")
    .select("id")
    .eq("invoice_id", invoiceId)
    .eq("amount", result.data.amount)
    .eq("paid_at", result.data.paid_at)
    .eq("created_by", user.id)
    .gte("created_at", sinceIso)
    .limit(1);
  dupQuery = result.data.reference
    ? dupQuery.eq("reference", result.data.reference)
    : dupQuery.is("reference", null);
  const { data: existing } = await dupQuery.maybeSingle();
  if (existing) {
    console.warn("[invoice-payment] duplicate submit suppressed", {
      invoiceId,
      orgId: inv.org_id,
      paymentId: existing.id,
    });
    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath("/invoices");
    revalidatePath("/dashboard");
    return formSuccess({ successMessage: "Payment recorded." });
  }

  const { data: inserted, error } = await supabase
    .from("invoice_payments").insert({
      org_id: inv.org_id,
      invoice_id: invoiceId,
      amount: result.data.amount,
      paid_at: result.data.paid_at,
      reference: result.data.reference ?? null,
      notes: result.data.notes ?? null,
      source: "manual",
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) {
    // Log the full Postgres error shape (code/details/hint) so a recurrence
    // is diagnosable from logs instead of guessable. The user still gets a
    // safe generic message — and crucially we return formError, never a false
    // success, so the UI cannot show "Payment recorded" on a failed write.
    console.error("[invoice-payment] insert failed", {
      invoiceId,
      orgId: inv.org_id,
      userId: user.id,
      amount: result.data.amount,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return formError(
      "Couldn't record payment. Try again.",
      result.data as PaymentValues,
    );
  }

  // Automation OS — a payment recorded here is as real as one recorded via the
  // allocate flow, so it fires the same `payment.recorded` event. Keyed on the
  // unique invoice_payments row id (a distinct correlation from the allocate
  // path's `payments` receipt id), org-pinned to inv.org_id, and best-effort so
  // an automation failure never fails the recorded payment. Dark by default —
  // the only rule on this trigger ships enabled:false.
  if (inserted?.id) {
    await dispatchAutomation({
      type: "payment.recorded",
      org_id: inv.org_id,
      source_table: "invoice_payments",
      source_id: inserted.id,
      payload: {
        amount: result.data.amount,
        invoice_id: invoiceId,
        source: "manual",
      },
      actor_email: user.email ?? null,
    }).catch((e) => {
      console.error("[invoice-payment] automation dispatch failed", e);
    });
  }

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
  revalidatePath("/dashboard");
  return formSuccess({ successMessage: "Payment recorded." });
}

export async function removeInvoicePayment(paymentId: string) {
  const { ctx } = await requireOrgContext();
  requireManagementRole(ctx); // money mutation (fix 1)
  if (!uuid.safeParse(paymentId).success) redirect("/invoices");

  const supabase = await createClient();
  // Lookup so we can revalidate the right invoice path.
  const { data: row, error: rowError } = await supabase
    .from("invoice_payments")
    .select("invoice_id, org_id")
    .eq("id", paymentId)
    .maybeSingle();
  if (rowError) throw readFailure("invoice payments: remove lookup", rowError);
  if (!row) redirect("/invoices?error=not_found");
  if (row.org_id !== ctx.org.id) redirect("/invoices?error=forbidden");

  // Belt-and-braces: the row above is already org-compared (row.org_id !==
  // ctx.org.id → forbidden), but pin the DELETE itself to the active org too so
  // the destructive statement is self-scoping and cannot drift from the check.
  const { error } = await supabase
    .from("invoice_payments")
    .delete()
    .eq("id", paymentId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[invoice-payment] remove failed", error);
    redirect(`/invoices/${row.invoice_id}?error=remove_failed`);
  }

  revalidatePath(`/invoices/${row.invoice_id}`);
  revalidatePath("/invoices");
  revalidatePath("/dashboard");
  redirect(`/invoices/${row.invoice_id}?saved=payment_removed`);
}

/**
 * Void an issued invoice (20261219) — the operational correction for an
 * invoice raised in error, WITHOUT deleting accounting evidence.
 *
 * The DB trigger (tg_invoices_void_guard) is the authority: it refuses paid /
 * partially-paid invoices and anything with a payments row (that correction is
 * a credit-note workflow, deliberately not built), requires a reason, stamps
 * voided_at itself, and makes void terminal. This action just carries the
 * caller's identity + reason and translates the refusal into a friendly
 * banner. Management-only: voiding changes what the business is owed.
 */
export async function voidInvoice(invoiceId: string, formData: FormData) {
  const { ctx, user } = await requireOrgContext();
  requireManagementRole(ctx);
  const id = uuid.parse(invoiceId);
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < 3) {
    redirect(`/invoices/${id}?error=void_reason_required`);
  }

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("invoices")
    .update(
      {
        // Pre-regen bridge (20261219): the generated enum gains 'void' after
        // the prod apply + `npm run db:types`; remove the cast then.
        status: "void" as never,
        void_reason: reason.slice(0, 2000),
        voided_by: user.id,
      } as never,
      { count: "exact" },
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id);

  if (error) {
    // The trigger's refusals (paid / has payments / terminal) surface here.
    const message = error.message ?? "";
    const code = message.includes("recorded payments")
      ? "void_has_payments"
      : message.includes("final")
        ? "void_terminal"
        : "void_failed";
    console.error("[invoices] void refused", { id, code, message });
    redirect(`/invoices/${id}?error=${code}`);
  }
  if (!count) redirect(`/invoices/${id}?error=void_failed`);

  revalidatePath(`/invoices/${id}`);
  revalidatePath("/invoices");
  revalidatePath("/dashboard");
  redirect(`/invoices/${id}?saved=voided`);
}
