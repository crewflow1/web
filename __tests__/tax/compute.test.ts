import { describe, it, expect } from "vitest";
import {
  computeVatQuarter,
  computePayeMonth,
  computeCorpTaxYear,
  startOfQuarterIso,
  startOfTaxYearIso,
} from "@/lib/tax/compute";

describe("computeVatQuarter", () => {
  const quarterStart = "2026-04-01";

  it("sums output VAT only from paid invoices paid within the quarter", () => {
    const invoices = [
      // Paid in-quarter — counts
      { status: "paid", vat_total: 200, total: 1200, amount: 1000, paid_at: "2026-04-10", created_at: "2026-03-01" },
      // Paid in-quarter, different rate
      { status: "paid", vat_total: 50, total: 250, amount: 200, paid_at: "2026-05-15", created_at: "2026-05-01" },
      // Sent (not paid) — excluded
      { status: "sent", vat_total: 100, total: 600, amount: 500, paid_at: null, created_at: "2026-04-20" },
      // Paid before the quarter — excluded
      { status: "paid", vat_total: 999, total: 5994, amount: 4995, paid_at: "2026-03-31", created_at: "2026-01-01" },
    ];
    const result = computeVatQuarter(invoices, [], quarterStart);
    expect(result.output_vat).toBe(250);
    expect(result.input_vat).toBe(0);
    expect(result.net_payable).toBe(250);
    expect(result.confidence).toBe("computed");
  });

  it("subtracts input VAT from finance rows created within the quarter", () => {
    const finances = [
      { vat_total: 40, amount: 200, created_at: "2026-04-12" }, // in
      { vat_total: 20, amount: 100, created_at: "2026-05-01" }, // in
      { vat_total: 999, amount: 4995, created_at: "2026-03-15" }, // before, excluded
    ];
    const result = computeVatQuarter([], finances, quarterStart);
    expect(result.input_vat).toBe(60);
    expect(result.output_vat).toBe(0);
    expect(result.net_payable).toBe(-60);
  });

  it("handles string-encoded numbers (Supabase numerics arrive as strings)", () => {
    const invoices = [
      { status: "paid", vat_total: "200.50", total: "1200.50", amount: "1000", paid_at: "2026-04-10", created_at: "2026-03-01" },
    ];
    const finances = [
      { vat_total: "40.25", amount: "201.25", created_at: "2026-04-12" },
    ];
    const result = computeVatQuarter(invoices, finances, quarterStart);
    expect(result.output_vat).toBe(200.5);
    expect(result.input_vat).toBe(40.25);
    expect(result.net_payable).toBe(160.25);
  });
});

describe("computePayeMonth", () => {
  it("returns a placeholder until payroll lands", () => {
    const r = computePayeMonth();
    expect(r.estimate).toBe(0);
    expect(r.confidence).toBe("placeholder");
    expect(r.note).toMatch(/payroll/i);
  });

  it("sums PAYE + NI from this month's payroll runs — the computed path the tax page consumes", () => {
    const now = new Date("2026-05-19T00:00:00Z");
    const r = computePayeMonth(
      [
        {
          paye_estimate: 120,
          ni_estimate: 30,
          run: { period_start: "2026-05-01", status: "finalised", cycle: "monthly" },
        },
        {
          paye_estimate: 80,
          ni_estimate: 20,
          run: { period_start: "2026-05-12", status: "draft", cycle: "weekly" },
        },
        {
          // Previous month — excluded from this month's liability.
          paye_estimate: 999,
          ni_estimate: 999,
          run: { period_start: "2026-04-01", status: "finalised", cycle: "monthly" },
        },
      ],
      now,
    );
    expect(r.confidence).toBe("computed");
    expect(r.estimate).toBe(250); // (120 + 30) + (80 + 20)
    expect(r.note).toMatch(/22nd/); // due date the liabilities row surfaces
  });
});

describe("computeCorpTaxYear", () => {
  const yearStart = "2026-04-06"; // UK tax year start

  it("applies the small profits rate (19%) for profits under £50k", () => {
    const invoices = [
      { status: "paid", vat_total: 0, total: 30_000, amount: 30_000, paid_at: "2026-05-01", created_at: "2026-05-01" },
    ];
    const finances = [
      { vat_total: 0, amount: 5_000, created_at: "2026-05-02" },
    ];
    const r = computeCorpTaxYear(invoices, finances, yearStart);
    expect(r.estimated_profit).toBe(25_000);
    expect(r.rate_applied).toBe(19);
    expect(r.estimated_tax).toBe(25_000 * 0.19);
    expect(r.confidence).toBe("computed");
  });

  it("applies the main rate (25%) for profits over £250k", () => {
    const invoices = [
      { status: "paid", vat_total: 0, total: 400_000, amount: 400_000, paid_at: "2026-05-01", created_at: "2026-05-01" },
    ];
    const finances = [
      { vat_total: 0, amount: 50_000, created_at: "2026-05-02" },
    ];
    const r = computeCorpTaxYear(invoices, finances, yearStart);
    expect(r.estimated_profit).toBe(350_000);
    expect(r.rate_applied).toBe(25);
    expect(r.estimated_tax).toBe(350_000 * 0.25);
  });

  it("interpolates linearly between £50k and £250k (marginal approximation)", () => {
    const invoices = [
      { status: "paid", vat_total: 0, total: 150_000, amount: 150_000, paid_at: "2026-05-01", created_at: "2026-05-01" },
    ];
    const r = computeCorpTaxYear(invoices, [], yearStart);
    expect(r.estimated_profit).toBe(150_000);
    // halfway between thresholds → midpoint rate ((19 + 25) / 2 = 22)
    expect(r.rate_applied).toBe(22);
    expect(r.estimated_tax).toBe(150_000 * 0.22);
  });

  it("never produces a negative profit (clamps to 0 when costs exceed revenue)", () => {
    const r = computeCorpTaxYear(
      [{ status: "paid", vat_total: 0, total: 1000, amount: 1000, paid_at: "2026-05-01", created_at: "2026-05-01" }],
      [{ vat_total: 0, amount: 5000, created_at: "2026-05-02" }],
      yearStart,
    );
    expect(r.estimated_profit).toBe(0);
    expect(r.estimated_tax).toBe(0);
  });

  it("excludes rows from before the tax year start", () => {
    const invoices = [
      { status: "paid", vat_total: 0, total: 100_000, amount: 100_000, paid_at: "2026-05-01", created_at: "2026-05-01" },
      // Pre-year, excluded
      { status: "paid", vat_total: 0, total: 999_999, amount: 999_999, paid_at: "2026-03-01", created_at: "2026-03-01" },
    ];
    const r = computeCorpTaxYear(invoices, [], yearStart);
    expect(r.estimated_profit).toBe(100_000);
  });
});

describe("startOfQuarterIso", () => {
  it("returns Apr 1 for any date in Q2 (calendar)", () => {
    expect(startOfQuarterIso(new Date("2026-05-15T12:00:00Z"))).toBe("2026-04-01");
    expect(startOfQuarterIso(new Date("2026-04-01T00:00:00Z"))).toBe("2026-04-01");
    expect(startOfQuarterIso(new Date("2026-06-30T23:59:59Z"))).toBe("2026-04-01");
  });
  it("returns Jan 1 for January", () => {
    expect(startOfQuarterIso(new Date("2026-01-10T00:00:00Z"))).toBe("2026-01-01");
  });
  it("returns Oct 1 for December", () => {
    expect(startOfQuarterIso(new Date("2026-12-31T00:00:00Z"))).toBe("2026-10-01");
  });
});

describe("startOfTaxYearIso", () => {
  it("rolls back to the previous April when current date is before 6 April", () => {
    expect(startOfTaxYearIso(new Date("2026-03-15T00:00:00Z"))).toBe("2025-04-06");
    expect(startOfTaxYearIso(new Date("2026-04-05T00:00:00Z"))).toBe("2025-04-06");
  });
  it("uses the current April when date is on/after 6 April", () => {
    expect(startOfTaxYearIso(new Date("2026-04-06T00:00:00Z"))).toBe("2026-04-06");
    expect(startOfTaxYearIso(new Date("2026-05-20T00:00:00Z"))).toBe("2026-04-06");
  });
});
