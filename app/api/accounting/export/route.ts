import { NextResponse, type NextRequest } from "next/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  buildAccountingExport,
  recordAccountingExport,
  MAX_ROWS,
} from "@/server/services/accounting-export";
import { toAccountingCsv } from "@/lib/integrations/accounting/csv";

/**
 * Accounting CSV export — the credential-free path.
 *
 *   GET /api/accounting/export?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Produces the canonical accounting rows (invoices + payments) for the caller's
 * ACTIVE org, serialised RFC-4180. Admin-only: generating a bookkeeping export
 * is an admin act (doubled — the DB RLS on accounting_export_log is the real
 * boundary for the audit-log write). Records one `generated` row in the export
 * log. Org-pinned + loud reads live in the service.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export async function GET(request: NextRequest) {
  const { ctx, user } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json(
      { error: "Only an owner or admin may export accounting data." },
      { status: 403 },
    );
  }

  const url = request.nextUrl;
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const periodStart = from && DAY.test(from) ? from : null;
  const periodEnd = to && DAY.test(to) ? to : null;

  const { rows, truncated } = await buildAccountingExport({
    orgId: ctx.org.id,
    from: periodStart,
    to: periodEnd,
  });

  const csv = toAccountingCsv(rows);

  // A truncated export is NEVER silent: note it in the audit trail and signal it
  // on the response so the caller knows rows were omitted at the cap.
  const note = truncated
    ? `truncated at MAX_ROWS=${MAX_ROWS} per read — export is partial; narrow the date window`
    : null;

  // Audit the export. Best-effort — never fail the download over the log write.
  await recordAccountingExport({
    orgId: ctx.org.id,
    createdBy: user.id,
    format: "csv",
    status: "generated",
    rowCount: rows.length,
    periodStart,
    periodEnd,
    note,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const headers: Record<string, string> = {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="crewflow-accounting-${stamp}.csv"`,
    // Surface the exported row count and any truncation on the response itself.
    "X-Accounting-Export-Row-Count": String(rows.length),
  };
  if (truncated) {
    headers["X-Accounting-Export-Truncated"] = "true";
  }
  return new NextResponse(csv, { status: 200, headers });
}
