import { describe, it, expect } from "vitest";
import {
  workingDaysBetween,
  leaveYearBounds,
  entitledDaysForYear,
  accruedDays,
  computeCarryOver,
  workingDaysInWindow,
  computeHolidayBalance,
  DEFAULT_HOLIDAY_ENTITLEMENT,
  STATUTORY_ANNUAL_ALLOWANCE_DAYS,
  type HolidayEntitlementConfig,
} from "@/lib/staff/holiday";

/**
 * Holiday entitlement — the deterministic accrual / balance / carry-over maths.
 * Every figure here is hand-worked so a change in the engine that shifts a
 * balance is caught to the day.
 */

const JAN_YEAR: HolidayEntitlementConfig = {
  annual_allowance_days: 28,
  accrual_method: "immediate",
  carry_over_max_days: 5,
  leave_year_start_month: 1,
  leave_year_start_day: 1,
};

describe("workingDaysBetween — inclusive Mon–Fri", () => {
  it("counts a full working week as 5", () => {
    // 2026-01-05 is a Monday, 2026-01-09 the Friday.
    expect(workingDaysBetween("2026-01-05", "2026-01-09")).toBe(5);
  });

  it("excludes the weekend inside a Mon→Sun span", () => {
    // Mon 5th → Sun 11th: still 5 working days (Sat/Sun dropped).
    expect(workingDaysBetween("2026-01-05", "2026-01-11")).toBe(5);
  });

  it("a single weekday is 1 day; a single weekend day is 0", () => {
    expect(workingDaysBetween("2026-01-06", "2026-01-06")).toBe(1); // Tue
    expect(workingDaysBetween("2026-01-10", "2026-01-10")).toBe(0); // Sat
  });

  it("a reversed range is 0", () => {
    expect(workingDaysBetween("2026-01-09", "2026-01-05")).toBe(0);
  });

  it("two full working weeks (Mon→next Fri) = 10", () => {
    expect(workingDaysBetween("2026-01-05", "2026-01-16")).toBe(10);
  });
});

describe("leaveYearBounds", () => {
  it("Jan boundary: a mid-year date maps to the calendar year", () => {
    expect(leaveYearBounds("2026-06-15", 1, 1)).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
    });
  });

  it("April boundary: after 1 Apr maps to Apr→next Mar", () => {
    expect(leaveYearBounds("2026-06-15", 4, 1)).toEqual({
      start: "2026-04-01",
      end: "2027-03-31",
    });
  });

  it("April boundary: before 1 Apr maps to the PREVIOUS April", () => {
    expect(leaveYearBounds("2026-02-15", 4, 1)).toEqual({
      start: "2025-04-01",
      end: "2026-03-31",
    });
  });

  it("clamps an out-of-range boundary day to the month", () => {
    // Feb 31 → Feb 28 (2026 is not a leap year).
    expect(leaveYearBounds("2026-06-15", 2, 31).start).toBe("2026-02-28");
  });
});

describe("entitledDaysForYear — mid-year-joiner proration", () => {
  it("full allowance when employed before the leave year", () => {
    expect(entitledDaysForYear(JAN_YEAR, "2026-01-01", "2020-01-01")).toBe(28);
  });

  it("no employment date ⇒ full allowance", () => {
    expect(entitledDaysForYear(JAN_YEAR, "2026-01-01", null)).toBe(28);
  });

  it("a joiner 6 whole months in earns half the allowance", () => {
    // start 2026-07-01, leave year 2026-01-01 → 6 months in → 28×6/12 = 14.
    expect(entitledDaysForYear(JAN_YEAR, "2026-01-01", "2026-07-01")).toBe(14);
  });
});

describe("accruedDays", () => {
  it("immediate: full (pro-rated) allowance once accrual starts", () => {
    expect(accruedDays(JAN_YEAR, "2026-06-15", "2026-01-01", null)).toBe(28);
  });

  it("immediate: 0 before the accrual start (a future joiner)", () => {
    expect(accruedDays(JAN_YEAR, "2026-06-15", "2026-01-01", "2026-07-01")).toBe(
      0,
    );
  });

  it("monthly: accrues 1/12 of the annual allowance per completed month", () => {
    const cfg = { ...JAN_YEAR, accrual_method: "monthly" as const };
    // Jan 1 → Jul 1 = 6 whole months → 28×6/12 = 14.
    expect(accruedDays(cfg, "2026-07-01", "2026-01-01", null)).toBe(14);
  });

  it("monthly: never exceeds the pro-rated year allowance", () => {
    const cfg = { ...JAN_YEAR, accrual_method: "monthly" as const };
    // Joiner 2026-07-01 (pro-rated cap 14); by year end 8 months worked would be
    // 28×8/12 ≈ 18.67, but it is capped at the 14 they are entitled to.
    expect(accruedDays(cfg, "2027-03-01", "2026-01-01", "2026-07-01")).toBe(14);
  });
});

describe("computeCarryOver", () => {
  it("carries the unused remainder, capped by the maximum", () => {
    expect(computeCarryOver(28, 20, 5)).toBe(5); // unused 8, capped to 5
    expect(computeCarryOver(28, 26, 5)).toBe(2); // unused 2, under the cap
  });

  it("never carries a negative (over-taken) or exceeds the cap", () => {
    expect(computeCarryOver(28, 30, 5)).toBe(0);
    expect(computeCarryOver(28, 0, 0)).toBe(0);
  });
});

describe("workingDaysInWindow — status filter + boundary clipping", () => {
  const spans = [
    { starts_at: "2026-03-02", ends_at: "2026-03-06", status: "approved" }, // 5 wd
    { starts_at: "2026-04-06", ends_at: "2026-04-08", status: "pending" }, // 3 wd
    { starts_at: "2026-05-04", ends_at: "2026-05-08", status: "rejected" }, // ignored
  ];

  it("counts only the requested statuses", () => {
    expect(
      workingDaysInWindow(spans, "2026-01-01", "2026-12-31", ["approved"]),
    ).toBe(5);
    expect(
      workingDaysInWindow(spans, "2026-01-01", "2026-12-31", ["pending"]),
    ).toBe(3);
  });

  it("clips a span that straddles the window boundary", () => {
    // A 2-week span, only the second week inside the window.
    const straddle = [
      { starts_at: "2025-12-29", ends_at: "2026-01-09", status: "approved" },
    ];
    // Window opens 2026-01-01; 2026-01-01 (Thu) → 2026-01-09 (Fri) = 7 wd.
    expect(
      workingDaysInWindow(straddle, "2026-01-01", "2026-12-31", ["approved"]),
    ).toBe(7);
  });

  it("ignores a span entirely outside the window", () => {
    expect(
      workingDaysInWindow(spans, "2027-01-01", "2027-12-31", ["approved"]),
    ).toBe(0);
  });
});

describe("computeHolidayBalance", () => {
  it("remaining = accrued + carried − taken − booked", () => {
    const bal = computeHolidayBalance({
      config: { ...JAN_YEAR, carry_over_max_days: 0 },
      refIso: "2026-06-15",
      employmentStartIso: "2020-01-01",
      spans: [
        // current year: 5 approved (taken), 3 pending (booked)
        { starts_at: "2026-03-02", ends_at: "2026-03-06", status: "approved" },
        { starts_at: "2026-04-06", ends_at: "2026-04-08", status: "pending" },
      ],
    });
    expect(bal.allowance_days).toBe(28);
    expect(bal.accrued_days).toBe(28);
    expect(bal.taken_days).toBe(5);
    expect(bal.booked_days).toBe(3);
    expect(bal.carried_over_days).toBe(0);
    expect(bal.remaining_days).toBe(20);
    expect(bal.leave_year_start).toBe("2026-01-01");
    expect(bal.leave_year_end).toBe("2026-12-31");
  });

  it("brings forward capped carry-over from the previous leave year", () => {
    const bal = computeHolidayBalance({
      config: JAN_YEAR, // cap 5
      refIso: "2026-02-02",
      employmentStartIso: "2020-01-01",
      spans: [
        // previous year (2025): only 20 wd taken of 28 → 8 unused, capped to 5.
        { starts_at: "2025-06-02", ends_at: "2025-06-27", status: "approved" },
      ],
    });
    // 2025-06-02 (Mon) → 2025-06-27 (Fri) = 20 working days taken last year.
    expect(bal.carried_over_days).toBe(5);
    // This year: nothing taken; accrued 28 + carried 5 = 33 remaining.
    expect(bal.taken_days).toBe(0);
    expect(bal.remaining_days).toBe(33);
  });

  it("a mid-year joiner sees a pro-rated allowance and can go negative if over-booked", () => {
    const bal = computeHolidayBalance({
      config: { ...JAN_YEAR, carry_over_max_days: 0 },
      refIso: "2026-08-01",
      employmentStartIso: "2026-07-01", // 6 months in → allowance 14
      spans: [
        // 16 working days booked (2 approved weeks + 1 pending week + 1 day)
        { starts_at: "2026-07-13", ends_at: "2026-07-24", status: "approved" }, // 10 wd
        { starts_at: "2026-07-27", ends_at: "2026-07-31", status: "pending" }, // 5 wd
        { starts_at: "2026-08-03", ends_at: "2026-08-03", status: "pending" }, // 1 wd
      ],
    });
    expect(bal.allowance_days).toBe(14);
    expect(bal.accrued_days).toBe(14); // immediate
    expect(bal.taken_days).toBe(10);
    expect(bal.booked_days).toBe(6);
    expect(bal.remaining_days).toBe(-2); // over-booked; surfaced, not hidden
  });
});

describe("defaults", () => {
  it("the statutory default is 28 days, immediate, no carry-over, Jan year", () => {
    expect(STATUTORY_ANNUAL_ALLOWANCE_DAYS).toBe(28);
    expect(DEFAULT_HOLIDAY_ENTITLEMENT).toEqual({
      annual_allowance_days: 28,
      accrual_method: "immediate",
      carry_over_max_days: 0,
      leave_year_start_month: 1,
      leave_year_start_day: 1,
    });
  });
});
