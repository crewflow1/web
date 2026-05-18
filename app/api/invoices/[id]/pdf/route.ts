import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { InvoicePdf, type InvoicePdfInput } from "@/lib/pdf/invoice-pdf";

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
  await requireOrgContext();
  const { id } = await params;
  const supabase = await createClient();

  const { data: invoice, error: iErr } = await supabase
    .from("invoices")
    .select(
      `
        id, number, status, amount, vat_total, total, due_date, paid_at,
        notes, quote_id,
        quote:quotes ( customer:customers ( name ) ),
        org:organizations ( name, phone, vat_number, logo_url, address, bank_details )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (iErr) {
    console.error("[invoice-pdf] load failed", iErr);
    return NextResponse.json({ error: "Failed to load invoice" }, { status: 500 });
  }
  if (!invoice) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: lines } = invoice.quote_id
    ? await supabase
        .from("quote_line_items")
        .select("description, qty, unit_price, vat_rate, line_total, sort_order")
        .eq("quote_id", invoice.quote_id)
        .order("sort_order", { ascending: true })
    : { data: [] };

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
