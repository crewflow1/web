import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createAdminClient } from "@/lib/supabase/admin";
import { QuotePdf, type QuotePdfInput } from "@/lib/pdf/quote-pdf";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";

export const runtime = "nodejs";

/**
 * Public quote PDF.
 *
 *   GET /q/[token]/pdf
 *
 * No auth — knowledge of the public_token is the gate. Service-role
 * admin client reads + serves the PDF.
 */

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: quote } = await admin
    .from("quotes")
    .select(
      `
        id, number, status, subtotal, vat_total, total, valid_until,
        notes, terms,
        customer:customers ( name ),
        org:organizations ( name, phone, vat_number, logo_path, logo_url, address, bank_details )
      `,
    )
    .eq("public_token", token)
    .maybeSingle();

  if (!quote) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: lines } = await admin
    .from("quote_line_items")
    .select("description, qty, unit_price, vat_rate, line_total, sort_order")
    .eq("quote_id", quote.id)
    .order("sort_order", { ascending: true });

  const input: QuotePdfInput = {
    number: quote.number,
    status: quote.status,
    subtotal: Number(quote.subtotal ?? 0),
    vat_total: Number(quote.vat_total ?? 0),
    total: Number(quote.total ?? 0),
    valid_until: quote.valid_until,
    notes: quote.notes,
    terms: quote.terms,
    customer_name: quote.customer?.name ?? null,
    org_name: quote.org?.name ?? "",
    org_phone: quote.org?.phone ?? null,
    org_vat_number: quote.org?.vat_number ?? null,
    org_logo_url: await resolveOrgLogoSrc(quote.org, admin),
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

  const buffer = await renderToBuffer(QuotePdf({ q: input }));
  const ab = new ArrayBuffer(buffer.length);
  new Uint8Array(ab).set(buffer);
  return new NextResponse(ab, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${quote.number}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
