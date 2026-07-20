import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { loadCustomerByPortalToken } from "@/app/customer-portal/_helpers";
import { loadPortalReport } from "@/app/customer-portal/_reports";
import { SiteReportPdf, type SiteReportPdfInput } from "@/lib/pdf/site-report-pdf";
import { safeReportFilename } from "@/lib/site-reports/portal";
import type {
  DiaryLite,
  SnagLite,
  ToolboxLite,
} from "@/lib/site-reports/aggregate";

// react-pdf renders on Node.
export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string; id: string }> };

/**
 * Customer-portal PDF download.
 *
 *   GET /customer-portal/[token]/reports/[id]/pdf
 *
 * Portal access is verified on EVERY request: the token resolves to a customer
 * (loadCustomerByPortalToken — the single token authority), and loadPortalReport
 * enforces customer_id + org_id + the visibility rule. A 404 is returned for any
 * report that isn't the customer's own, published, non-withdrawn issued report —
 * so id-guessing, a withdrawn report, or a draft all fail identically, revealing
 * nothing. The PDF is rendered from the FROZEN snapshot; no live source records.
 */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { token, id } = await params;

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const report = await loadPortalReport(loaded.customer.id, loaded.org.id, id);
  if (!report || !report.snapshot) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const snap = report.snapshot;
  const org = loaded.org;
  const input: SiteReportPdfInput = {
    title: snap.title,
    report_number: snap.report_number,
    revision: snap.revision,
    status: report.status,
    period_start: snap.period_start,
    period_end: snap.period_end,
    customer_name: snap.customer_name,
    job_label: snap.job_label,
    issued_at: snap.issued_at,
    content: snap.content,
    diary: (snap.sources?.diary ?? []) as unknown as DiaryLite[],
    snags: (snap.sources?.snags ?? []) as unknown as SnagLite[],
    toolbox: (snap.sources?.toolbox_talks ?? []) as unknown as ToolboxLite[],
    // Preparer/approver names aren't in the customer-safe snapshot; the client
    // report shows the issuing organisation, not internal staff identity.
    prepared_by_name: null,
    approved_by_name: null,
    approved_at: null,
    org_name: org.name,
    org_phone: org.phone,
    org_vat_number: null,
    org_logo_url: org.logo_url,
    org_address: org.address,
  };

  const buffer = await renderToBuffer(SiteReportPdf({ r: input }));

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${safeReportFilename(report.report_number, report.title)}"`,
      // A frozen, issued document — safe to cache privately, never shared/public.
      "Cache-Control": "private, max-age=300",
    },
  });
}
