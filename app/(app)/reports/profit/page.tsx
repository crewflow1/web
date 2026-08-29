import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildReportDocument } from "@/lib/reports/report-data";
import type { ReportDocument } from "@/lib/reports/documents";
import { BarChart, type ChartSeries, type ChartDatum } from "@/components/ui/charts";
import type { Tone } from "@/components/ui/tokens";
import { ReportView } from "../_report-view";

/**
 * /reports/profit — Profit & loss. Composes the job-profitability authority
 * (lib/profitability/compute) into monthly P&L + per-job margins.
 *
 * Management-only (registry `profit.managementOnly`): the P&L is labour-cost-
 * derived, and since staff_compensation (20261218) put pay behind self-or-admin
 * RLS a non-admin would read only their own rate → an overstated, WRONG profit.
 * Gate the page like the export route already gates the download (403), so the
 * nav-level admin-only Reports area is enforced on the direct URL too.
 *
 * The margin chart plots the SAME document the table/PDF/CSV render: each
 * ReportCell carries a machine value (`csv`) beside its display string, so the
 * series below is read straight out of buildReportDocument's output — no
 * second fetch, no re-derived figure, the page can never disagree with its
 * own export.
 */

// Column order of the "Job profitability" section, pinned by profitToDocument
// (lib/reports/documents.ts): Job · Revenue · Costs · Gross profit · Margin · Band.
const JOB_SECTION = 1;
const JOB_COL = 0;
const MARGIN_COL = 4;
const BAND_COL = 5;

/** Margin band → tone (marginBand emits green/amber/red; green maps to the emerald tone). */
const BAND_TONE: Record<string, Tone> = {
  green: "emerald",
  amber: "amber",
  red: "red",
};

function marginSeries(doc: ReportDocument): ChartSeries[] {
  const section = doc.sections[JOB_SECTION];
  if (!section || section.rows.length === 0) return [];
  const data: ChartDatum[] = [];
  // Rows arrive ordered by gross profit (largest money-makers first) — the
  // document's own total order. Chart the top 10 with a computable margin.
  for (const row of section.rows) {
    if (data.length >= 10) break;
    const margin = row[MARGIN_COL]?.csv;
    if (margin === "" || margin == null || !Number.isFinite(Number(margin))) continue;
    data.push({
      label: row[JOB_COL]?.text ?? "—",
      value: Number(margin),
      text: row[MARGIN_COL]?.text ?? `${margin}%`,
      tone: BAND_TONE[String(row[BAND_COL]?.csv ?? "")] ?? "slate",
    });
  }
  if (data.length === 0) return [];
  return [{ name: "Margin", tone: "emerald", data }];
}

export default async function ProfitReportPage() {
  const { ctx } = await requireOrgContext();
  const role = ctx.membership.role;
  if (role !== "owner" && role !== "admin") redirect("/reports");
  const supabase = await createClient();
  const doc = await buildReportDocument(supabase, ctx.org.id, "profit");
  const series = marginSeries(doc);
  return (
    <div className="space-y-6">
      {/* Per-job margin chart — top 10 jobs by gross profit, coloured by the
          report's own margin band. Rendered only when at least one job has a
          computable margin; otherwise the table's empty line is the answer. */}
      {series.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">
            Margin by job (top 10 by gross profit)
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Bar colour follows the margin band: green above target, amber at
            least half of target, red below — the same figures as the table
            below.
          </p>
          <BarChart
            title="Gross margin per job, top 10 jobs by gross profit"
            desc="Horizontal bars of gross margin percentage for the ten jobs with the highest gross profit; negative margins extend left of the zero line."
            series={series}
            categoryHeader="Job"
            orientation="horizontal"
            formatValue={(n) => `${n}%`}
            showValues
          />
        </section>
      ) : null}
      <ReportView doc={doc} />
    </div>
  );
}
