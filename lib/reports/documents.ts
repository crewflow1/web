import { csvEscape } from "@/lib/csv";
import type { ReportKey } from "./registry";
import { REPORTS } from "./registry";
import type {
  JobsPerWeek,
  RevenuePerMonth,
  VatPerQuarter,
  TopCustomer,
} from "./aggregates";
import type { JobProfitability, MonthBucket } from "@/lib/profitability/compute";
import type { CashTimeline } from "@/lib/intelligence/cash-timeline";
import type { OrgUtilisation } from "@/lib/intelligence/utilisation";
import { LEAD_STAGES_OPEN, type LeadStage } from "@/lib/leads/schema";

/**
 * REPORT DOCUMENTS — the ONE intermediate representation every report renders
 * through, so the PDF, the CSV and (where it composes them) the page can never
 * drift from one another.
 *
 * A `ReportDocument` is a title + a list of `ReportSection`s; each section is a
 * table with typed columns and cells. Every cell carries BOTH a machine value
 * (`csv`) and a display string (`text`): the CSV serialiser emits `csv`
 * (money as bare 2-dp numbers, exactly like the finances/invoices exports so a
 * spreadsheet keeps them numeric), while the PDF and page render `text`
 * (currency-formatted, human-readable). One mapper produces both, so a figure
 * is computed once and shown consistently everywhere.
 *
 * PURE — no `server-only`, no SDK, no Node builtins (only the pure `csvEscape`
 * and pure type imports), so the hermetic test tier can build every document
 * from fixture compute output and assert the exact rows without a database.
 *
 * The mappers COMPOSE the existing compute authorities' OUTPUT — they never
 * re-derive a figure. `profitToDocument` takes `computeAllJobsProfitability` +
 * `profitByMonth` output; `cashflowToDocument` takes a `computeCashTimeline`
 * result; `utilisationToDocument` takes `computeUtilisation` output;
 * `pipelineToDocument` takes `bucketPipelineLeads` output; `overviewToDocument`
 * takes the four `lib/reports/aggregates` results.
 */

export type CellAlign = "left" | "right";

export type ReportCell = {
  /** Machine value for CSV (money as a 2-dp string; counts as numbers). */
  csv: string | number;
  /** Human display string for PDF / page. */
  text: string;
  align?: CellAlign;
};

export type ReportColumn = { label: string; align?: CellAlign };

export type ReportSection = {
  title: string;
  /** Optional one-line caption under the section title. */
  note?: string;
  columns: ReportColumn[];
  rows: ReportCell[][];
  /** Rendered as an empty-state line when there are no rows. */
  empty?: string;
};

export type ReportDocument = {
  key: ReportKey;
  title: string;
  subtitle: string;
  /** ISO instant the document was composed — stamped into PDF/CSV. */
  generatedAt: string;
  sections: ReportSection[];
};

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** A plain text cell. */
export function txt(value: string): ReportCell {
  return { csv: value, text: value, align: "left" };
}

/** A whole-number cell (counts). */
export function count(n: number): ReportCell {
  const v = Math.round(n);
  return { csv: v, text: String(v), align: "right" };
}

/**
 * A money cell. CSV keeps a bare 2-dp number string (spreadsheet-numeric,
 * matching the finances/invoices exports); the display is currency-formatted.
 */
export function money(n: number): ReportCell {
  const r = round2(n);
  return { csv: r.toFixed(2), text: GBP.format(r), align: "right" };
}

/** A percentage cell (null → em dash, never a fabricated 0 %). */
export function percent(n: number | null): ReportCell {
  if (n === null || !Number.isFinite(n)) return { csv: "", text: "—", align: "right" };
  return { csv: n, text: `${n}%`, align: "right" };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// CSV serialiser — one download, one section per report section.
// ---------------------------------------------------------------------------

/**
 * Serialise a document to CSV: a title line, then per-section a blank line,
 * the section title, the header row, and the data rows. Mirrors the shape of
 * the original /api/reports/export exactly (so the overview CSV is unchanged)
 * and routes every field through the shared `csvEscape` (RFC-4180 quoting +
 * formula-injection neutralisation).
 */
export function documentToCsv(doc: ReportDocument): string {
  const lines: string[] = [];
  lines.push(csvEscape(doc.title));
  lines.push(csvEscape(`Generated ${doc.generatedAt}`));

  for (const section of doc.sections) {
    lines.push(""); // one blank line between sections
    lines.push(csvEscape(section.title));
    if (section.note) lines.push(csvEscape(section.note));
    if (section.rows.length === 0) {
      lines.push(csvEscape(section.empty ?? "No data"));
      continue;
    }
    lines.push(section.columns.map((c) => csvEscape(c.label)).join(","));
    for (const row of section.rows) {
      lines.push(row.map((cell) => csvEscape(cell.csv)).join(","));
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mappers — compute-output → ReportDocument. PURE.
// ---------------------------------------------------------------------------

export type DocumentMeta = { generatedAt: string };

/** Overview: the four /reports aggregates (back-compat CSV shape preserved). */
export function overviewToDocument(input: {
  jobs: JobsPerWeek[];
  revenue: RevenuePerMonth[];
  vat: VatPerQuarter[];
  top: TopCustomer[];
  meta: DocumentMeta;
}): ReportDocument {
  const { jobs, revenue, vat, top, meta } = input;
  return {
    key: "overview",
    title: REPORTS.overview.title,
    subtitle: REPORTS.overview.description,
    generatedAt: meta.generatedAt,
    sections: [
      {
        title: "Jobs per week (last 8 weeks)",
        columns: [
          { label: "Week starting" },
          { label: "Total", align: "right" },
          { label: "Completed", align: "right" },
        ],
        rows: jobs.map((r) => [txt(r.week_start), count(r.total), count(r.completed)]),
        empty: "No jobs scheduled",
      },
      {
        title: "Revenue per month (last 12 months, paid invoices)",
        columns: [{ label: "Month" }, { label: "Revenue", align: "right" }],
        rows: revenue.map((r) => [txt(r.month), money(r.revenue)]),
        empty: "No paid invoices",
      },
      {
        title: "VAT per quarter (last 4 quarters, output − input)",
        columns: [
          { label: "Quarter" },
          { label: "Output VAT", align: "right" },
          { label: "Input VAT", align: "right" },
          { label: "Net VAT", align: "right" },
        ],
        rows: vat.map((r) => [
          txt(r.quarter),
          money(r.output_vat),
          money(r.input_vat),
          money(r.net_vat),
        ]),
        empty: "No VAT activity",
      },
      {
        title: "Top customers by revenue (all-time, top 10)",
        columns: [
          { label: "Rank", align: "right" },
          { label: "Customer" },
          { label: "Revenue", align: "right" },
          { label: "Invoices", align: "right" },
        ],
        rows: top.map((c, i) => [count(i + 1), txt(c.name), money(c.revenue), count(c.invoice_count)]),
        empty: "No paid invoices yet",
      },
    ],
  };
}

/** Profit & loss: monthly P&L + per-job profitability with margin bands. */
export function profitToDocument(input: {
  months: MonthBucket[];
  jobs: Array<JobProfitability & { label: string }>;
  meta: DocumentMeta;
}): ReportDocument {
  const { months, jobs, meta } = input;

  const totalRevenue = jobs.reduce((s, j) => s + j.revenue, 0);
  const totalCosts = jobs.reduce((s, j) => s + j.costs_total, 0);
  const totalProfit = totalRevenue - totalCosts;

  // Largest money-makers first, then worst margins surface at the bottom — a
  // total order so the report never reshuffles between renders.
  const ordered = [...jobs].sort(
    (a, b) => b.gross_profit - a.gross_profit || a.job_id.localeCompare(b.job_id),
  );

  return {
    key: "profit",
    title: REPORTS.profit.title,
    subtitle: REPORTS.profit.description,
    generatedAt: meta.generatedAt,
    sections: [
      {
        title: "Profit & loss by month (last 12 months)",
        note: "Revenue and cost are ex-VAT; profit = revenue − cost.",
        columns: [
          { label: "Month" },
          { label: "Revenue", align: "right" },
          { label: "Costs", align: "right" },
          { label: "Gross profit", align: "right" },
        ],
        rows: months.map((m) => [txt(m.month), money(m.revenue), money(m.costs), money(m.profit)]),
        empty: "No revenue or cost recorded",
      },
      {
        title: "Job profitability",
        note: "One row per job with revenue or cost. Margin band: green > target, amber ≥ half target, red below.",
        columns: [
          { label: "Job" },
          { label: "Revenue", align: "right" },
          { label: "Costs", align: "right" },
          { label: "Gross profit", align: "right" },
          { label: "Margin", align: "right" },
          { label: "Band" },
        ],
        rows: ordered.map((j) => [
          txt(j.label),
          money(j.revenue),
          money(j.costs_total),
          money(j.gross_profit),
          percent(j.margin_pct),
          txt(j.band),
        ]),
        empty: "No jobs with revenue or cost yet",
      },
      {
        title: "Totals",
        columns: [
          { label: "Metric" },
          { label: "Value", align: "right" },
        ],
        rows: [
          [txt("Total revenue (ex-VAT)"), money(totalRevenue)],
          [txt("Total costs (ex-VAT)"), money(totalCosts)],
          [txt("Total gross profit"), money(totalProfit)],
          [txt("Jobs assessed"), count(jobs.length)],
        ],
      },
    ],
  };
}

/** Cashflow: the week-by-week cash timeline projection. */
export function cashflowToDocument(input: {
  timeline: CashTimeline;
  meta: DocumentMeta;
}): ReportDocument {
  const { timeline: t, meta } = input;

  const weekRows = t.sufficient
    ? t.weeks.map((w) => [
        txt(`${w.startDay} – ${w.endDay}`),
        money(w.inflow),
        money(w.outflow),
        money(w.net),
        money(w.cumulativeNet),
      ])
    : [];

  return {
    key: "cashflow",
    title: REPORTS.cashflow.title,
    subtitle: REPORTS.cashflow.description,
    generatedAt: meta.generatedAt,
    sections: [
      {
        title: `Weekly cash movement (next ${t.horizonWeeks} weeks from ${t.todayKey})`,
        note: "Projected CHANGE in cash from today (baseline £0), not a bank balance. Overdue money folds into week 1.",
        columns: [
          { label: "Week" },
          { label: "Money in", align: "right" },
          { label: "Money out", align: "right" },
          { label: "Net", align: "right" },
          { label: "Cumulative", align: "right" },
        ],
        rows: weekRows,
        empty: "Not enough dated cash events to project a timeline",
      },
      {
        title: "Summary",
        columns: [{ label: "Metric" }, { label: "Value", align: "right" }],
        rows: [
          [txt("Total money in (horizon)"), money(t.totalInflow)],
          [txt("Total money out (horizon)"), money(t.totalOutflow)],
          [txt("Net movement (horizon)"), money(t.netMovement)],
          [txt("Tightest point (lowest cumulative)"), money(t.lowestCumulative)],
          [txt("Shortfall within horizon?"), txt(t.shortfall ? "Yes" : "No")],
          [txt("Undated money in"), money(t.undated.inflow)],
          [txt("Undated money out"), money(t.undated.outflow)],
          [txt("Beyond horizon — money in"), money(t.beyondHorizon.inflow)],
          [txt("Beyond horizon — money out"), money(t.beyondHorizon.outflow)],
        ],
      },
    ],
  };
}

/** Staff utilisation: rostered vs recorded hours per member + org totals. */
export function utilisationToDocument(input: {
  utilisation: OrgUtilisation;
  meta: DocumentMeta;
}): ReportDocument {
  const { utilisation: u, meta } = input;

  const hours = (n: number): ReportCell => ({ csv: n.toFixed(2), text: `${n.toFixed(2)} h`, align: "right" });
  const labourCost = (n: number | null): ReportCell =>
    n === null ? { csv: "", text: "—", align: "right" } : money(n);

  return {
    key: "utilisation",
    title: REPORTS.utilisation.title,
    subtitle: REPORTS.utilisation.description,
    generatedAt: meta.generatedAt,
    sections: [
      {
        title: `Utilisation by member (${u.window.fromDay} – ${u.window.toDay})`,
        note: "Coverage = recorded ÷ rostered, shown only above the sample floor. Labour cost covers members with an hourly rate on file.",
        columns: [
          { label: "Member" },
          { label: "Rostered", align: "right" },
          { label: "Recorded", align: "right" },
          { label: "Coverage", align: "right" },
          { label: "Jobs rostered", align: "right" },
          { label: "Jobs worked", align: "right" },
          { label: "Labour cost", align: "right" },
        ],
        rows: u.members.map((m) => [
          txt(m.name ?? "—"),
          hours(m.rosteredHours),
          hours(m.recordedHours),
          percent(m.coverage.pct),
          count(m.jobsRostered),
          count(m.jobsWorked),
          labourCost(m.labourCost),
        ]),
        empty: "No rostered or recorded hours in the window",
      },
      {
        title: "Org totals",
        columns: [{ label: "Metric" }, { label: "Value", align: "right" }],
        rows: [
          [txt("Rostered hours"), hours(u.totals.rosteredHours)],
          [txt("Recorded hours"), hours(u.totals.recordedHours)],
          [txt("Coverage"), percent(u.totals.coverage.pct)],
          [txt("Members with roster"), count(u.totals.membersWithRoster)],
          [txt("Members with recorded time"), count(u.totals.membersWithTime)],
          [txt("Labour cost (rated members)"), money(u.totals.labourCost)],
          [txt("Members without a rate"), count(u.totals.membersWithoutRate)],
        ],
      },
    ],
  };
}

// Open (non-terminal) stages — reuses the leads schema's own authority so the
// report's "open pipeline value" matches the kanban's open columns exactly.
const OPEN_STAGES: readonly string[] = LEAD_STAGES_OPEN;

export type PipelineStageRow = { stage: LeadStage; label: string; count: number; value: number };

/** Sales pipeline: value + count per stage, with open-pipeline total. */
export function pipelineToDocument(input: {
  stages: PipelineStageRow[];
  totalValue: number;
  meta: DocumentMeta;
}): ReportDocument {
  const { stages, totalValue, meta } = input;
  const openValue = stages
    .filter((s) => OPEN_STAGES.includes(s.stage))
    .reduce((sum, s) => sum + s.value, 0);
  const wonValue = stages.filter((s) => s.stage === "won").reduce((sum, s) => sum + s.value, 0);

  return {
    key: "pipeline",
    title: REPORTS.pipeline.title,
    subtitle: REPORTS.pipeline.description,
    generatedAt: meta.generatedAt,
    sections: [
      {
        title: "Pipeline by stage",
        note: "Value is the sum of each lead's estimated value. Archived / unknown-stage leads are excluded.",
        columns: [
          { label: "Stage" },
          { label: "Leads", align: "right" },
          { label: "Estimated value", align: "right" },
        ],
        rows: stages.map((s) => [txt(s.label), count(s.count), money(s.value)]),
        empty: "No leads in the pipeline",
      },
      {
        title: "Summary",
        columns: [{ label: "Metric" }, { label: "Value", align: "right" }],
        rows: [
          [txt("Open pipeline value (new → quoted)"), money(openValue)],
          [txt("Won value"), money(wonValue)],
          [txt("Total across all stages"), money(totalValue)],
        ],
      },
    ],
  };
}
