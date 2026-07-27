import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { SiteReportPdf, type SiteReportPdfInput } from "@/lib/pdf/site-report-pdf";

/**
 * PDF-generation test: render the Site Report component to a real PDF buffer
 * (server-side, exactly as the /api/site-reports/[id]/pdf route does) and assert
 * it produced a well-formed, non-trivial document. Proves the template compiles
 * and renders across its sections without throwing.
 */

const input: SiteReportPdfInput = {
  title: "Weekly progress report — week 12",
  report_number: "SR-0007",
  revision: 2,
  status: "issued",
  period_start: "2026-07-01",
  period_end: "2026-07-07",
  customer_name: "Acme Developments",
  job_label: "Plot 4 — Maple Rise",
  issued_at: "2026-07-08T09:00:00.000Z",
  content: {
    overall_status: "On track",
    current_phase: "First fix",
    progress_percent: 60,
    summary: "Good week; first fix plumbing completed on plots 3-5.",
    achievements: "Kitchen units delivered and stored.",
    work_planned: "Second fix electrics; plastering to plot 4.",
    risks: "Material lead times on tiling.",
    client_decisions: "Confirm bathroom tile choice by Friday.",
    next_steps: "Building control inspection booked Thursday.",
  },
  diary: [
    { id: "d1", entry_date: "2026-07-06", weather: "Dry", labour_count: 4, work_summary: "First fix", delays: null },
  ],
  snags: [
    { id: "s1", title: "Cracked tile", status: "open", priority: "high", location: "Ensuite", trade: "Tiling", due_date: "2026-07-10" },
    { id: "s2", title: "Seal missing", status: "verified", priority: "low", location: null, trade: null, due_date: null },
  ],
  toolbox: [
    { id: "t1", talk_date: "2026-07-06", topic: "Working at height", presenter: "Sam", attendee_count: 6 },
  ],
  prepared_by_name: "Jordan Lee",
  approved_by_name: "Sam Carter",
  approved_at: "2026-07-08T08:30:00.000Z",
  org_name: "Carter Construction Ltd",
  org_phone: "0161 000 0000",
  org_vat_number: "GB123456789",
  org_logo_url: null,
  org_address: { line1: "1 Trade Park", city: "Manchester", postcode: "M1 1AA" },
};

describe("SiteReportPdf", () => {
  it("renders a well-formed, non-trivial PDF buffer", async () => {
    const buffer = await renderToBuffer(SiteReportPdf({ r: input }));
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders without throwing when content + sources are empty (draft preview)", async () => {
    const bare: SiteReportPdfInput = {
      ...input,
      status: "draft",
      issued_at: null,
      content: {},
      diary: [],
      snags: [],
      toolbox: [],
      report_number: null,
      customer_name: null,
      job_label: null,
      approved_by_name: null,
      approved_at: null,
    };
    const buffer = await renderToBuffer(SiteReportPdf({ r: bare }));
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
