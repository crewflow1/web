import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { InvoicePdf, type InvoicePdfInput } from "@/lib/pdf/invoice-pdf";
import { sendEmail } from "@/lib/email/send";
import { buildInvoiceEmail } from "@/lib/email/templates/invoice";
import { env } from "@/lib/env";

// PDF rendering is Node only.
export const runtime = "nodejs";

/**
 * POST /api/invoices/[id]/send
 *
 * Renders the invoice PDF server-side, emails it as an attachment to the
 * customer (with cc to the org reply-to), stamps invoices.sent_at, and
 * advances invoice.status to "sent" if it was draft. Activity log entry
 * is emitted by the existing invoices trigger via the status change.
 *
 * Body (optional JSON):
 *   {
 *     to?:      override recipient email (defaults to customer.email),
 *     message?: free-text note prepended to the email body
 *   }
 */

type Ctx = { params: Promise<{ id: string }> };

type InvoiceRow = {
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

export async function POST(request: NextRequest, { params }: Ctx) {
  await requireOrgContext();
  const { id } = await params;

  if (!env.RESEND_API_KEY) {
    return NextResponse.json(
      {
        error: "email_not_configured",
        detail:
          "RESEND_API_KEY is not set in this environment. Add it in Vercel and verify the sender domain in Resend.",
      },
      { status: 503 },
    );
  }

  let body: { to?: string; message?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const supabase = await createClient();
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
    .eq("id", id)
    .maybeSingle();
  const invoice = invoiceRaw as unknown as InvoiceRow | null;

  if (iErr) {
    console.error("[invoice-send] load failed", iErr);
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
  if (!invoice) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const recipient = body.to ?? invoice.quote?.customer?.email ?? null;
  if (!recipient) {
    return NextResponse.json(
      {
        error: "no_recipient",
        detail:
          "This invoice's customer has no email on file. Add a 'to' override in the request body, or set the customer's email under /customers.",
      },
      { status: 400 },
    );
  }
  // Crude RFC-ish email shape check — catches typos without pulling a lib.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return NextResponse.json({ error: "invalid_recipient" }, { status: 400 });
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
    org_address:
      (invoice.org?.address as InvoicePdfInput["org_address"]) ?? null,
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
    message: body.message ?? null,
    pdf_url: null, // attachment is the canonical delivery
  });

  const result = await sendEmail({
    to: recipient,
    subject,
    html,
    text,
    attachments: [
      {
        filename: `${invoice.number}.pdf`,
        content: pdfBuffer,
      },
    ],
  });

  if (!result.sent) {
    if (result.reason === "no_key") {
      return NextResponse.json(
        { error: "email_not_configured" },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "send_failed", detail: result.error },
      { status: 502 },
    );
  }

  // Stamp sent_at + advance to "sent" if currently draft.
  // RLS-scoped via the user JWT (members can update own org rows).
  const nowIso = new Date().toISOString();
  const updates: { sent_at: string; status?: "sent" } = { sent_at: nowIso };
  if (invoice.status === "draft") updates.status = "sent";
  const { error: updErr } = await supabase
    .from("invoices")
    .update(updates)
    .eq("id", invoice.id);
  if (updErr) {
    // Email already went out — don't 500, but tell the caller.
    console.error("[invoice-send] post-send update failed", updErr);
    return NextResponse.json({
      sent: true,
      email_id: result.id,
      to: recipient,
      warning: "email_sent_but_status_update_failed",
    });
  }

  return NextResponse.json({
    sent: true,
    email_id: result.id,
    to: recipient,
    sent_at: nowIso,
    new_status: updates.status ?? invoice.status,
  });
}
