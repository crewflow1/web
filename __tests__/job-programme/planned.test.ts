import { describe, expect, it } from "vitest";
import {
  buildPlannedCurve,
  buildPlannedProgress,
  plannedDomain,
  readWeight,
  unionDomain,
  type PlannedPoint,
  type ProgrammeBaselineRow,
  type ProgrammeMilestoneRow,
} from "@/lib/job-programme/planned";
import { buildProgressCurve, type ProgressPoint } from "@/lib/job-progress/series";

/**
 * The planned line — pure, and above all HONEST. The load-bearing behaviour in
 * this suite is every case where the answer is NULL: the module's contract is
 * that a fabricated planned line is worse than none, so anything short of a
 * current baseline with fully-weighted milestones summing to 100 emits
 * nothing at all.
 */

const baseline = (over: Partial<ProgrammeBaselineRow> = {}): ProgrammeBaselineRow => ({
  id: "b1",
  revision: 1,
  planned_start: "2026-06-01",
  planned_end: "2026-06-21",
  ...over,
});

let seq = 0;
const ms = (
  planned_end: string,
  weight: number | string | null,
  over: Partial<ProgrammeMilestoneRow> = {},
): ProgrammeMilestoneRow => ({
  id: `m${++seq}`,
  title: `Milestone ${seq}`,
  planned_start: null,
  planned_end,
  weight,
  customer_visible: false,
  sort: seq,
  ...over,
});

describe("readWeight", () => {
  it("accepts positive numbers and PostgREST numeric strings", () => {
    expect(readWeight(40)).toBe(40);
    expect(readWeight("35.50")).toBe(35.5);
    expect(readWeight(100)).toBe(100);
    expect(readWeight(0.01)).toBe(0.01);
  });

  it("DROPS zero, negative, out-of-range and unparseable values", () => {
    // Dropping nulls the whole curve via all-or-none; clamping would invent a share.
    expect(readWeight(0)).toBeNull();
    expect(readWeight(-5)).toBeNull();
    expect(readWeight(100.01)).toBeNull();
    expect(readWeight("plenty")).toBeNull();
    expect(readWeight(null)).toBeNull();
    expect(readWeight(undefined)).toBeNull();
    expect(readWeight("")).toBeNull();
  });
});

describe("buildPlannedProgress — the null cases are the contract", () => {
  it("no baseline → null", () => {
    expect(buildPlannedProgress(null, [ms("2026-06-10", 100)])).toBeNull();
    expect(buildPlannedProgress(undefined, [ms("2026-06-10", 100)])).toBeNull();
  });

  it("no milestones → null (a bare window is not a curve)", () => {
    expect(buildPlannedProgress(baseline(), [])).toBeNull();
  });

  it("UNWEIGHTED milestones → null, never a straight line", () => {
    expect(
      buildPlannedProgress(baseline(), [ms("2026-06-08", null), ms("2026-06-15", null)]),
    ).toBeNull();
  });

  it("PARTIALLY weighted milestones → null (all-or-none)", () => {
    expect(
      buildPlannedProgress(baseline(), [ms("2026-06-08", 60), ms("2026-06-15", null)]),
    ).toBeNull();
  });

  it("weights summing to anything but 100 (±0.01) → null", () => {
    expect(
      buildPlannedProgress(baseline(), [ms("2026-06-08", 40), ms("2026-06-15", 40)]),
    ).toBeNull();
    expect(
      buildPlannedProgress(baseline(), [ms("2026-06-08", 60), ms("2026-06-15", 40.02)]),
    ).toBeNull();
    // …but the write-side tolerance is honoured at read time.
    expect(
      buildPlannedProgress(baseline(), [ms("2026-06-08", 60), ms("2026-06-15", 40.005)]),
    ).not.toBeNull();
  });

  it("a milestone outside the baseline window → null (incoherent data earns no line)", () => {
    expect(
      buildPlannedProgress(baseline(), [ms("2026-06-08", 60), ms("2026-07-01", 40)]),
    ).toBeNull();
  });

  it("a malformed or inverted baseline window → null", () => {
    expect(
      buildPlannedProgress(baseline({ planned_start: "not-a-date" }), [ms("2026-06-08", 100)]),
    ).toBeNull();
    expect(
      buildPlannedProgress(
        baseline({ planned_start: "2026-06-21", planned_end: "2026-06-01" }),
        [ms("2026-06-10", 100)]),
    ).toBeNull();
  });
});

describe("buildPlannedProgress — vertices", () => {
  it("emits (start, 0) → cumulative milestone vertices in DATE order → (end, 100)", () => {
    const points = buildPlannedProgress(baseline(), [
      ms("2026-06-08", 40),
      ms("2026-06-15", 35),
      ms("2026-06-18", 25),
    ]);
    expect(points).toEqual([
      { day: "2026-06-01", percent: 0 },
      { day: "2026-06-08", percent: 40 },
      { day: "2026-06-15", percent: 75 },
      { day: "2026-06-18", percent: 100 },
      { day: "2026-06-21", percent: 100 },
    ]);
  });

  it("is PERMUTATION-INDEPENDENT — date order, never input order", () => {
    const a = buildPlannedProgress(baseline(), [
      ms("2026-06-18", 25),
      ms("2026-06-08", 40),
      ms("2026-06-15", 35),
    ]);
    const b = buildPlannedProgress(baseline(), [
      ms("2026-06-08", 40),
      ms("2026-06-15", 35),
      ms("2026-06-18", 25),
    ]);
    expect(a).toEqual(b);
  });

  it("merges same-day milestones into ONE vertex of their combined weight", () => {
    const points = buildPlannedProgress(baseline(), [
      ms("2026-06-08", 30),
      ms("2026-06-08", 30),
      ms("2026-06-15", 40),
    ]);
    expect(points).toEqual([
      { day: "2026-06-01", percent: 0 },
      { day: "2026-06-08", percent: 60 },
      { day: "2026-06-15", percent: 100 },
      { day: "2026-06-21", percent: 100 },
    ]);
  });

  it("does not duplicate the final vertex when the last milestone lands on planned_end", () => {
    const points = buildPlannedProgress(baseline(), [
      ms("2026-06-10", 50),
      ms("2026-06-21", 50),
    ]);
    expect(points).toEqual([
      { day: "2026-06-01", percent: 0 },
      { day: "2026-06-10", percent: 50 },
      { day: "2026-06-21", percent: 100 },
    ]);
  });

  it("snaps a tolerated Σ (e.g. 99.995) to exactly 100 at the final vertex", () => {
    const points = buildPlannedProgress(baseline(), [
      ms("2026-06-10", 49.995),
      ms("2026-06-21", 50),
    ]);
    expect(points![points!.length - 1]).toEqual({ day: "2026-06-21", percent: 100 });
  });
});

describe("domain union — one x-axis for two lines", () => {
  it("unionDomain takes the earliest from and the latest to", () => {
    expect(
      unionDomain(
        { from: "2026-06-05", to: "2026-06-12" },
        { from: "2026-06-01", to: "2026-06-21" },
      ),
    ).toEqual({ from: "2026-06-01", to: "2026-06-21" });
    expect(unionDomain(null, { from: "2026-06-01", to: "2026-06-21" })).toEqual({
      from: "2026-06-01",
      to: "2026-06-21",
    });
    expect(unionDomain({ from: "2026-06-01", to: "2026-06-02" }, null)).toEqual({
      from: "2026-06-01",
      to: "2026-06-02",
    });
    expect(unionDomain(null, null)).toBeNull();
  });

  it("plannedDomain is the first and last vertex day", () => {
    const points: PlannedPoint[] = [
      { day: "2026-06-01", percent: 0 },
      { day: "2026-06-21", percent: 100 },
    ];
    expect(plannedDomain(points)).toEqual({ from: "2026-06-01", to: "2026-06-21" });
    expect(plannedDomain([])).toBeNull();
  });

  it("series.ts respects a domain override WITHOUT changing its output shape", () => {
    const actual: ProgressPoint[] = [
      {
        day: "2026-06-11",
        percent: 50,
        source: "observation",
        sourceId: "o1",
        note: null,
        authorId: null,
        reference: null,
      },
    ];
    const domain = { from: "2026-06-01", to: "2026-06-21" };
    const c = buildProgressCurve(actual, {
      width: 100,
      height: 100,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      domain,
    });
    // 2026-06-11 is day 10 of a 20-day domain → exactly halfway across.
    expect(c.points[0]!.x).toBe(50);
    expect(c.domain).toEqual(domain);
    // The ProgressCurve shape gains NOTHING (the series suite pins this too).
    expect(Object.keys(c).sort()).toEqual([
      "areaPath",
      "domain",
      "gridlines",
      "height",
      "points",
      "polyline",
      "width",
    ]);
  });

  it("planned and actual lines place the SAME day at the SAME x (shared mapping)", () => {
    const opts = {
      width: 320,
      height: 120,
      domain: { from: "2026-06-01", to: "2026-06-21" },
    };
    const planned = buildPlannedProgress(baseline(), [
      ms("2026-06-11", 50),
      ms("2026-06-21", 50),
    ])!;
    const plannedCurve = buildPlannedCurve(planned, opts);
    const actualCurve = buildProgressCurve(
      [
        {
          day: "2026-06-11",
          percent: 50,
          source: "observation",
          sourceId: "o1",
          note: null,
          authorId: null,
          reference: null,
        },
      ],
      opts,
    );
    const plannedMid = plannedCurve.points.find((p) => p.day === "2026-06-11")!;
    expect(plannedMid.x).toBe(actualCurve.points[0]!.x);
    expect(plannedMid.y).toBe(actualCurve.points[0]!.y);
  });

  it("planned geometry carries ONLY day/percent/x/y — no filler fields leak out", () => {
    const planned = buildPlannedProgress(baseline(), [ms("2026-06-11", 100)])!;
    const curve = buildPlannedCurve(planned, { width: 320, height: 120 });
    for (const p of curve.points) {
      expect(Object.keys(p).sort()).toEqual(["day", "percent", "x", "y"]);
    }
    expect(curve.polyline.length).toBeGreaterThan(0);
  });
});
