import { describe, it, expect } from "vitest";
import {
  addDays,
  buildScheduleWindow,
  daysBetween,
  intersection,
  overlaps,
  SCHEDULE_WINDOW_DAYS,
  ukDayEndMs,
  ukDayInterval,
  ukDayKeyOf,
  ukDayStartMs,
} from "@/lib/schedule/window";

/**
 * The maths the whole detector rests on. If either half is wrong the conflict
 * list is wrong in a way no integration test would obviously reveal — a missed
 * clash looks exactly like a clean week.
 */

const iv = (start: number, end: number) => ({ start, end });

describe("overlaps — boundary semantics", () => {
  it("treats touching endpoints as a HANDOVER, not an overlap", () => {
    // 08:00–12:00 and 12:00–17:00. This is the product's decision, and it is the
    // same rule the rota form's write-time guard applies.
    expect(overlaps(iv(8, 12), iv(12, 17))).toBe(false);
    expect(overlaps(iv(12, 17), iv(8, 12))).toBe(false);
    expect(intersection(iv(8, 12), iv(12, 17))).toBeNull();
  });

  it("detects a one-millisecond genuine overlap in both directions", () => {
    expect(overlaps(iv(8, 12), iv(11.999, 17))).toBe(true);
    expect(overlaps(iv(11.999, 17), iv(8, 12))).toBe(true);
  });

  it("detects containment, and reports the CONTAINED span as the clash", () => {
    expect(overlaps(iv(8, 18), iv(10, 12))).toBe(true);
    expect(intersection(iv(8, 18), iv(10, 12))).toEqual(iv(10, 12));
    expect(intersection(iv(10, 12), iv(8, 18))).toEqual(iv(10, 12));
  });

  it("reports identical intervals as fully overlapping", () => {
    // The auto-created 08:00–17:00 shift from two job assignments on one date.
    expect(overlaps(iv(8, 17), iv(8, 17))).toBe(true);
    expect(intersection(iv(8, 17), iv(8, 17))).toEqual(iv(8, 17));
  });

  it("says a ZERO-LENGTH interval overlaps nothing — including itself", () => {
    expect(overlaps(iv(10, 10), iv(10, 10))).toBe(false);
    expect(overlaps(iv(10, 10), iv(0, 20))).toBe(false);
    expect(overlaps(iv(0, 20), iv(10, 10))).toBe(false);
  });

  it("says disjoint intervals never overlap", () => {
    expect(overlaps(iv(8, 12), iv(13, 17))).toBe(false);
    expect(intersection(iv(8, 12), iv(13, 17))).toBeNull();
  });
});

describe("Europe/London day boundaries", () => {
  it("starts a GMT (winter) day at 00:00 UTC", () => {
    expect(new Date(ukDayStartMs("2026-01-15")).toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(new Date(ukDayEndMs("2026-01-15")).toISOString()).toBe("2026-01-16T00:00:00.000Z");
  });

  it("starts a BST (summer) day at 23:00 UTC the PREVIOUS day", () => {
    // The bug this prevents: a 23:30Z shift on 19 July is 00:30 on the 20th in
    // London, and must be filed — and compared against leave — as the 20th.
    expect(new Date(ukDayStartMs("2026-07-20")).toISOString()).toBe("2026-07-19T23:00:00.000Z");
    expect(new Date(ukDayEndMs("2026-07-20")).toISOString()).toBe("2026-07-20T23:00:00.000Z");
    expect(ukDayKeyOf("2026-07-19T23:30:00Z")).toBe("2026-07-20");
  });

  it("makes the spring-forward day 23 hours long (29 March 2026, 01:00Z)", () => {
    const day = ukDayInterval("2026-03-29");
    expect(new Date(day.start).toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(new Date(day.end).toISOString()).toBe("2026-03-29T23:00:00.000Z");
    expect(day.end - day.start).toBe(23 * 3_600_000);
  });

  it("makes the fall-back day 25 hours long (25 October 2026, 01:00Z)", () => {
    const day = ukDayInterval("2026-10-25");
    // Opens at 23:00Z on the 24th (still BST) and closes at 00:00Z on the 26th
    // (back on GMT) — 25 real hours, with the clocks going back inside it.
    expect(new Date(day.start).toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(new Date(day.end).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(day.end - day.start).toBe(25 * 3_600_000);
  });

  it("keeps every day contiguous across both 2026 transitions", () => {
    for (const [a, b] of [
      ["2026-03-28", "2026-03-29"],
      ["2026-03-29", "2026-03-30"],
      ["2026-10-24", "2026-10-25"],
      ["2026-10-25", "2026-10-26"],
    ] as const) {
      expect(ukDayEndMs(a)).toBe(ukDayStartMs(b));
    }
  });

  it("round-trips every day of 2026 through the day-key formatter", () => {
    let key = "2026-01-01";
    let checked = 0;
    while (key <= "2026-12-31") {
      const start = ukDayStartMs(key);
      // The first instant of the day, and the last, must both bucket to it.
      expect(ukDayKeyOf(new Date(start).toISOString())).toBe(key);
      expect(ukDayKeyOf(new Date(ukDayEndMs(key) - 1).toISOString())).toBe(key);
      key = addDays(key, 1);
      checked += 1;
    }
    expect(checked).toBe(365);
  });

  it("returns NaN for a malformed key rather than an arbitrary instant", () => {
    expect(Number.isNaN(ukDayStartMs("not-a-date"))).toBe(true);
    expect(Number.isNaN(ukDayStartMs(""))).toBe(true);
  });
});

describe("day arithmetic", () => {
  it("adds and subtracts whole calendar days across month and year ends", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("counts whole days ACROSS a DST transition without drifting", () => {
    // 23- and 25-hour days must still count as one day each.
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2026-07-20", "2026-07-20")).toBe(0);
    expect(daysBetween("2026-07-20", "2026-07-19")).toBe(-1);
  });
});

describe("buildScheduleWindow", () => {
  it("opens at the START of today's UK day, not at `now`", () => {
    // A shift already running this morning must stay in scope.
    const w = buildScheduleWindow(new Date("2026-07-20T14:30:00Z"));
    expect(w.fromDay).toBe("2026-07-20");
    expect(new Date(w.interval.start).toISOString()).toBe("2026-07-19T23:00:00.000Z");
  });

  it("covers a fortnight INCLUSIVE of today", () => {
    const w = buildScheduleWindow(new Date("2026-07-20T09:00:00Z"));
    expect(SCHEDULE_WINDOW_DAYS).toBe(14);
    expect(w.toDay).toBe("2026-08-02");
    expect(daysBetween(w.fromDay, w.toDay)).toBe(13);
    expect(new Date(w.interval.end).toISOString()).toBe("2026-08-02T23:00:00.000Z");
  });

  it("buckets a late-evening BST instant under TOMORROW's UK day", () => {
    const w = buildScheduleWindow(new Date("2026-07-19T23:30:00Z"));
    expect(w.fromDay).toBe("2026-07-20");
  });

  it("accepts a custom length and never produces a zero-length window", () => {
    expect(buildScheduleWindow(new Date("2026-07-20T09:00:00Z"), 1).toDay).toBe("2026-07-20");
    expect(buildScheduleWindow(new Date("2026-07-20T09:00:00Z"), 0).toDay).toBe("2026-07-20");
  });
});
