import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import { InvoicePdf, type InvoicePdfInput } from "@/lib/pdf/invoice-pdf";
import { invoiceCustomerName } from "@/lib/invoices/customer";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";

/**
 * Shared helper for cron + on-demand send paths: builds the invoice PDF
 * input from the joined invoice row + line items, renders to a buffer.
 */

type JoinedInvoice = {
  number: string;
  status: string;
  amount: number | string | null;
  vat_total: number | string | null;
  total: number | string | null;
  due_date: string | null;
  paid_at: string | null;
  notes: string | null;
  // Direct customer anchor (Issue #349 Phase 1) — preferred over the quote path,
  // which is NULL for every stage-billing invoice. A caller wiring this helper up
  // must join `customer:customers!invoices_customer_org_fkey ( name )`.
  customer?: { name: string | null } | null;
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

type LineItem = {
  description: string;
  qty: number | string | null;
  unit_price: number | string | null;
  vat_rate: number | string | null;
  line_total: number | string | null;
};

export async function renderInvoicePdf(
  invoice: JoinedInvoice,
  lines: LineItem[],
): Promise<Buffer> {
  const input: InvoicePdfInput = {
    number: invoice.number,
    status: invoice.status,
    amount: Number(invoice.amount ?? 0),
    vat_total: Number(invoice.vat_total ?? 0),
    total: Number(invoice.total ?? 0),
    due_date: invoice.due_date,
    paid_at: invoice.paid_at,
    notes: invoice.notes,
    customer_name: invoiceCustomerName(invoice),
    org_name: invoice.org?.name ?? "CrewFlow",
    org_phone: invoice.org?.phone ?? null,
    org_vat_number: invoice.org?.vat_number ?? null,
    org_logo_url: await resolveOrgLogoSrc(invoice.org),
    org_address:
      (invoice.org?.address as InvoicePdfInput["org_address"]) ?? null,
    org_bank_details:
      (invoice.org?.bank_details as InvoicePdfInput["org_bank_details"]) ?? null,
    line_items: lines.map((li) => ({
      description: li.description,
      qty: Number(li.qty ?? 0),
      unit_price: Number(li.unit_price ?? 0),
      vat_rate: Number(li.vat_rate ?? 0),
      line_total: Number(li.line_total ?? 0),
    })),
  };
  return renderToBuffer(InvoicePdf({ inv: input }));
}
