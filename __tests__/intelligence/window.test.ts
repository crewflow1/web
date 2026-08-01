import { describe, it, expect } from "vitest";
import {
  monthsBeforeDayKey,
  trailingDayWindow,
  trailingMonthsWindow,
} from "@/lib/intelligence/window";

/**
 * London-pinned windows — the boundary pins.
 *
 * The repo just had a BST month-end incident, so these tests freeze the exact
 * instants where a UTC day key and a London day key disagree: 23:30Z on 31
 * July is 00:30 on 1 AUGUST in London. Every window must be built from the
 * London day, never from `toISOString()` day maths.
 */

describe("trailingDayWindow", () => {
  it("pins the BST month-end: 23:30Z on 31 July is 1 August in London", () => {
    const now = new Date("2026-07-31T23:30:00Z");
    const w = trailingDayWindow(now, 30);
    expect(w.toDay).toBe("2026-08-01"); // NOT 2026-07-31 (the UTC lie)
    expect(w.fromDay).toBe("2026-07-03");
  });

  it("bounds the window with true London-midnight instants (BST = 23:00Z)", () => {
    const w = trailingDayWindow(new Date("2026-07-31T23:30:00Z"), 30);
    // London 2026-07-03 begins at 2026-07-02T23:00:00Z (BST, UTC+1).
    expect(new Date(w.startMs).toISOString()).toBe("2026-07-02T23:00:00.000Z");
    // Exclusive end: start of 2026-08-02 London = 2026-08-01T23:00:00Z.
    expect(new Date(w.endMs).toISOString()).toBe("2026-08-01T23:00:00.000Z");
  });

  it("uses GMT midnights in winter", () => {
    const w = trailingDayWindow(new Date("2026-01-15T12:00:00Z"), 7);
    expect(w.toDay).toBe("2026-01-15");
    expect(w.fromDay).toBe("2026-01-09");
    expect(new Date(w.startMs).toISOString()).toBe("2026-01-09T00:00:00.000Z");
  });

  it("a 1-day window is just today", () => {
    const w = trailingDayWindow(new Date("2026-06-10T10:00:00Z"), 1);
    expect(w.fromDay).toBe("2026-06-10");
    expect(w.toDay).toBe("2026-06-10");
  });
});

describe("monthsBeforeDayKey", () => {
  it("plain year subtraction", () => {
    expect(monthsBeforeDayKey("2026-08-01", 12)).toBe("2025-08-01");
  });

  it("clamps to the shorter month's last day (leap February)", () => {
    expect(monthsBeforeDayKey("2028-03-31", 1)).toBe("2028-02-29");
  });

  it("clamps to a non-leap February", () => {
    expect(monthsBeforeDayKey("2026-05-31", 3)).toBe("2026-02-28");
  });

  it("crosses a year boundary", () => {
    expect(monthsBeforeDayKey("2026-01-31", 2)).toBe("2025-11-30");
  });

  it("returns malformed keys unchanged rather than guessing", () => {
    expect(monthsBeforeDayKey("not-a-day", 12)).toBe("not-a-day");
  });
});

describe("trailingMonthsWindow", () => {
  it("12 months back from the London day, BST pinned", () => {
    const w = trailingMonthsWindow(new Date("2026-07-31T23:30:00Z"), 12);
    expect(w.toDay).toBe("2026-08-01");
    expect(w.fromDay).toBe("2025-08-01");
    // London 2025-08-01 begins at 2025-07-31T23:00:00Z.
    expect(new Date(w.startMs).toISOString()).toBe("2025-07-31T23:00:00.000Z");
  });
});
