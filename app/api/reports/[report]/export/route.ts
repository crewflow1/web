import { NextResponse, type NextRequest } from "next/server";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildReportDocument } from "@/lib/reports/report-data";
import { documentToCsv } from "@/lib/reports/documents";
import {
  loadReportOrg,
  renderReportPdf,
  reportFilenameStem,
} from "@/lib/reports/export-render";
import {
  isReportKey,
  isReportFormat,
  REPORTS,
  type ReportFormat,
} from "@/lib/reports/registry";

/**
 * Shared report export — PDF or CSV for ANY /reports report.
 *
 *   GET /api/reports/<report>/export?format=pdf|csv
 *
 * ONE route for every report and both formats. It composes nothing itself:
 * `buildReportDocument` reaches the report's figures through the existing
 * compute authority, and the SAME `ReportDocument` is serialised to CSV
 * (documentToCsv → shared csvEscape) or rendered to PDF (renderReportPdf →
 * the shared branded ReportPdf). So the download can never drift from what the
 * page shows, and a new report needs no new export code.
 *
 * Behind `requireOrgContext` and org-pinned, exactly like the page. A
 * management-only report (cashflow exposes VAT/CIS/payables) is refused for a
 * non-admin — the same gate the report page applies.
 *
 * react-pdf renders on Node, not edge.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ report: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const { report } = await params;
  if (!isReportKey(report)) {
    return NextResponse.json({ error: "unknown_report" }, { status: 404 });
  }
  const meta = REPORTS[report];

  const formatRaw = request.nextUrl.searchParams.get("format") ?? "pdf";
  const format: ReportFormat = isReportFormat(formatRaw) ? formatRaw : "pdf";

  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  if (meta.managementOnly && !isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const supabase = await createClient();
    const doc = await buildReportDocument(supabase, ctx.org.id, report);
    const stem = reportFilenameStem(report, doc.generatedAt);

    if (format === "csv") {
      const csv = documentToCsv(doc);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${stem}.csv"`,
        },
      });
    }

    const org = await loadReportOrg(supabase, ctx.org.id);
    const buffer = await renderReportPdf(doc, org);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${stem}.pdf"`,
      },
    });
  } catch (e) {
    console.error(`[reports] export failed for ${report}/${format}`, e);
    return NextResponse.json({ error: "export_failed" }, { status: 500 });
  }
}
