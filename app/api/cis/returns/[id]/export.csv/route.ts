import { NextResponse, type NextRequest } from "next/server";
import { requireOrgContext } from "@/server/auth/session";
import { getReturnById, listReturnLines } from "@/server/services/cis-statements";
import {
  buildCisReturnCsv,
  type CisReturnForCsv,
  type CisReturnLineForCsv,
} from "@/lib/cis/export-csv";

/**
 * CIS300-shape monthly return CSV export.
 *
 *   GET /api/cis/returns/[id]/export.csv
 *
 * Serves the FROZEN, prepared monthly return and its subcontractor lines as an
 * RFC-4180 CSV the operator files themselves through HMRC's own service or their
 * filing software. Mirrors app/api/accounting/export — admin-gated, org-pinned,
 * non-silent truncation surfaced on the response.
 *
 * ── THIS DOES NOT FILE ANYTHING WITH HMRC ───────────────────────────────────
 * There is no HMRC endpoint, no Government Gateway credential and no `fetch`
 * here. This produces a file; that is precisely what the return's `exported`
 * status records — "the operator took the figures out of CrewFlow" — and it
 * asserts nothing about a filing having happened. Marking the return `exported`
 * stays the separate, explicit `exportCisReturn` action; a GET download does not
 * mutate the return.
 *
 * ── FROZEN, NOT LIVE ────────────────────────────────────────────────────────
 * It exports the return the operator PREPARED and froze, never a live
 * recomputation — a download must not silently disagree with the figures that
 * were reviewed. A SUPERSEDED return (re-prepared since) is refused: prepare/
 * export the current one.
 *
 * Admin-only via RLS (cis_monthly_returns is admin-only), doubled by the role
 * check for a clear message. The masked-UTR-only boundary lives in the builder.
 */

const isAdminRole = (role: string): boolean => role === "owner" || role === "admin";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json(
      { error: "Only an owner or admin may export a CIS return." },
      { status: 403 },
    );
  }

  const { id } = await params;
  const ret = await getReturnById(ctx.org.id, id);
  if (!ret) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (ret.superseded_at) {
    return NextResponse.json(
      { error: "This return has been re-prepared. Export the current prepared return." },
      { status: 409 },
    );
  }

  const lines = (await listReturnLines(ctx.org.id, id)) as unknown as CisReturnLineForCsv[];

  const header: CisReturnForCsv = {
    tax_month_start: ret.tax_month_start,
    tax_month_end: ret.tax_month_end,
    return_due_on: ret.return_due_on,
    contractor_name: ret.contractor_name,
    contractor_paye_reference: ret.contractor_paye_reference,
    accounts_office_reference: ret.accounts_office_reference,
    is_nil: ret.is_nil,
    subcontractor_count: ret.subcontractor_count,
    payment_count: ret.payment_count,
    total_gross: ret.total_gross,
    total_materials: ret.total_materials,
    total_deduction: ret.total_deduction,
    status: ret.status,
  };

  const { csv, rowCount, truncated } = buildCisReturnCsv({ ret: header, lines });

  const headers: Record<string, string> = {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="crewflow-cis-return-${ret.tax_month_end}.csv"`,
    "Cache-Control": "private, no-store",
    "X-Cis-Export-Row-Count": String(rowCount),
  };
  // A truncated export is NEVER silent — surface it, as the accounting route does.
  if (truncated) headers["X-Cis-Export-Truncated"] = "true";

  return new NextResponse(csv, { status: 200, headers });
}
