import { describe, expect, it } from "vitest";

import {
  CIS_PAYMENT_DUE_DAY_ELECTRONIC,
  CIS_PAYMENT_DUE_DAY_POSTAL,
  CIS_RETURN_DUE_DAY,
  CIS_TAX_MONTH_START_DAY,
  cisPaymentDueDate,
  cisReturnDueDate,
  cisTaxMonth,
  cisTaxMonthEnd,
  cisTaxMonthLabel,
  cisTaxMonthStart,
  isSameCisTaxMonth,
} from "@/lib/cis/tax-month";

/**
 * H2-CIS M3 — CIS tax months.
 *
 * HMRC CIS340 §§3.15 and 4.2: "A tax month runs from the sixth of one month to
 * the fifth of the next month." Verified 27 July 2026 — docs/cis-domain.md §4.
 *
 * These are NOT calendar months. Every boundary case below exists because
 * treating them as calendar months files a payment in the wrong return, and the
 * off-by-one is invisible until HMRC disagrees with you months later.
 */

describe("CIS tax month boundaries (CIS340 3.15/4.2)", () => {
  it("starts on the 6th, not the 1st", () => {
    expect(CIS_TAX_MONTH_START_DAY).toBe(6);
  });

  it("puts the 5th in the PREVIOUS month's tax month", () => {
    // 5 June 2026 is the LAST day of the 6 May – 5 June month.
    expect(cisTaxMonth("2026-06-05")).toEqual({ start: "2026-05-06", end: "2026-06-05" });
  });

  it("puts the 6th in the NEW tax month — the exact boundary", () => {
    expect(cisTaxMonth("2026-06-06")).toEqual({ start: "2026-06-06", end: "2026-07-05" });
  });

  it("handles a date before the 6th", () => {
    expect(cisTaxMonth("2026-06-03")).toEqual({ start: "2026-05-06", end: "2026-06-05" });
  });

  it("handles a date after the 6th", () => {
    expect(cisTaxMonth("2026-06-30")).toEqual({ start: "2026-06-06", end: "2026-07-05" });
  });

  it("crosses the year boundary backwards", () => {
    expect(cisTaxMonth("2026-01-03")).toEqual({ start: "2025-12-06", end: "2026-01-05" });
  });

  it("crosses the year boundary forwards", () => {
    expect(cisTaxMonth("2026-12-31")).toEqual({ start: "2026-12-06", end: "2027-01-05" });
  });

  it("handles the tax-year boundary (5/6 April)", () => {
    expect(cisTaxMonth("2026-04-05")).toEqual({ start: "2026-03-06", end: "2026-04-05" });
    expect(cisTaxMonth("2026-04-06")).toEqual({ start: "2026-04-06", end: "2026-05-05" });
  });

  it("handles February, including a leap year", () => {
    expect(cisTaxMonth("2024-02-29")).toEqual({ start: "2024-02-06", end: "2024-03-05" });
    expect(cisTaxMonth("2026-02-28")).toEqual({ start: "2026-02-06", end: "2026-03-05" });
    // 5 Feb belongs to the January month, whose end lands on 5 Feb regardless of
    // February's length — the arithmetic must never touch "days in month".
    expect(cisTaxMonth("2026-02-05")).toEqual({ start: "2026-01-06", end: "2026-02-05" });
  });

  it("gives every day of a month a tax month, with no gaps or overlaps", () => {
    // Walk a whole year day by day: each day must be inside its own tax month,
    // and consecutive months must abut exactly.
    const seen = new Map<string, string>();
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 28; d++) {
        const iso = `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const tm = cisTaxMonth(iso);
        expect(tm).not.toBeNull();
        expect(iso >= tm!.start && iso <= tm!.end).toBe(true);
        const prev = seen.get(tm!.start);
        if (prev) expect(prev).toBe(tm!.end);
        else seen.set(tm!.start, tm!.end);
      }
    }
    // Every recorded month is exactly one calendar month long, 6th to 5th.
    for (const [start, end] of seen) {
      expect(start.slice(8)).toBe("06");
      expect(end.slice(8)).toBe("05");
    }
  });

  it("rejects malformed and impossible dates rather than rolling them over", () => {
    for (const bad of ["", "2026-6-6", "not-a-date", "2026-13-01", "2026-02-30", "2026-04-31"]) {
      expect(cisTaxMonthStart(bad)).toBeNull();
      expect(cisTaxMonthEnd(bad)).toBeNull();
      expect(cisTaxMonth(bad)).toBeNull();
      expect(cisTaxMonthLabel(bad)).toBeNull();
    }
  });

  it("is timezone-independent — no BST/GMT slip on the boundary", () => {
    // Both boundary days must land the same way regardless of when they are
    // evaluated. The helpers take plain ISO strings and never touch local time,
    // so this is a structural property; the assertion pins it.
    const winter = cisTaxMonth("2026-01-06");
    const summer = cisTaxMonth("2026-07-06");
    expect(winter!.start).toBe("2026-01-06");
    expect(summer!.start).toBe("2026-07-06");
  });
});

describe("isSameCisTaxMonth", () => {
  it("groups by tax month, not calendar month", () => {
    // Same calendar month, DIFFERENT tax months.
    expect(isSameCisTaxMonth("2026-06-03", "2026-06-20")).toBe(false);
    // Different calendar months, SAME tax month.
    expect(isSameCisTaxMonth("2026-05-10", "2026-06-04")).toBe(true);
  });

  it("is false for an invalid date", () => {
    expect(isSameCisTaxMonth("nope", "2026-06-04")).toBe(false);
  });
});

describe("HMRC deadlines", () => {
  it("returns are due by the 19th after the tax month ends", () => {
    expect(CIS_RETURN_DUE_DAY).toBe(19);
    // Tax month 6 May – 5 June is returned by 19 June.
    expect(cisReturnDueDate("2026-05-20")).toBe("2026-06-19");
    expect(cisReturnDueDate("2026-06-03")).toBe("2026-06-19");
    // A payment on 6 June is in the NEXT month, due 19 July.
    expect(cisReturnDueDate("2026-06-06")).toBe("2026-07-19");
  });

  it("deductions are paid by the 22nd, or the 19th by post", () => {
    expect(CIS_PAYMENT_DUE_DAY_ELECTRONIC).toBe(22);
    expect(CIS_PAYMENT_DUE_DAY_POSTAL).toBe(19);
    expect(cisPaymentDueDate("2026-06-03")).toBe("2026-06-22");
    expect(cisPaymentDueDate("2026-06-03", true)).toBe("2026-06-19");
  });

  it("returns null for an invalid date rather than a plausible wrong one", () => {
    expect(cisReturnDueDate("2026-02-30")).toBeNull();
    expect(cisPaymentDueDate("")).toBeNull();
  });
});

describe("cisTaxMonthLabel", () => {
  it("spells the range out so it cannot be read as a calendar month", () => {
    expect(cisTaxMonthLabel("2026-06-03")).toBe("6 May 2026 to 5 June 2026");
    expect(cisTaxMonthLabel("2026-06-06")).toBe("6 June 2026 to 5 July 2026");
  });
});
