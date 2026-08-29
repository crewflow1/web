import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildReportDocument } from "@/lib/reports/report-data";
import type { ReportDocument } from "@/lib/reports/documents";
import { AreaChart, compactNumber, type ChartSeries } from "@/components/ui/charts";
import { ReportView } from "../_report-view";

/**
 * /reports/cashflow — Cashflow forecast. Composes the forecasting cash-timeline
 * authority (gatherCashTimeline → computeCashTimeline): a week-by-week projection
 * of cash MOVEMENT (not a bank balance) over the next quarter.
 *
 * MANAGEMENT-ONLY. The timeline's outflow side (VAT / CIS / supplier payables)
 * is admin-only at RLS, so a non-admin would see an understated forecast. This
 * page refuses to draw it for a non-admin rather than show half a ledger — the
 * same gate `server/services/forecasting.loadForecasts` applies.
 *
 * The chart plots the SAME document the table/PDF/CSV render: each ReportCell
 * carries a machine value (`csv`) beside its display string, so the cumulative
 * series below is read straight out of buildReportDocument's output — no
 * second fetch, no re-derived figure, the page can never disagree with its
 * own export.
 */

// Column order of the weekly section, pinned by cashflowToDocument
// (lib/reports/documents.ts): Week · Money in · Money out · Net · Cumulative.
const WEEK_COL = 0;
const CUMULATIVE_COL = 4;

const DAY_LABEL = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function cumulativeSeries(doc: ReportDocument): ChartSeries[] {
  const weekly = doc.sections[0];
  if (!weekly || weekly.rows.length === 0) return [];
  const data = weekly.rows.map((row) => {
    const weekText = row[WEEK_COL]?.text ?? "";
    // Week cells read "YYYY-MM-DD – YYYY-MM-DD"; label by the start day.
    const start = weekText.slice(0, 10);
    const parsed = new Date(`${start}T00:00:00Z`);
    return {
      label: Number.isNaN(parsed.getTime()) ? weekText : DAY_LABEL.format(parsed),
      value: Number(row[CUMULATIVE_COL]?.csv ?? 0),
      text: row[CUMULATIVE_COL]?.text ?? "",
    };
  });
  return [{ name: "Cumulative net movement", tone: "indigo", data }];
}

export default async function CashflowReportPage() {
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Cashflow forecast</h1>
        <div
          role="status"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          The cashflow forecast includes VAT, CIS and supplier payments, which
          are visible to owners and admins only. Ask an admin to share it with
          you.
        </div>
      </div>
    );
  }

  const supabase = await createClient();
  const doc = await buildReportDocument(supabase, ctx.org.id, "cashflow");
  const series = cumulativeSeries(doc);
  return (
    <div className="space-y-6">
      {/* Timeline chart — only when the projection has weeks; when the engine
          says "not enough dated cash events", the table's own empty line is
          the honest answer and no chart pretends otherwise. */}
      {series.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">
            Cumulative cash movement
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Projected change in cash from today (baseline £0), week by week —
            the same figures as the table below.
          </p>
          <AreaChart
            title="Cumulative cash movement over the forecast horizon"
            desc="Area chart of the projected cumulative net cash movement per week; values below zero show a projected shortfall against today's position."
            series={series}
            categoryHeader="Week starting"
            formatValue={(n) => `£${compactNumber(n)}`}
          />
        </section>
      ) : null}
      <ReportView doc={doc} />
    </div>
  );
}
