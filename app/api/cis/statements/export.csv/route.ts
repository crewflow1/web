import { NextResponse, type NextRequest } from "next/server";
import { requireOrgContext } from "@/server/auth/session";
import { listStatements } from "@/server/services/cis-statements";
import { buildCisStatementsCsv, type CisStatementForCsv } from "@/lib/cis/export-csv";
import { cisTaxMonthEnd } from "@/lib/cis/tax-month";

/**
 * Per-subcontractor deduction statement CSV export for one tax month.
 *
 *   GET /api/cis/statements/export.csv?month=YYYY-MM-DD
 *
 * A working spreadsheet of the CURRENT (issued) payment & deduction statements
 * of one tax month. Superseded and withdrawn statements are dropped in the
 * builder — the spreadsheet lists the documents that stand.
 *
 * ── THIS DOES NOT FILE ANYTHING WITH HMRC ───────────────────────────────────
 * There is no HMRC endpoint, no gateway credential and no `fetch` here. It is a
 * file the operator downloads. The full UTR is intentionally NOT in this bulk
 * CSV (masked-UTR-only boundary — see lib/cis/export-csv.ts); the authoritative
 * per-subcontractor document carrying the full UTR is the admin-gated statement
 * PDF.
 *
 * Admin-only via RLS (cis_statements is admin-only), doubled by the role check.
 */

const isAdminRole = (role: string): boolean => role === "owner" || role === "admin";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json(
      { error: "Only an owner or admin may export CIS statements." },
      { status: 403 },
    );
  }

  const raw = request.nextUrl.searchParams.get("month");
  // Normalise any date in the month to the tax-month END, from the ONE
  // definition — never a hand-rolled boundary that could land in the wrong month.
  const month = raw && DAY.test(raw) ? cisTaxMonthEnd(raw) : null;
  if (!month) {
    return NextResponse.json(
      { error: "Provide ?month=YYYY-MM-DD within the CIS tax month to export." },
      { status: 400 },
    );
  }

  const statements = (await listStatements(ctx.org.id, {
    taxMonthEnd: month,
  })) as unknown as CisStatementForCsv[];

  const { csv, rowCount, truncated, excludedNonIssued } = buildCisStatementsCsv({ statements });

  const headers: Record<string, string> = {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="crewflow-cis-statements-${month}.csv"`,
    "Cache-Control": "private, no-store",
    "X-Cis-Export-Row-Count": String(rowCount),
    "X-Cis-Export-Excluded-Non-Issued": String(excludedNonIssued),
  };
  if (truncated) headers["X-Cis-Export-Truncated"] = "true";

  return new NextResponse(csv, { status: 200, headers });
}
