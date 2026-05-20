"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { addPaymentSchema } from "@/lib/payments/schema";
import { z } from "zod";

const uuid = z.string().uuid();

/**
 * Manually record a payment against an invoice.
 * Status auto-derives from the trigger:
 *   sum(payments) >= total  → 'paid'
 *   0 < sum(payments) < total → 'partially_paid'
 */
export async function addInvoicePayment(invoiceId: string, formData: FormData) {
  const { ctx, user } = await requireOrgContext();
  if (!uuid.safeParse(invoiceId).success) redirect("/invoices");

  const parsed = addPaymentSchema.safeParse({
    amount: formData.get("amount") ?? "",
    paid_at: formData.get("paid_at") ?? "",
    reference: formData.get("reference") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid payment";
    redirect(`/invoices/${invoiceId}?error=${encodeURIComponent(msg)}`);
  }

  const supabase = await createClient();
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, total, org_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) redirect("/invoices?error=not_found");

  const { error } = await supabase.from("invoice_payments").insert({
    org_id: inv.org_id,
    invoice_id: invoiceId,
    amount: parsed.data.amount,
    paid_at: parsed.data.paid_at,
    reference: parsed.data.reference ?? null,
    notes: parsed.data.notes ?? null,
    source: "manual",
    created_by: user.id,
  });
  if (error) {
    console.error("[invoice-payment] insert failed", error);
    redirect(`/invoices/${invoiceId}?error=payment_failed`);
  }

  void ctx;
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
  revalidatePath("/dashboard");
  redirect(`/invoices/${invoiceId}?saved=payment_recorded`);
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
