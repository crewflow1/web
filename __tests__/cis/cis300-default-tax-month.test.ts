import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cisTaxMonthEnd } from "@/lib/cis/tax-month";

/**
 * D-7: "Prepare CIS300 (latest tax month)" on /tax returned HTTP 500 for every
 * owner. The action defaulted the month with `cisTaxMonthEnd(new Date().toISOString())`,
 * but the helper only accepts a DATE-ONLY string and returns null for a full
 * timestamp — so the action always threw "Could not resolve the CIS tax month."
 */
describe("CIS300 default tax month", () => {
  it("the helper resolves a date-only string for today", () => {
    const end = cisTaxMonthEnd(new Date().toISOString().slice(0, 10));
    expect(end).toMatch(/^\d{4}-\d{2}-05$/);
  });

  it("the helper rejects a full ISO timestamp (the contract the action violated)", () => {
    expect(cisTaxMonthEnd("2026-11-15T10:00:00.000Z")).toBeNull();
  });

  it("the tax action passes a date-only default", () => {
    const src = readFileSync(join(process.cwd(), "app", "(app)", "tax", "actions.ts"), "utf8");
    expect(src).toContain("cisTaxMonthEnd(new Date().toISOString().slice(0, 10))");
    expect(src).not.toMatch(/cisTaxMonthEnd\(new Date\(\)\.toISOString\(\)\)/);
  });
});
