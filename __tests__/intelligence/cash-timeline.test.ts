import { describe, it, expect } from "vitest";
import {
  computeCashTimeline,
  cashTimelineMetric,
  type CashEvent,
} from "@/lib/intelligence/cash-timeline";

/**
 * FORWARD CASH TIMELINE — deterministic weekly projection.
 *
 * Pins: correct week bucketing off the London day key, overdue folded into
 * week 1, undated/beyond-horizon carried apart (never guessed onto a week),
 * running cumulative + tightest point, the shortfall flag, and the honesty path
 * (no dated events → insufficient, never a flat £0 line).
 */

const TODAY = "2026-08-14"; // a Friday; week 0 = 14–20 Aug

function ev(over: Partial<CashEvent>): CashEvent {
  return {
    dateKey: null,
    direction: "in",
    amount: 0,
    category: "Test",
    certainty: "invoiced",
    label: null,
    href: null,
    ...over,
  };
}

describe("computeCashTimeline — bucketing and running balance", () => {
  const t = computeCashTimeline({
    todayKey: TODAY,
    horizonWeeks: 13,
    events: [
      ev({ dateKey: "2026-08-18", direction: "in", amount: 1000, category: "Invoice due" }), // week 0
      ev({ dateKey: "2026-08-25", direction: "in", amount: 500, category: "Invoice due" }), // week 1
      ev({ dateKey: "2026-09-07", direction: "out", amount: 800, category: "VAT", certainty: "estimated" }), // week 3
      ev({ dateKey: "2026-08-01", direction: "in", amount: 300, category: "Invoice due" }), // overdue → week 0
      ev({ dateKey: null, direction: "out", amount: 200, category: "Supplier bills" }), // undated
      ev({ dateKey: "2027-01-01", direction: "in", amount: 999, category: "Invoice due" }), // beyond horizon
    ],
  });

  it("builds one week per horizon week starting today", () => {
    expect(t.weeks).toHaveLength(13);
    expect(t.weeks[0]!.startDay).toBe("2026-08-14");
    expect(t.weeks[0]!.endDay).toBe("2026-08-20");
    expect(t.weeks[1]!.startDay).toBe("2026-08-21");
  });

  it("places dated events in the right week and folds overdue into week 0", () => {
    expect(t.weeks[0]!.inflow).toBe(1300); // 1000 due + 300 overdue
    expect(t.overdueInflow).toBe(300);
    expect(t.weeks[1]!.inflow).toBe(500);
    expect(t.weeks[3]!.outflow).toBe(800);
  });

  it("runs a cumulative net (change, not a balance) and finds the tightest point", () => {
    expect(t.weeks[0]!.cumulativeNet).toBe(1300);
    expect(t.weeks[1]!.cumulativeNet).toBe(1800);
    expect(t.weeks[3]!.cumulativeNet).toBe(1000); // 1800 − 800
    expect(t.totalInflow).toBe(1800); // beyond-horizon 999 excluded
    expect(t.totalOutflow).toBe(800); // undated 200 excluded
    expect(t.netMovement).toBe(1000);
    expect(t.lowestCumulative).toBe(1000);
    expect(t.lowestWeekIndex).toBe(3);
    expect(t.shortfall).toBe(false);
  });

  it("carries undated and beyond-horizon money apart, never onto a week", () => {
    expect(t.undated.outflow).toBe(200);
    expect(t.beyondHorizon.count).toBe(1);
    expect(t.beyondHorizon.inflow).toBe(999);
  });

  it("is sufficient (has dated events) and carries a labelled heuristic basis", () => {
    expect(t.sufficient).toBe(true);
    const m = cashTimelineMetric(t);
    expect(m.provenance.kind).toBe("heuristic");
    expect(m.provenance.basis).toMatch(/not your bank balance/i);
    expect(m.provenance.computedFrom.length).toBeGreaterThan(0);
  });
});

describe("computeCashTimeline — shortfall", () => {
  it("flags a shortfall when the running change dips below zero", () => {
    const t = computeCashTimeline({
      todayKey: TODAY,
      horizonWeeks: 4,
      events: [
        ev({ dateKey: "2026-08-15", direction: "out", amount: 5000, category: "VAT" }), // week 0
        ev({ dateKey: "2026-08-25", direction: "in", amount: 2000, category: "Invoice due" }), // week 1
      ],
    });
    expect(t.weeks[0]!.cumulativeNet).toBe(-5000);
    expect(t.lowestCumulative).toBe(-5000);
    expect(t.lowestWeekIndex).toBe(0);
    expect(t.shortfall).toBe(true);
  });
});

describe("computeCashTimeline — insufficient (honesty path)", () => {
  it("reports insufficient with only undated events — never a false £0 line or shortfall", () => {
    const t = computeCashTimeline({
      todayKey: TODAY,
      horizonWeeks: 6,
      events: [ev({ dateKey: null, direction: "out", amount: 400, category: "Supplier bills" })],
    });
    expect(t.sufficient).toBe(false);
    expect(t.shortfall).toBe(false); // an all-undated set must not manufacture a shortfall
    expect(t.totalInflow).toBe(0);
    expect(t.totalOutflow).toBe(0);
    expect(t.undated.outflow).toBe(400);
  });

  it("reports insufficient with no events at all", () => {
    const t = computeCashTimeline({ todayKey: TODAY, horizonWeeks: 6, events: [] });
    expect(t.sufficient).toBe(false);
    expect(t.weeks).toHaveLength(6);
    expect(t.weeks.every((w) => w.net === 0)).toBe(true);
  });
});
