import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listStaffForOrg } from "@/app/(app)/jobs/_form-helpers";
import { gatherReportSources } from "@/server/services/site-report-sources";
import { filterSelected } from "@/lib/site-reports/aggregate";
import { reportSourcesSchema, type ReportContent } from "@/lib/site-reports/schema";
import { SiteReportPdf, type SiteReportPdfInput } from "@/lib/pdf/site-report-pdf";
import type {
  DiaryLite,
  SnagLite,
  ToolboxLite,
} from "@/lib/site-reports/aggregate";

// react-pdf renders on Node, not edge.
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

type ReportRow = {
  id: string;
  report_number: string | null;
  title: string;
  revision: number;
  status: string;
  period_start: string;
  period_end: string;
  customer_id: string | null;
  job_id: string | null;
  content: ReportContent | null;
  snapshot: {
    customer_name?: string | null;
    job_label?: string | null;
    content?: ReportContent;
    sources?: {
      diary?: unknown[];
      snags?: unknown[];
      toolbox_talks?: unknown[];
    };
  } | null;
  prepared_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  issued_at: string | null;
};

/**
 * GET /api/site-reports/[id]/pdf — the branded, client-ready PDF.
 *
 * RLS-scoped via the user JWT (requireOrgContext). An issued report renders from
 * its FROZEN snapshot; a draft renders a live preview from current content +
 * freshly-gathered sources.
 */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const supabase = await createClient();

  const { data: report } = await (
    supabase.from("site_reports" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{ data: ReportRow | null }>;
        };
      };
    }
  )
    .select(
      "id, report_number, title, revision, status, period_start, period_end, customer_id, job_id, content, snapshot, prepared_by, approved_by, approved_at, issued_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (!report) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Pin the letterhead to the ACTIVE org. Without the predicate this read is
  // unfiltered, so for a multi-org user PostgREST returns whichever org row
  // comes back first — the PDF could carry the wrong company's identity.
  const { data: org } = await supabase
    .from("organizations")
    .select("name, phone, vat_number, logo_url, address")
    .eq("id", ctx.org.id)
    .maybeSingle();

  const staff = await listStaffForOrg(ctx.org.id);
  const nameFor = (uid: string | null) =>
    uid ? (staff.find((s) => s.id === uid)?.full_name || staff.find((s) => s.id === uid)?.email || null) : null;

  // Resolve customer + job labels (snapshot wins when issued).
  let customerName = report.snapshot?.customer_name ?? null;
  let jobLabel = report.snapshot?.job_label ?? null;
  if (!customerName && report.customer_id) {
    const { data: cust } = await supabase
      .from("customers")
      .select("name")
      .eq("id", report.customer_id)
      .maybeSingle();
    customerName = cust?.name ?? null;
    jobLabel = jobLabel ?? customerName;
  }

  // Sources: frozen snapshot when issued, else live + author's selection.
  let diary: DiaryLite[];
  let snags: SnagLite[];
  let toolbox: ToolboxLite[];
  const content: ReportContent = report.snapshot?.content ?? report.content ?? {};

  if (report.snapshot?.sources) {
    diary = (report.snapshot.sources.diary ?? []) as unknown as DiaryLite[];
    snags = (report.snapshot.sources.snags ?? []) as unknown as SnagLite[];
    toolbox = (report.snapshot.sources.toolbox_talks ?? []) as unknown as ToolboxLite[];
  } else if (report.job_id) {
    const raw = await gatherReportSources(
      report.job_id,
      report.period_start,
      report.period_end,
    );
    const selection = reportSourcesSchema.parse((report.content?.sources as unknown) ?? {});
    const chosen = filterSelected(raw, selection);
    diary = chosen.diary;
    snags = chosen.snags;
    toolbox = chosen.toolbox;
  } else {
    diary = [];
    snags = [];
    toolbox = [];
  }

  const input: SiteReportPdfInput = {
    title: report.title,
    report_number: report.report_number,
    revision: report.revision,
    status: report.status,
    period_start: report.period_start,
    period_end: report.period_end,
    customer_name: customerName,
    job_label: jobLabel,
    issued_at: report.issued_at,
    content,
    diary,
    snags,
    toolbox,
    prepared_by_name: nameFor(report.prepared_by),
    approved_by_name: nameFor(report.approved_by),
    approved_at: report.approved_at,
    org_name: org?.name ?? "CrewFlow",
    org_phone: org?.phone ?? null,
    org_vat_number: (org as { vat_number?: string | null } | null)?.vat_number ?? null,
    org_logo_url: (org as { logo_url?: string | null } | null)?.logo_url ?? null,
    org_address:
      (org as { address?: SiteReportPdfInput["org_address"] } | null)?.address ?? null,
  };

  const buffer = await renderToBuffer(SiteReportPdf({ r: input }));
  const filename = `${report.report_number ?? "site-report"}.pdf`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
