import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { InvoicePdf, type InvoicePdfInput } from "@/lib/pdf/invoice-pdf";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";

// PDF rendering is Node.js only — opt out of edge runtime.
export const runtime = "nodejs";

/**
 * Internal invoice PDF.
 *
 *   GET /api/invoices/[id]/pdf
 *
 * RLS-scoped via the user JWT. Mirrors /api/quotes/[id]/pdf — same shape,
 * different template + columns.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const supabase = await createClient();

  // Pin the invoice to the ACTIVE org. "RLS-scoped via the user JWT" (the note
  // above) is not scoping: `current_org_ids()` returns EVERY org the viewer
  // belongs to, so for a dual-org user this by-id read would happily render
  // another org's invoice — its letterhead, its VAT number and its BANK
  // DETAILS — inside the active org's session. A foreign id must 404 exactly
  // as a missing one does.
  const { data: invoice, error: iErr } = await supabase
    .from("invoices")
    .select(
      `
        id, number, status, amount, vat_total, total, due_date, paid_at,
        notes, quote_id,
        quote:quotes ( customer:customers ( name ) ),
        org:organizations ( name, phone, vat_number, logo_path, logo_url, address, bank_details )
      `,
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  if (iErr) {
    console.error("[invoice-pdf] load failed", iErr);
    return NextResponse.json({ error: "Failed to load invoice" }, { status: 500 });
  }
  if (!invoice) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Invoice-owned snapshot (Issue #349 Phase 2), not the live quote — the PDF
  // reproduces the invoice as billed, immune to later quote edits/deletion.
  const { data: lines } = await supabase
    .from("invoice_line_items")
    .select("description, qty, unit_price, vat_rate, line_total, sort_order")
    .eq("invoice_id", id)
    .order("sort_order", { ascending: true });

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
    org_logo_url: await resolveOrgLogoSrc(invoice.org),
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
