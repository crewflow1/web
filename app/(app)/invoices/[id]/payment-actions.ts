"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
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
  const { user } = await requireOrgContext();
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

  const { error } = await supabase.from("invoice_payments").insert({
    org_id: inv.org_id,
    invoice_id: invoiceId,
    amount: result.data.amount,
    paid_at: result.data.paid_at,
    reference: result.data.reference ?? null,
    notes: result.data.notes ?? null,
    source: "manual",
    created_by: user.id,
  });
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

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
  revalidatePath("/dashboard");
  return formSuccess({ successMessage: "Payment recorded." });
}

export async function removeInvoicePayment(paymentId: string) {
  const { ctx } = await requireOrgContext();
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

  const { error } = await supabase
    .from("invoice_payments")
    .delete()
    .eq("id", paymentId);
  if (error) {
    console.error("[invoice-payment] remove failed", error);
    redirect(`/invoices/${row.invoice_id}?error=remove_failed`);
  }

  revalidatePath(`/invoices/${row.invoice_id}`);
  revalidatePath("/invoices");
  revalidatePath("/dashboard");
  redirect(`/invoices/${row.invoice_id}?saved=payment_removed`);
}
