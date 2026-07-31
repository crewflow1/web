import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { QuotePdf, type QuotePdfInput } from "@/lib/pdf/quote-pdf";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";

// PDF rendering is Node.js only — opt out of edge runtime.
export const runtime = "nodejs";

/**
 * Internal (signed-in) quote PDF.
 *
 *   GET /api/quotes/[id]/pdf
 *
 * RLS-scoped via the user JWT. Owners get the same PDF that customers
 * see at /q/[token]/pdf, including the bank details block.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const supabase = await createClient();

  // Pin the quote to the ACTIVE org — see the equivalent note in
  // app/api/invoices/[id]/pdf/route.ts. This PDF includes the bank-details
  // block, so an unscoped by-id read hands another org's payment instructions
  // to whoever opens the URL from the wrong shell.
  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select(
      `
        id, number, status, subtotal, vat_total, total, valid_until,
        eot_requested_completion_date, eot_agreed_completion_date,
        notes, terms,
        customer:customers ( name ),
        org:organizations ( name, phone, vat_number, logo_path, logo_url, address, bank_details )
      `,
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  if (qErr) {
    console.error("[quote-pdf] load failed", qErr);
    return NextResponse.json({ error: "Failed to load quote" }, { status: 500 });
  }
  if (!quote) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: lines, error: lErr } = await supabase
    .from("quote_line_items")
    .select("description, qty, unit_price, vat_rate, line_total, sort_order")
    .eq("quote_id", quote.id)
    .order("sort_order", { ascending: true });
  if (lErr) {
    console.error("[quote-pdf] line items load failed", lErr);
    return NextResponse.json({ error: "Failed to load quote" }, { status: 500 });
  }

  const input: QuotePdfInput = {
    number: quote.number,
    status: quote.status,
    subtotal: Number(quote.subtotal ?? 0),
    vat_total: Number(quote.vat_total ?? 0),
    total: Number(quote.total ?? 0),
    valid_until: quote.valid_until,
    eot_requested_completion_date: quote.eot_requested_completion_date,
    eot_agreed_completion_date: quote.eot_agreed_completion_date,
    notes: quote.notes,
    terms: quote.terms,
    customer_name: quote.customer?.name ?? null,
    org_name: quote.org?.name ?? "",
    org_phone: quote.org?.phone ?? null,
    org_vat_number: quote.org?.vat_number ?? null,
    org_logo_url: await resolveOrgLogoSrc(quote.org),
    org_address:
      (quote.org?.address as QuotePdfInput["org_address"]) ?? null,
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

  // QuotePdf returns a <Document>; call it as a function to get the
  // typed Document element renderToBuffer expects.
  const buffer = await renderToBuffer(QuotePdf({ q: input }));
  const ab = new ArrayBuffer(buffer.length);
  new Uint8Array(ab).set(buffer);
  return new NextResponse(ab, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${quote.number}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
