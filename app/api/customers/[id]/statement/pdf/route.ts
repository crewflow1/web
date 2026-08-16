import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadCustomerStatement } from "@/server/services/customer-statement";
import { StatementPdf } from "@/lib/pdf/statement-pdf";

// react-pdf renders on Node, not edge.
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/customers/[id]/statement/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * The branded, client-ready statement of account. Active-org pinned inside
 * loadCustomerStatement (RLS admits every org the viewer belongs to, so a by-id
 * read must pin the active org); a foreign / missing customer 404s. Range bounds
 * are optional — an invalid bound is treated as absent, not an error.
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const supabase = await createClient();

  const from = request.nextUrl.searchParams.get("from");
  const to = request.nextUrl.searchParams.get("to");

  const view = await loadCustomerStatement(supabase, ctx.org.id, id, { from, to });
  if (!view) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const buffer = await renderToBuffer(StatementPdf({ s: view.pdfInput }));
  const ab = new ArrayBuffer(buffer.length);
  new Uint8Array(ab).set(buffer);

  return new NextResponse(ab, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${view.filename}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
