import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "@/app/customer-portal/_helpers";
import { loadCustomerStatement } from "@/server/services/customer-statement";
import { StatementPdf } from "@/lib/pdf/statement-pdf";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

/**
 * GET /customer-portal/[token]/statement/pdf?from=&to=
 *
 * The customer's own statement of account. Gated by the portal token (the whole
 * auth surface) — `loadCustomerByPortalToken` resolves the customer + org and
 * fails closed for bad/expired tokens. The statement is then loaded through the
 * SAME org+customer-pinned service the internal route uses (admin client because
 * the portal has no JWT), so a customer only ever sees their own account.
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  const { token } = await params;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { customer } = loaded;

  const from = request.nextUrl.searchParams.get("from");
  const to = request.nextUrl.searchParams.get("to");

  const admin = createAdminClient();
  const view = await loadCustomerStatement(admin, customer.org_id, customer.id, {
    from,
    to,
  });
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
