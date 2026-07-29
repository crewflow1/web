import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InvoicePdf, type InvoicePdfInput } from "@/lib/pdf/invoice-pdf";
import { sendEmail } from "@/lib/email/send";
import { buildInvoiceEmail } from "@/lib/email/templates/invoice";
import {
  buildInvoiceReminder,
  type ReminderStage,
} from "@/lib/email/templates/reminders";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";
import { env } from "@/lib/env";

/**
 * Render + send an invoice PDF.
 *
 * Two send modes:
 *   - kind="initial" (default): the original "here's your invoice" email,
 *     uses lib/email/templates/invoice. Stamps invoices.sent_at and flips
 *     draft → sent. Used by the manual "Send" button + auto-send on quote
 *     accept.
 *   - kind="reminder": stage-driven copy from lib/email/templates/reminders.
 *     Does NOT change invoices.sent_at or status (those reflect the
 *     original send). The reminder row is the audit trail.
 *
 * Never throws. All outcomes are returned via the result tuple.
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
  // Direct customer anchor (Issue #349 Phase 1) — preferred over the quote path.
  customer: { name: string | null; email: string | null } | null;
  quote: {
    customer: { name: string | null; email: string | null } | null;
  } | null;
  org: {
    name: string | null;
    phone: string | null;
    vat_number: string | null;
    logo_path: string | null;
    logo_url: string | null;
    address: unknown;
    bank_details: unknown;
  } | null;
};

type SendOptions = {
  to?: string;
  message?: string;
  /** Defaults to "initial" — the standard invoice send. */
  kind?: "initial" | "reminder";
  /** Required when kind="reminder"; ignored otherwise. */
  reminder_stage?: ReminderStage;
  /**
   * ACTIVE-ORG SCOPE — pass `ctx.org.id` from any interactive (user-JWT)
   * caller.
   *
   * Without it this helper resolves the invoice by primary key alone. RLS does
   * NOT save us: `current_org_ids()` deliberately returns EVERY org the viewer
   * belongs to (it is the outer boundary — "you cannot see an org you are not a
   * member of" — not active-org scoping). So for a user who belongs to org A
   * and org B, working in A, an org-B invoice id resolved here would render
   * B's letterhead and BANK DETAILS into a PDF and EMAIL it to B's customer,
   * then stamp B's `sent_at` and flip B's status. This is the outward-facing
   * end of the active-org defect class fixed for the jobs domain in #456.
   *
   * Optional because the two service-role callers legitimately have no active
   * org: the reminder cron and the public quote-acceptance path already select
   * the invoice themselves and own their scoping. Omitting it preserves their
   * behaviour exactly; supplying it makes a foreign invoice indistinguishable
   * from a missing one (`reason: "not_found"`).
   */
  orgId?: string;
};

export async function sendInvoiceEmail(
  supabase: SupabaseClient,
  invoiceId: string,
  options: SendOptions = {},
): Promise<SendInvoiceEmailResult> {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "no_resend_key" };

  const invoiceQuery = supabase
    .from("invoices")
    .select(
      `
        id, number, status, amount, vat_total, total, due_date, paid_at,
        notes, quote_id,
        customer:customers!invoices_customer_org_fkey ( name, email ),
        quote:quotes ( customer:customers ( name, email ) ),
        org:organizations ( name, phone, vat_number, logo_path, logo_url, address, bank_details )
      `,
    )
    .eq("id", invoiceId);
  // Active-org scope (see SendOptions.orgId). A foreign invoice yields no row,
  // so it is indistinguishable from a missing one and nothing is ever rendered
  // or sent for it.
  const { data: invoiceRaw, error: iErr } = await (options.orgId
    ? invoiceQuery.eq("org_id", options.orgId)
    : invoiceQuery
  ).maybeSingle();
  const invoice = invoiceRaw as unknown as InvoiceJoined | null;

  if (iErr) {
    console.error("[send-invoice] load failed", iErr);
    return { sent: false, reason: "load_failed", detail: iErr.message };
  }
  if (!invoice) return { sent: false, reason: "not_found" };

  // Recipient resolves via the invoice's OWN customer first (Issue #349 Phase
  // 1), so a sent invoice whose quote was later deleted is still emailable; the
  // quote's customer is the legacy-orphan fallback.
  const recipient =
    options.to ??
    invoice.customer?.email ??
    invoice.quote?.customer?.email ??
    null;
  if (!recipient) return { sent: false, reason: "no_recipient" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { sent: false, reason: "invalid_recipient" };
  }

  // Invoice-owned snapshot (Issue #349 Phase 2): the emailed PDF reproduces the
  // invoice as billed, independent of the live quote.
  const { data: lines, error: linesError } = await supabase
    .from("invoice_line_items")
    .select("description, qty, unit_price, vat_rate, line_total, sort_order")
    .eq("invoice_id", invoice.id)
    .order("sort_order", { ascending: true });
  if (linesError) {
    // Never email a PDF with totals but zero line items on a failed read.
    console.error("[send-invoice] line items load failed", linesError);
    return { sent: false, reason: "load_failed", detail: linesError.message };
  }

  const pdfInput: InvoicePdfInput = {
    number: invoice.number,
    status: invoice.status,
    amount: Number(invoice.amount ?? 0),
    vat_total: Number(invoice.vat_total ?? 0),
    total: Number(invoice.total ?? 0),
    due_date: invoice.due_date,
    paid_at: invoice.paid_at,
    notes: invoice.notes,
    customer_name:
      invoice.customer?.name ?? invoice.quote?.customer?.name ?? null,
    org_name: invoice.org?.name ?? "CrewFlow",
    org_phone: invoice.org?.phone ?? null,
    org_vat_number: invoice.org?.vat_number ?? null,
    org_logo_url: await resolveOrgLogoSrc(invoice.org),
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

  const kind = options.kind ?? "initial";
  const { html, text, subject } =
    kind === "reminder" && options.reminder_stage
      ? buildInvoiceReminder({
          org_name: pdfInput.org_name,
          customer_name: pdfInput.customer_name,
          invoice_number: invoice.number,
          total: pdfInput.total,
          due_date: invoice.due_date,
          stage: options.reminder_stage,
          custom_message: options.message ?? null,
        })
      : buildInvoiceEmail({
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

  // Only flip status on the INITIAL send — reminders leave status alone.
  if (kind === "initial") {
    const updates: { sent_at: string; status?: "sent" } = { sent_at: sentAt };
    if (invoice.status === "draft") updates.status = "sent";
    // Carry the active-org predicate onto the write too. The row was already
    // resolved in-org above, so this is belt-and-braces — but a write that
    // states its own scope cannot be broken by a later refactor of the read.
    const updQuery = supabase.from("invoices").update(updates).eq("id", invoice.id);
    const { error: updErr } = await (options.orgId
      ? updQuery.eq("org_id", options.orgId)
      : updQuery);
    if (updErr) {
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

  return {
    sent: true,
    emailId: result.id,
    to: recipient,
    sent_at: sentAt,
    new_status: invoice.status,
  };
}
