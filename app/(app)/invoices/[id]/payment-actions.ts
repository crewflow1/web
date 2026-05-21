"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { addPaymentSchema } from "@/lib/payments/schema";
import { z } from "zod";
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
  if (!uuid.safeParse(invoiceId).success) return formError("Invalid invoice id.");

  const result = validateFormData(formData, addPaymentSchema);
  if (!result.ok) return result.state as FormState<PaymentValues>;

  const supabase = await createClient();
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, total, org_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) {
    return formError(
      "Invoice not found.",
      result.data as PaymentValues,
    );
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
    console.error("[invoice-payment] insert failed", error);
    return formError(
      "Couldn't record payment. Try again.",
      result.data as PaymentValues,
    );
  }

  void ctx;
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
  const { data: row } = await supabase
    .from("invoice_payments")
    .select("invoice_id, org_id")
    .eq("id", paymentId)
    .maybeSingle();
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
