import { describe, it, expect, vi, afterEach } from "vitest";
import { invoiceDueDate, INVOICE_DUE_DAYS } from "@/lib/invoices/due-date";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Regression test for BUG-03 (auto-generated invoice due date missing).
 *
 * Auto-created invoices (quote acceptance, owner or public portal) used to be
 * inserted with no due_date, so the customer saw a blank payment deadline.
 * `invoiceDueDate` supplies a sensible net-14 default.
 */
describe("invoiceDueDate", () => {
  it("defaults to net-14", () => {
    expect(INVOICE_DUE_DAYS).toBe(14);
  });

  it("adds 14 days and returns a YYYY-MM-DD calendar date", () => {
    // 2026-05-31 + 14 days = 2026-06-14 (crosses the month boundary).
    expect(invoiceDueDate("2026-05-31T00:00:00.000Z")).toBe("2026-06-14");
  });

  it("crosses a year boundary correctly", () => {
    // 2026-12-25 + 14 days = 2027-01-08.
    expect(invoiceDueDate("2026-12-25T12:00:00.000Z")).toBe("2027-01-08");
  });

  it("honours a custom day count", () => {
    expect(invoiceDueDate("2026-05-31T00:00:00.000Z", 30)).toBe("2026-06-30");
    expect(invoiceDueDate("2026-05-31T00:00:00.000Z", 0)).toBe("2026-05-31");
  });

  it("always emits a date-only string (no time component)", () => {
    expect(invoiceDueDate("2026-05-31T23:59:59.999Z")).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("falls back to a valid date when the input cannot be parsed", () => {
    // Pin the clock: the fallback anchors on `new Date()` INSIDE the lib, and
    // the expected value below also reads the clock. Without a fixed `now`,
    // the two reads can straddle a UTC-midnight tick and the date-only strings
    // disagree by a day — a genuine (if rare) wall-clock flake. Freezing it
    // makes the exact-date assertion deterministic in any CI timezone.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T23:59:59.999Z"));

    const result = invoiceDueDate("not-a-real-date");
    // Defensive fallback: never emit NaN/Invalid Date into a `date` column.
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).not.toContain("NaN");

    // The fallback anchors on "now" (+14 days), in UTC: 2026-05-31 → 2026-06-14.
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() + INVOICE_DUE_DAYS);
    expect(result).toBe(expected.toISOString().slice(0, 10));
    expect(result).toBe("2026-06-14");
  });
});
