import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createAdminClient } from "@/lib/supabase/admin";
import { InvoicePdf, type InvoicePdfInput } from "@/lib/pdf/invoice-pdf";
import { loadCustomerByPortalToken } from "@/app/customer-portal/_helpers";
import { invoiceCustomerId } from "@/lib/invoices/customer";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";

export const runtime = "nodejs";

/**
 * Customer-portal-scoped invoice PDF.
 *
 *   GET /customer-portal/[token]/invoices/[id]/pdf
 *
 * Mirrors the internal /api/invoices/[id]/pdf route but gates on the
 * customer's portal token instead of a JWT. The token resolves to a
 * customer; we serve the PDF only when the invoice belongs to one of
 * that customer's own quotes (org_id + quote.customer_id match).
 *
 * Without this, the customer-facing portal text references "the
 * invoice PDF" with no way for the customer to actually fetch it.
 */

type Ctx = { params: Promise<{ token: string; id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { token, id } = await params;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { customer } = loaded;

  const admin = createAdminClient();
  const { data: invoice, error } = await admin
    .from("invoices")
    .select(
      `
        id, number, status, amount, vat_total, total, due_date, paid_at,
        notes, quote_id, org_id, customer_id,
        quote:quotes ( customer_id, customer:customers ( name ) ),
        org:organizations ( name, phone, vat_number, logo_path, logo_url, address, bank_details )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !invoice) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Org + customer ownership check. The invoice must belong to this customer's
  // org AND to this customer. Resolve the customer via the ONE authority
  // (Issue #349 Phase 1): the invoice's own customer_id, quote fallback — so a
  // quote-less invoice still authorises correctly instead of 404ing.
  if (invoice.org_id !== customer.org_id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (invoiceCustomerId(invoice) !== customer.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Invoice-owned snapshot (Issue #349 Phase 2): the customer's PDF shows the
  // invoice as billed, unaffected by any later quote edit or deletion.
  const { data: lines, error: linesError } = await admin
    .from("invoice_line_items")
    .select("description, qty, unit_price, vat_rate, line_total, sort_order")
    .eq("invoice_id", invoice.id)
    .order("sort_order", { ascending: true });
  if (linesError) {
    // A failed line-item read must not render a PDF with an empty body.
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const input: InvoicePdfInput = {
    number: invoice.number,
    status: invoice.status,
    amount: Number(invoice.amount ?? 0),
    vat_total: Number(invoice.vat_total ?? 0),
    total: Number(invoice.total ?? 0),
    due_date: invoice.due_date,
    paid_at: invoice.paid_at,
    notes: invoice.notes,
    customer_name: invoice.quote?.customer?.name ?? null,
    org_name: invoice.org?.name ?? "",
    org_phone: invoice.org?.phone ?? null,
    org_vat_number: invoice.org?.vat_number ?? null,
    org_logo_url: await resolveOrgLogoSrc(invoice.org, admin),
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

  const buffer = await renderToBuffer(InvoicePdf({ inv: input }));
  const ab = new ArrayBuffer(buffer.length);
  new Uint8Array(ab).set(buffer);
  return new NextResponse(ab, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${invoice.number}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
