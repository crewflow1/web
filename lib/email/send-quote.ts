import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QuotePdf, type QuotePdfInput } from "@/lib/pdf/quote-pdf";
import { sendEmail } from "@/lib/email/send";
import { buildQuoteEmail } from "@/lib/email/templates/quote";
import { env } from "@/lib/env";

/**
 * Render + email a quote PDF, with a portal link the customer uses to view,
 * approve or reject (which stamps viewed_at / accepted_at / declined_at).
 *
 * Mirrors lib/email/send-invoice.ts. Ensures a public_token exists, stamps
 * quotes.sent_at and flips status to "sent" unless already accepted/declined.
 * Never throws — outcomes returned via the result tuple.
 */

export type SendQuoteEmailResult =
  | { sent: true; emailId: string; to: string; sent_at: string; new_status: string; portal_url: string }
  | { sent: false; reason: "no_resend_key" | "not_found" | "no_recipient" | "invalid_recipient" | "load_failed" | "send_failed"; detail?: string };

type QuoteJoined = {
  id: string;
  number: string;
  status: string;
  subtotal: number | string | null;
  vat_total: number | string | null;
  total: number | string | null;
  valid_until: string | null;
  notes: string | null;
  terms: string | null;
  public_token: string | null;
  customer: { name: string | null; email: string | null } | null;
  org: {
    name: string | null;
    phone: string | null;
    vat_number: string | null;
    logo_url: string | null;
    address: unknown;
    bank_details: unknown;
  } | null;
};

type SendOptions = { to?: string; message?: string };

export async function sendQuoteEmail(
  supabase: SupabaseClient,
  quoteId: string,
  options: SendOptions = {},
): Promise<SendQuoteEmailResult> {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "no_resend_key" };

  const { data: quoteRaw, error: qErr } = await supabase
    .from("quotes")
    .select(
      `
        id, number, status, subtotal, vat_total, total, valid_until, notes, terms, public_token,
        customer:customers ( name, email ),
        org:organizations ( name, phone, vat_number, logo_url, address, bank_details )
      `,
    )
    .eq("id", quoteId)
    .maybeSingle();
  const quote = quoteRaw as unknown as QuoteJoined | null;

  if (qErr) {
    console.error("[send-quote] load failed", qErr);
    return { sent: false, reason: "load_failed", detail: qErr.message };
  }
  if (!quote) return { sent: false, reason: "not_found" };

  const recipient = options.to ?? quote.customer?.email ?? null;
  if (!recipient) return { sent: false, reason: "no_recipient" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { sent: false, reason: "invalid_recipient" };
  }

  // Ensure a public token exists for the approve/reject portal link.
  let token = quote.public_token;
  if (!token) {
    token = crypto.randomUUID();
    const { error: tErr } = await supabase
      .from("quotes")
      .update({ public_token: token })
      .eq("id", quote.id);
    if (tErr) {
      console.error("[send-quote] token allocation failed", tErr);
      return { sent: false, reason: "load_failed", detail: tErr.message };
    }
  }
  const portalUrl = `${env.NEXT_PUBLIC_APP_URL}/q/${token}`;

  const { data: lines } = await supabase
    .from("quote_line_items")
    .select("description, qty, unit_price, vat_rate, line_total, sort_order")
    .eq("quote_id", quote.id)
    .order("sort_order", { ascending: true });

  const pdfInput: QuotePdfInput = {
    number: quote.number,
    status: quote.status,
    subtotal: Number(quote.subtotal ?? 0),
    vat_total: Number(quote.vat_total ?? 0),
    total: Number(quote.total ?? 0),
    valid_until: quote.valid_until,
    notes: quote.notes,
    terms: quote.terms,
    customer_name: quote.customer?.name ?? null,
    org_name: quote.org?.name ?? "CrewFlow",
    org_phone: quote.org?.phone ?? null,
    org_vat_number: quote.org?.vat_number ?? null,
    org_logo_url: quote.org?.logo_url ?? null,
    org_address: (quote.org?.address as QuotePdfInput["org_address"]) ?? null,
    org_bank_details:
      (quote.org?.bank_details as QuotePdfInput["org_bank_details"]) ?? null,
    line_items: (lines ?? []).map((li) => ({
      description: li.description,
      qty: Number(li.qty),
      unit_price: Number(li.unit_price),
      vat_rate: Number(li.vat_rate),
      line_total: Number(li.line_total),
    })),
  };
  const pdfBuffer = await renderToBuffer(QuotePdf({ q: pdfInput }));

  const { html, text, subject } = buildQuoteEmail({
    org_name: pdfInput.org_name,
    customer_name: pdfInput.customer_name,
    quote_number: quote.number,
    total: pdfInput.total,
    valid_until: quote.valid_until,
    message: options.message ?? null,
    portal_url: portalUrl,
  });

  const result = await sendEmail({
    to: recipient,
    subject,
    html,
    text,
    attachments: [{ filename: `${quote.number}.pdf`, content: pdfBuffer }],
  });
  if (!result.sent) {
    return {
      sent: false,
      reason: result.reason === "no_key" ? "no_resend_key" : "send_failed",
      detail: "error" in result ? result.error : undefined,
    };
  }

  const sentAt = new Date().toISOString();
  // Reflect the send in status unless the customer already decided.
  const updates: { sent_at: string; status?: string } = { sent_at: sentAt };
  if (quote.status !== "accepted" && quote.status !== "declined") {
    updates.status = "sent";
  }
  const { error: updErr } = await supabase
    .from("quotes")
    .update(updates)
    .eq("id", quote.id);
  if (updErr) console.error("[send-quote] post-send update failed", updErr);

  return {
    sent: true,
    emailId: result.id,
    to: recipient,
    sent_at: sentAt,
    new_status: updates.status ?? quote.status,
    portal_url: portalUrl,
  };
}
