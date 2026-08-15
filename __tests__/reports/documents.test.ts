import { describe, it, expect } from "vitest";
import {
  overviewToDocument,
  profitToDocument,
  cashflowToDocument,
  utilisationToDocument,
  pipelineToDocument,
  documentToCsv,
  type PipelineStageRow,
} from "@/lib/reports/documents";
import { computeCashTimeline } from "@/lib/intelligence/cash-timeline";
import type { OrgUtilisation } from "@/lib/intelligence/utilisation";
import type { JobProfitability } from "@/lib/profitability/compute";

/**
 * REPORT DOCUMENT MAPPERS — pure aggregation, no I/O.
 *
 * Each mapper turns an EXISTING compute authority's output into the shared
 * ReportDocument. These tests pin that every figure lands in the right cell,
 * that money carries a machine value (CSV) AND a human display, that a null
 * margin/coverage shows an em dash (never a fabricated 0), and that the CSV
 * serialiser reproduces the sectioned shape through the shared csvEscape.
 */

const META = { generatedAt: "2026-08-15T10:00:00.000Z" };

describe("overviewToDocument", () => {
  it("emits the four aggregate sections with machine + display money", () => {
    const doc = overviewToDocument({
      jobs: [{ week_start: "2026-06-01", total: 4, completed: 3 }],
      revenue: [{ month: "2026-06-01", revenue: 12000 }],
      vat: [{ quarter: "2026-04-01", output_vat: 3000, input_vat: 1200, net_vat: 1800 }],
      top: [{ id: "c1", name: "Acme, Inc.", revenue: 54000, invoice_count: 12 }],
      meta: META,
    });
    expect(doc.key).toBe("overview");
    expect(doc.sections).toHaveLength(4);
    const revenueRow = doc.sections[1]!.rows[0]!;
    expect(revenueRow[1]!.csv).toBe("12000.00"); // machine
    expect(revenueRow[1]!.text).toContain("£"); // display
  });
});

describe("profitToDocument", () => {
  const jobs: Array<JobProfitability & { label: string }> = [
    {
      job_id: "j1",
      label: "Acme · London",
      revenue: 10000,
      costs_total: 6000,
      costs_by_bucket: { labour: 4000, materials: 2000, subcontractors: 0, misc: 0 },
      gross_profit: 4000,
      margin_pct: 40,
      band: "green",
    },
    {
      job_id: "j2",
      label: "Beta · Leeds",
      revenue: 0,
      costs_total: 500,
      costs_by_bucket: { labour: 0, materials: 500, subcontractors: 0, misc: 0 },
      gross_profit: -500,
      margin_pct: null, // no revenue → margin unknowable, must be em dash
      band: "neutral",
    },
  ];

  it("orders jobs by gross profit desc and shows a null margin as an em dash", () => {
    const doc = profitToDocument({
      months: [{ month: "2026-08", revenue: 10000, costs: 6500, profit: 3500 }],
      jobs,
      meta: META,
    });
    const jobSection = doc.sections.find((s) => s.title === "Job profitability")!;
    expect(jobSection.rows[0]![0]!.text).toBe("Acme · London"); // biggest profit first
    // j2's margin cell (index 4) is the em dash, and its CSV is empty (not 0).
    const j2 = jobSection.rows[1]!;
    expect(j2[4]!.text).toBe("—");
    expect(j2[4]!.csv).toBe("");
  });

  it("totals reconcile with the per-job figures", () => {
    const doc = profitToDocument({ months: [], jobs, meta: META });
    const totals = doc.sections.find((s) => s.title === "Totals")!;
    const byLabel = new Map(totals.rows.map((r) => [r[0]!.text, r[1]!.csv]));
    expect(byLabel.get("Total revenue (ex-VAT)")).toBe("10000.00");
    expect(byLabel.get("Total costs (ex-VAT)")).toBe("6500.00");
    expect(byLabel.get("Total gross profit")).toBe("3500.00");
  });
});

describe("cashflowToDocument", () => {
  it("renders the real cash-timeline authority's weeks + summary", () => {
    const timeline = computeCashTimeline({
      todayKey: "2026-08-15",
      horizonWeeks: 2,
      events: [
        { dateKey: "2026-08-16", direction: "in", amount: 1000, category: "Invoice due", certainty: "invoiced", label: "INV-1", href: null },
        { dateKey: "2026-08-20", direction: "out", amount: 400, category: "VAT", certainty: "estimated", label: "VAT", href: null },
      ],
    });
    const doc = cashflowToDocument({ timeline, meta: META });
    const weeks = doc.sections[0]!;
    expect(weeks.rows.length).toBe(2); // horizonWeeks
    const summary = doc.sections[1]!;
    const byLabel = new Map(summary.rows.map((r) => [r[0]!.text, r[1]!.csv]));
    expect(byLabel.get("Total money in (horizon)")).toBe("1000.00");
    expect(byLabel.get("Total money out (horizon)")).toBe("400.00");
    expect(byLabel.get("Net movement (horizon)")).toBe("600.00");
  });

  it("shows the insufficient-data empty state rather than a fake £0 line", () => {
    const timeline = computeCashTimeline({ todayKey: "2026-08-15", horizonWeeks: 4, events: [] });
    const doc = cashflowToDocument({ timeline, meta: META });
    expect(doc.sections[0]!.rows).toHaveLength(0);
    expect(doc.sections[0]!.empty).toMatch(/not enough dated cash events/i);
  });
});

describe("utilisationToDocument", () => {
  const util: OrgUtilisation = {
    window: { fromDay: "2026-07-17", toDay: "2026-08-15" },
    members: [
      {
        userId: "u1",
        name: "Sam",
        rosteredHours: 40,
        recordedHours: 38,
        coverage: { recorded: 38, rostered: 40, pct: 95, rated: true },
        jobsRostered: 3,
        jobsWorked: 2,
        labourCost: 760,
      },
      {
        userId: "u2",
        name: "Alex",
        rosteredHours: 2,
        recordedHours: 1,
        coverage: { recorded: 1, rostered: 2, pct: null, rated: false }, // below floor
        jobsRostered: 1,
        jobsWorked: 1,
        labourCost: null, // no rate on file
      },
    ],
    totals: {
      rosteredHours: 42,
      recordedHours: 39,
      coverage: { recorded: 39, rostered: 42, pct: 93, rated: true },
      membersWithRoster: 2,
      membersWithTime: 2,
      labourCost: 760,
      formerMemberRosteredHours: 0,
      formerMemberRecordedHours: 0,
      membersWithoutRate: 1,
    },
  };

  it("withholds coverage below the floor and labour cost with no rate (em dash, not 0)", () => {
    const doc = utilisationToDocument({ utilisation: util, meta: META });
    const rows = doc.sections[0]!.rows;
    const alex = rows.find((r) => r[0]!.text === "Alex")!;
    expect(alex[3]!.text).toBe("—"); // coverage pct null
    expect(alex[6]!.text).toBe("—"); // labour cost null
    const sam = rows.find((r) => r[0]!.text === "Sam")!;
    expect(sam[3]!.text).toBe("95%");
    expect(sam[6]!.csv).toBe("760.00");
  });
});

describe("pipelineToDocument", () => {
  const stages: PipelineStageRow[] = [
    { stage: "new", label: "New", count: 2, value: 3000 },
    { stage: "quoted", label: "Quoted", count: 1, value: 5000 },
    { stage: "won", label: "Won", count: 1, value: 9000 },
    { stage: "lost", label: "Lost", count: 1, value: 1000 },
  ];

  it("open pipeline value excludes terminal stages (won/lost)", () => {
    const doc = pipelineToDocument({ stages, totalValue: 18000, meta: META });
    const summary = doc.sections.find((s) => s.title === "Summary")!;
    const byLabel = new Map(summary.rows.map((r) => [r[0]!.text, r[1]!.csv]));
    // open = new + quoted = 3000 + 5000
    expect(byLabel.get("Open pipeline value (new → quoted)")).toBe("8000.00");
    expect(byLabel.get("Won value")).toBe("9000.00");
    expect(byLabel.get("Total across all stages")).toBe("18000.00");
  });
});

describe("documentToCsv", () => {
  it("emits a title line, per-section header + rows, and quotes a comma name once", () => {
    const doc = overviewToDocument({
      jobs: [{ week_start: "2026-06-01", total: 4, completed: 3 }],
      revenue: [{ month: "2026-06-01", revenue: 12000 }],
      vat: [],
      top: [{ id: "c1", name: "Acme, Inc.", revenue: 54000, invoice_count: 12 }],
      meta: META,
    });
    const csv = documentToCsv(doc);
    expect(csv.startsWith("Business overview")).toBe(true);
    expect(csv).toContain("Generated 2026-08-15T10:00:00.000Z");
    expect(csv).toContain("2026-06-01,12000.00"); // money as bare 2dp
    expect(csv).not.toContain("£");
    expect(csv).toContain('"Acme, Inc."'); // quoted once
    expect(csv).not.toContain('"""'); // no double-escaping
    // Empty section renders its empty-state line, not a header.
    expect(csv).toContain("No VAT activity");
  });
});
