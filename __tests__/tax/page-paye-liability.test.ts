import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Tax dashboard — PAYE / NI completion (source-pinned).
 *
 * `computePayeMonth` (`@/lib/tax/compute`) already sums the real PAYE + NI
 * from this month's payroll runs, and the page computes `paye` from it —
 * the PAYE tile has always rendered that estimate. But two spots on the
 * page used to contradict it with hardcoded stubs: the tile subtitle read
 * "awaiting upstream data" unconditionally, and the "Upcoming liabilities"
 * PAYE row was pinned to "—" / "Available once payroll lands (Wave 4)".
 *
 * This increment CONSUMES the already-computed result in both places, with
 * graceful degradation to the placeholder affordance when no payroll has
 * run this month. No new computation lives in the page — the deterministic
 * `computePayeMonth` stays the single source of truth. These assertions run
 * against the page source (the page is an async server component that hits
 * Supabase, so it isn't unit-rendered here); the numeric contract they lean
 * on is exercised in __tests__/tax/compute.test.ts.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const PAGE = "app/(app)/tax/page.tsx";

describe("tax dashboard PAYE/NI completion (consumes computePayeMonth)", () => {
  it("drops the stale 'Wave 4' liability stub and the unconditional 'awaiting upstream data' subtitle", () => {
    const code = read(PAGE);
    expect(code).not.toMatch(/Available once payroll lands \(Wave 4\)/);
    expect(code).not.toMatch(/awaiting upstream data/);
  });

  it("feeds the computed PAYE estimate into the Upcoming liabilities row with graceful degradation", () => {
    const code = read(PAGE);
    // Amount + due date are now driven by the computed confidence flag...
    expect(code).toMatch(/paye\.confidence === "computed"/);
    expect(code).toMatch(/GBP\.format\(paye\.estimate\)/);
    // ...and still fall back to the em-dash placeholder when no payroll ran.
    expect(code).toMatch(/"—"/);
  });

  it("reuses the deterministic computePayeMonth and never re-derives PAYE/NI in the page", () => {
    const code = read(PAGE);
    expect(code).toMatch(/computePayeMonth\(/);
    // The page must not reimplement any PAYE/NI banding of its own.
    expect(code).not.toMatch(/annualEmployeeNi|NI_MAIN_RATE|0\.08/);
  });
});
