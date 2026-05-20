import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InvoicePdf, type InvoicePdfInput } from "@/lib/pdf/invoice-pdf";
import { sendEmail } from "@/lib/email/send";
import { buildInvoiceEmail } from "@/lib/email/templates/invoice";
import { env } from "@/lib/env";

/**
 * Send an invoice PDF email by invoice id, using whichever Supabase
 * client the caller provides (user-scoped or service-role).
 *
 * Used by:
 *   - POST /api/invoices/[id]/send (on-demand)
 *   - acceptQuoteByToken / acceptQuoteAsOwner (auto-email on accept)
 *
 * Side effects on success:
 *   - Stamps invoices.sent_at = now
 *   - Flips invoices.status from 'draft' -> 'sent' (the existing trigger
 *     emits invoice.sent into activity_log on that transition)
 *
 * Never throws. All outcomes are returned via the result tuple so callers
 * can decide whether a downstream failure should affect their own response.
 */

export type SendInvoiceEmailResult =
  | { sent: true; emailId: string; to: string; sent_at: string; new_status: string }
  | { sent: false; reason: "no_resend_key" | "not_found" | "no_recipient" | "invalid_recipient" | "load_failed" | "send_failed"; detail?: string };

type InvoiceJoined = {
  id: string;
  number: string;
  status: string;
  amount: number | string | null;
  vat_total: number | string | null;
  total: number | string | null;
  due_date: string | null;
  paid_at: string | null;
  notes: string | null;
  quote_id: string | null;
  quote: {
    customer: { name: string | null; email: string | null } | null;
  } | null;
  org: {
    name: string | null;
    phone: string | null;
    vat_number: string | null;
    logo_url: string | null;
    address: unknown;
    bank_details: unknown;
  } | null;
};

export async function sendInvoiceEmail(
  supabase: SupabaseClient,
  invoiceId: string,
  options: { to?: string; message?: string } = {},
): Promise<SendInvoiceEmailResult> {
  if (!env.RESEND_API_KEY) {
    return { sent: false, reason: "no_resend_key" };
  }

  const { data: invoiceRaw, error: iErr } = await supabase
    .from("invoices")
    .select(
      `
        id, number, status, amount, vat_total, total, due_date, paid_at,
        notes, quote_id,
        quote:quotes ( customer:customers ( name, email ) ),
        org:organizations ( name, phone, vat_number, logo_url, address, bank_details )
      `,
    )
    .eq("id", invoiceId)
    .maybeSingle();
  const invoice = invoiceRaw as unknown as InvoiceJoined | null;

  if (iErr) {
    console.error("[send-invoice] load failed", iErr);
    return { sent: false, reason: "load_failed", detail: iErr.message };
  }
  if (!invoice) return { sent: false, reason: "not_found" };

  const recipient = options.to ?? invoice.quote?.customer?.email ?? null;
  if (!recipient) return { sent: false, reason: "no_recipient" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { sent: false, reason: "invalid_recipient" };
  }

  const { data: lines } = invoice.quote_id
    ? await supabase
        .from("quote_line_items")
        .select("description, qty, unit_price, vat_rate, line_total, sort_order")
        .eq("quote_id", invoice.quote_id)
        .order("sort_order", { ascending: true })
    : { data: [] };

  const pdfInput: InvoicePdfInput = {
    number: invoice.number,
    status: invoice.status,
    amount: Number(invoice.amount ?? 0),
    vat_total: Number(invoice.vat_total ?? 0),
    total: Number(invoice.total ?? 0),
    due_date: invoice.due_date,
    paid_at: invoice.paid_at,
    notes: invoice.notes,
    customer_name: invoice.quote?.customer?.name ?? null,
    org_name: invoice.org?.name ?? "CrewFlow",
    org_phone: invoice.org?.phone ?? null,
    org_vat_number: invoice.org?.vat_number ?? null,
    org_logo_url: invoice.org?.logo_url ?? null,
    org_address: (invoice.org?.address as InvoicePdfInput["org_address"]) ?? null,
    org_bank_details:
      (invoice.org?.bank_details as InvoicePdfInput["org_bank_details"]) ?? null,
    line_items: (lines ?? []).map((li) => ({
      description: li.description,
      qty: Number(li.qty),
      unit_price: Number(li.unit_price),
      vat_rate: Number(li.vat_rate),
      line_total: Number(li.line_total),
    })),
  };
  const pdfBuffer = await renderToBuffer(InvoicePdf({ inv: pdfInput }));

  const { html, text, subject } = buildInvoiceEmail({
    org_name: pdfInput.org_name,
    customer_name: pdfInput.customer_name,
    invoice_number: invoice.number,
    total: pdfInput.total,
    due_date: invoice.due_date,
    message: options.message ?? null,
    pdf_url: null,
  });

  const result = await sendEmail({
    to: recipient,
    subject,
    html,
    text,
    attachments: [{ filename: `${invoice.number}.pdf`, content: pdfBuffer }],
  });
  if (!result.sent) {
    return {
      sent: false,
      reason: result.reason === "no_key" ? "no_resend_key" : "send_failed",
      detail: "error" in result ? result.error : undefined,
    };
  }

  const sentAt = new Date().toISOString();
  const updates: { sent_at: string; status?: "sent" } = { sent_at: sentAt };
  if (invoice.status === "draft") updates.status = "sent";
  const { error: updErr } = await supabase
    .from("invoices")
    .update(updates)
    .eq("id", invoice.id);
  if (updErr) {
    // Email went out — we should not mask the success. Log + report.
    console.error("[send-invoice] post-send update failed", updErr);
  }

  return {
    sent: true,
    emailId: result.id,
    to: recipient,
    sent_at: sentAt,
    new_status: updates.status ?? invoice.status,
  };
}
