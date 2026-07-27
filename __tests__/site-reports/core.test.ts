import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isDeletable,
  isEditable,
  isIssued,
  isTerminal,
  SITE_REPORT_STATUSES,
  type SiteReportStatus,
} from "@/lib/site-reports/state";
import {
  createSiteReportSchema,
  reportContentSchema,
} from "@/lib/site-reports/schema";
import {
  defaultSelection,
  filterSelected,
  materializeSnapshot,
  summariseSources,
  type RawSources,
} from "@/lib/site-reports/aggregate";

describe("site report state machine", () => {
  it("allows the documented lifecycle transitions", () => {
    expect(canTransition("draft", "ready_for_review")).toBe(true);
    expect(canTransition("ready_for_review", "approved")).toBe(true);
    expect(canTransition("approved", "issued")).toBe(true);
    expect(canTransition("issued", "superseded")).toBe(true);
    expect(canTransition("superseded", "archived")).toBe(true);
  });

  it("rejects skipping straight to issued or editing history", () => {
    expect(canTransition("draft", "issued")).toBe(false);
    expect(canTransition("draft", "approved")).toBe(false);
    expect(canTransition("issued", "draft")).toBe(false);
    expect(canTransition("archived", "draft")).toBe(false);
  });

  it("assertTransition throws a stable error for an invalid move", () => {
    expect(() => assertTransition("issued", "draft")).toThrowError(
      "invalid_transition:issued->draft",
    );
    expect(() => assertTransition("draft", "ready_for_review")).not.toThrow();
  });

  it("classifies editability, issue and terminality correctly", () => {
    expect(isEditable("draft")).toBe(true);
    expect(isEditable("ready_for_review")).toBe(true);
    expect(isEditable("approved")).toBe(false);
    expect(isEditable("issued")).toBe(false);
    expect(isIssued("issued")).toBe(true);
    expect(isTerminal("superseded")).toBe(true);
    expect(isTerminal("archived")).toBe(true);
    expect(isDeletable("draft")).toBe(true);
    expect(isDeletable("issued")).toBe(false);
  });

  it("never allows a transition out of an archived report", () => {
    for (const to of SITE_REPORT_STATUSES) {
      expect(canTransition("archived", to as SiteReportStatus)).toBe(false);
    }
  });
});

describe("createSiteReportSchema", () => {
  const uuid = "33333333-3333-3333-3333-333333333333";
  it("accepts a valid report and rejects an end-before-start period", () => {
    expect(
      createSiteReportSchema.safeParse({
        job_id: uuid,
        title: "Week 12 progress",
        period_start: "2026-07-01",
        period_end: "2026-07-07",
      }).success,
    ).toBe(true);
    expect(
      createSiteReportSchema.safeParse({
        job_id: uuid,
        title: "Bad period",
        period_start: "2026-07-07",
        period_end: "2026-07-01",
      }).success,
    ).toBe(false);
  });

  it("requires a job and a title", () => {
    expect(
      createSiteReportSchema.safeParse({
        job_id: "not-a-uuid",
        title: "x",
        period_start: "2026-07-01",
        period_end: "2026-07-07",
      }).success,
    ).toBe(false);
    expect(
      createSiteReportSchema.safeParse({
        job_id: uuid,
        title: "  ",
        period_start: "2026-07-01",
        period_end: "2026-07-07",
      }).success,
    ).toBe(false);
  });
});

describe("reportContentSchema", () => {
  it("clamps progress to 0-100 and coerces blanks", () => {
    expect(
      reportContentSchema.parse({ progress_percent: "60", summary: "" }),
    ).toMatchObject({ progress_percent: 60, summary: undefined });
    expect(
      reportContentSchema.safeParse({ progress_percent: "140" }).success,
    ).toBe(false);
    expect(
      reportContentSchema.safeParse({ progress_percent: "-5" }).success,
    ).toBe(false);
  });
});

describe("aggregation", () => {
  const sources: RawSources = {
    diary: [
      { id: "d1", entry_date: "2026-07-06", weather: "Dry", labour_count: 4, work_summary: "First fix", delays: null },
      { id: "d2", entry_date: "2026-07-05", weather: "Rain", labour_count: 2, work_summary: "Groundworks", delays: "Rain stopped pour" },
    ],
    snags: [
      { id: "s1", title: "Cracked tile", status: "open", priority: "high", location: "Ensuite", trade: "Tiling", due_date: "2026-07-01" },
      { id: "s2", title: "Seal missing", status: "verified", priority: "low", location: null, trade: null, due_date: null },
    ],
    toolbox: [
      { id: "t1", talk_date: "2026-07-06", topic: "Working at height", presenter: "Sam", attendee_count: 6 },
    ],
  };

  it("defaultSelection proposes every in-scope record", () => {
    const sel = defaultSelection(sources);
    expect(sel.diary_entry_ids).toEqual(["d1", "d2"]);
    expect(sel.snag_ids).toEqual(["s1", "s2"]);
    expect(sel.toolbox_talk_ids).toEqual(["t1"]);
  });

  it("summariseSources counts open + overdue snags and attendance", () => {
    const s = summariseSources(sources);
    expect(s.diary).toBe(2);
    expect(s.snags).toBe(2);
    expect(s.openSnags).toBe(1); // s1 open; s2 verified
    expect(s.overdueSnags).toBe(1); // s1 open + due 2026-07-01 < latest diary 2026-07-06
    expect(s.toolbox).toBe(1);
    expect(s.totalAttendance).toBe(6);
  });

  it("filterSelected narrows to chosen ids only", () => {
    const filtered = filterSelected(sources, {
      diary_entry_ids: ["d1"],
      snag_ids: [],
      toolbox_talk_ids: ["t1"],
      photo_attachment_ids: [],
    });
    expect(filtered.diary.map((d) => d.id)).toEqual(["d1"]);
    expect(filtered.snags).toHaveLength(0);
    expect(filtered.toolbox.map((t) => t.id)).toEqual(["t1"]);
  });

  it("materializeSnapshot freezes the selected sources + commentary", () => {
    const snap = materializeSnapshot({
      title: "Week 12 progress",
      reportNumber: "SR-0007",
      revision: 1,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-07",
      customerName: "Acme Developments",
      jobLabel: "Plot 4",
      content: { summary: "Good week", progress_percent: 60 },
      sources,
      selection: {
        diary_entry_ids: ["d1"],
        snag_ids: ["s1"],
        toolbox_talk_ids: [],
        photo_attachment_ids: [],
      },
      issuedAt: "2026-07-08T09:00:00.000Z",
    });
    expect(snap.report_number).toBe("SR-0007");
    expect(snap.customer_name).toBe("Acme Developments");
    expect(snap.content.progress_percent).toBe(60);
    // Only the selected records are frozen in.
    expect(snap.sources.diary).toHaveLength(1);
    expect(snap.sources.snags).toHaveLength(1);
    expect(snap.sources.toolbox_talks).toHaveLength(0);
    expect(snap.issued_at).toBe("2026-07-08T09:00:00.000Z");
  });
});
