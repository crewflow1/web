import { describe, it, expect } from "vitest";
import {
  resolveJobSpan,
  buildGanttWindow,
  layoutBar,
  layoutGantt,
  groupResourceLanes,
  daysBetween,
  addDays,
} from "@/lib/jobs/span";

/**
 * Span + gantt/resource layout proofs (capabilities 4 & 5: multi-day spans and
 * the gantt / resource-swimlane views).
 */

describe("date helpers", () => {
  it("daysBetween is exact whole days; addDays is inverse", () => {
    expect(daysBetween("2026-08-01", "2026-08-05")).toBe(4);
    expect(addDays("2026-08-01", 4)).toBe("2026-08-05");
    expect(daysBetween("2026-08-01", "bad")).toBeNaN();
  });
});

describe("resolveJobSpan — backward compatible single-day behaviour", () => {
  it("null scheduled_date → no span (unscheduled job)", () => {
    expect(resolveJobSpan(null, null)).toBeNull();
    expect(resolveJobSpan(null, "2026-08-05")).toBeNull();
  });

  it("no end date → single-day span (today's behaviour, unchanged)", () => {
    expect(resolveJobSpan("2026-08-10", null)).toEqual({
      start: "2026-08-10",
      end: "2026-08-10",
      days: 1,
      multiDay: false,
    });
  });

  it("a real end date makes a multi-day span", () => {
    expect(resolveJobSpan("2026-08-10", "2026-08-14")).toEqual({
      start: "2026-08-10",
      end: "2026-08-14",
      days: 5,
      multiDay: true,
    });
  });

  it("an end on the same day collapses to single-day", () => {
    expect(resolveJobSpan("2026-08-10", "2026-08-10")?.multiDay).toBe(false);
  });

  it("an end BEFORE the start is ignored (collapses to single-day)", () => {
    // The DB CHECK forbids this, but the reader must degrade safely.
    const s = resolveJobSpan("2026-08-10", "2026-08-01");
    expect(s).toEqual({
      start: "2026-08-10",
      end: "2026-08-10",
      days: 1,
      multiDay: false,
    });
  });
});

describe("layoutBar — window clipping", () => {
  const window = buildGanttWindow("2026-08-10", "2026-08-16"); // 7 days

  it("a fully-inside bar is not clipped", () => {
    const bar = layoutBar("x", resolveJobSpan("2026-08-11", "2026-08-13")!, window)!;
    expect(bar.offsetDays).toBe(1);
    expect(bar.spanDays).toBe(3);
    expect(bar.clippedStart).toBe(false);
    expect(bar.clippedEnd).toBe(false);
  });

  it("a bar starting before the window is left-clipped", () => {
    const bar = layoutBar("x", resolveJobSpan("2026-08-08", "2026-08-12")!, window)!;
    expect(bar.offsetDays).toBe(0);
    expect(bar.spanDays).toBe(3); // 10,11,12 visible
    expect(bar.clippedStart).toBe(true);
    expect(bar.clippedEnd).toBe(false);
  });

  it("a bar ending after the window is right-clipped", () => {
    const bar = layoutBar("x", resolveJobSpan("2026-08-15", "2026-08-20")!, window)!;
    expect(bar.offsetDays).toBe(5);
    expect(bar.spanDays).toBe(2); // 15,16 visible
    expect(bar.clippedEnd).toBe(true);
  });

  it("a bar entirely outside the window is dropped (null)", () => {
    expect(layoutBar("x", resolveJobSpan("2026-09-01", "2026-09-03")!, window)).toBeNull();
    expect(layoutBar("x", resolveJobSpan("2026-07-01", "2026-07-03")!, window)).toBeNull();
  });

  it("fractions are relative to the window width", () => {
    const bar = layoutBar("x", resolveJobSpan("2026-08-10", "2026-08-10")!, window)!;
    expect(bar.offsetFraction).toBeCloseTo(0);
    expect(bar.widthFraction).toBeCloseTo(1 / 7);
  });
});

describe("layoutGantt — ordering & drop", () => {
  const window = buildGanttWindow("2026-08-10", "2026-08-20");
  type Job = { id: string; d: string | null; e: string | null };
  const jobs: Job[] = [
    { id: "late", d: "2026-08-15", e: null },
    { id: "early", d: "2026-08-11", e: "2026-08-13" },
    { id: "outside", d: "2026-09-01", e: null },
    { id: "unscheduled", d: null, e: null },
  ];

  it("drops out-of-window + unscheduled, orders by visible start", () => {
    const bars = layoutGantt(
      jobs,
      window,
      (j) => resolveJobSpan(j.d, j.e),
      (j) => j.id,
    );
    expect(bars.map((b) => b.item.id)).toEqual(["early", "late"]);
  });
});

describe("groupResourceLanes", () => {
  const window = buildGanttWindow("2026-08-10", "2026-08-20");
  type Job = { id: string; d: string; who: string | null };
  const staff = [
    { id: "u1", name: "Alice" },
    { id: "u2", name: "Bob" },
  ];
  const jobs: Job[] = [
    { id: "j1", d: "2026-08-11", who: "u1" },
    { id: "j2", d: "2026-08-12", who: "u2" },
    { id: "j3", d: "2026-08-13", who: null },
    { id: "j4", d: "2026-08-14", who: "ghost" }, // removed member
  ];
  const bars = layoutGantt(
    jobs,
    window,
    (j) => resolveJobSpan(j.d, null),
    (j) => j.id,
  );

  it("one lane per staff member (stable order) + an Unassigned lane", () => {
    const lanes = groupResourceLanes(bars, staff, (j) => j.who);
    expect(lanes.map((l) => l.label)).toEqual(["Alice", "Bob", "Unassigned"]);
    expect(lanes[0]!.bars.map((b) => b.item.id)).toEqual(["j1"]);
    expect(lanes[1]!.bars.map((b) => b.item.id)).toEqual(["j2"]);
    // Unassigned catches both the null and the since-removed assignee.
    expect(lanes[2]!.bars.map((b) => b.item.id).sort()).toEqual(["j3", "j4"]);
  });

  it("no Unassigned lane when every bar has a known assignee", () => {
    const onlyAssigned = bars.filter(
      (b) => b.item.who === "u1" || b.item.who === "u2",
    );
    const lanes = groupResourceLanes(onlyAssigned, staff, (j) => j.who);
    expect(lanes.map((l) => l.label)).toEqual(["Alice", "Bob"]);
  });
});
