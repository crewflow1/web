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

  it("EXCLUDES future-dated paid_at / created_at when given an exclusive upper bound", () => {
    // Quarter = 2026-04-01 .. 2026-07-01 (exclusive). Rows dated in the NEXT
    // quarter must not leak into this one's output/input VAT.
    const quarterEnd = "2026-07-01";
    const invoices = [
      { status: "paid", vat_total: 200, total: 1200, amount: 1000, paid_at: "2026-05-10", created_at: "2026-05-01" }, // in
      { status: "paid", vat_total: 500, total: 3000, amount: 2500, paid_at: "2026-07-01", created_at: "2026-06-20" }, // next quarter (boundary is exclusive) — OUT
      { status: "paid", vat_total: 999, total: 5994, amount: 4995, paid_at: "2026-09-15", created_at: "2026-06-30" }, // future — OUT
    ];
    const finances = [
      { vat_total: 40, amount: 200, created_at: "2026-06-30" }, // in
      { vat_total: 88, amount: 440, created_at: "2026-07-15" }, // next quarter — OUT
    ];
    const result = computeVatQuarter(invoices, finances, quarterStart, quarterEnd);
    expect(result.output_vat).toBe(200); // future-dated 500 + 999 excluded
    expect(result.input_vat).toBe(40); // future-dated 88 excluded
    expect(result.net_payable).toBe(160);
  });

  it("without an upper bound, keeps the historical open-ended behaviour (leak reproduced)", () => {
    // This is the pre-fix behaviour the cash-out consumer still relies on: with no
    // upper bound a future-dated payment DOES flow in. The dashboard tile and PDF
    // now always pass the bound, so this path is only the documented default.
    const invoices = [
      { status: "paid", vat_total: 200, total: 1200, amount: 1000, paid_at: "2026-05-10", created_at: "2026-05-01" },
      { status: "paid", vat_total: 500, total: 3000, amount: 2500, paid_at: "2026-09-15", created_at: "2026-06-20" },
    ];
    const unbounded = computeVatQuarter(invoices, [], quarterStart);
    expect(unbounded.output_vat).toBe(700); // 200 + the future-dated 500 leaks in
    const bounded = computeVatQuarter(invoices, [], quarterStart, "2026-07-01");
    expect(bounded.output_vat).toBe(200);
  });

  it("is the single VAT authority the quarterly PDF reuses — same rows, same totals", () => {
    // The PDF route maps DB rows into computeVatQuarter's shape and reads
    // output_vat/input_vat/net_payable straight off it. We prove that reading the
    // authority equals summing the SAME period-bounded rows the PDF renders, so
    // the working paper's totals can never drift from the tile or the 9-box.
    const quarterEnd = "2026-07-01";
    const invoices = [
      { status: "paid", vat_total: 600, total: 3600, amount: 3000, paid_at: "2026-04-10", created_at: "2026-04-01" },
      { status: "paid", vat_total: 400, total: 2400, amount: 2000, paid_at: "2026-06-30", created_at: "2026-06-20" },
      { status: "paid", vat_total: 999, total: 5994, amount: 4995, paid_at: "2026-08-01", created_at: "2026-06-30" }, // future — must not count
    ];
    const finances = [
      { vat_total: 150, amount: 750, created_at: "2026-05-05" },
      { vat_total: 50, amount: 250, created_at: "2026-06-15" },
    ];
    const authority = computeVatQuarter(invoices, finances, quarterStart, quarterEnd);
    // The rows the PDF actually renders (already period-bounded by the DB query):
    const pdfPaidVat = invoices
      .filter((i) => i.status === "paid" && i.paid_at >= quarterStart && i.paid_at < quarterEnd)
      .reduce((s, r) => s + r.vat_total, 0);
    const pdfInputVat = finances
      .filter((f) => f.created_at >= quarterStart && f.created_at < quarterEnd)
      .reduce((s, r) => s + r.vat_total, 0);
    expect(authority.output_vat).toBe(pdfPaidVat); // 1000
    expect(authority.input_vat).toBe(pdfInputVat); // 200
    expect(authority.output_vat).toBe(1000);
    expect(authority.input_vat).toBe(200);
    expect(authority.net_payable).toBe(800);
  });
});

describe("computePayeMonth", () => {
  it("returns a placeholder until payroll lands", () => {
    const r = computePayeMonth();
    expect(r.estimate).toBe(0);
    expect(r.confidence).toBe("placeholder");
    expect(r.note).toMatch(/payroll/i);
  });

  it("sums PAYE + employee NI + EMPLOYER NI from this month's payroll runs — the computed path the tax page consumes", () => {
    const now = new Date("2026-05-19T00:00:00Z");
    const r = computePayeMonth(
      [
        {
          paye_estimate: 120,
          ni_estimate: 30,
          gross_pay: 3_000,
          run: { period_start: "2026-05-01", status: "finalised", cycle: "monthly" },
        },
        {
          paye_estimate: 80,
          ni_estimate: 20,
          gross_pay: 600,
          run: { period_start: "2026-05-12", status: "draft", cycle: "weekly" },
        },
        {
          // Previous month — excluded from this month's liability, gross and all.
          paye_estimate: 999,
          ni_estimate: 999,
          gross_pay: 99_999,
          run: { period_start: "2026-04-01", status: "finalised", cycle: "monthly" },
        },
      ],
      now,
    );
    expect(r.confidence).toBe("computed");
    expect(r.paye_estimate).toBe(200); // 120 + 80
    expect(r.employee_ni_estimate).toBe(50); // 30 + 20
    // Employer NI, 2026-27 rates (15% above a £5,000 secondary threshold):
    //   monthly £3,000  → annualised 36,000 → (36,000 − 5,000) × 15% = 4,650 /12 = 387.50
    //   weekly  £600    → annualised 31,200 → (31,200 − 5,000) × 15% = 3,930 /52 =  75.58
    expect(r.employer_ni_estimate).toBe(463.08);
    // The HMRC bill is PAYE + employee NI + employer NI.
    expect(r.estimate).toBe(713.08);
    expect(r.note).toMatch(/22nd/); // due date the liabilities row surfaces
    expect(r.note).toMatch(/employer NI/);
    // It is an ESTIMATE, and the Employment Allowance caveat must travel with it.
    expect(r.note).toMatch(/Estimate/);
    expect(r.note).toMatch(/Employment Allowance/);
  });

  it("EXCLUDES employer pension from the HMRC liability (it is paid to the provider, not HMRC)", () => {
    const now = new Date("2026-05-19T00:00:00Z");
    const r = computePayeMonth(
      [
        {
          paye_estimate: 0,
          ni_estimate: 0,
          gross_pay: 3_000,
          run: { period_start: "2026-05-01", status: "finalised", cycle: "monthly" },
        },
      ],
      now,
    );
    // Employer pension on this gross is 3% × (36,000 − 6,240) / 12 = £74.40. If it
    // had leaked into the HMRC figure the estimate would be 461.90, not 387.50.
    expect(r.employer_ni_estimate).toBe(387.5);
    expect(r.estimate).toBe(387.5);
  });

  it("prices each run at the rates in force for ITS OWN period, not today's", () => {
    // A 2024-25 period (13.8% above £9,100) must not be re-priced at 2026-27 rates
    // (15% above £5,000) just because it is being read now.
    const r = computePayeMonth(
      [
        {
          paye_estimate: 0,
          ni_estimate: 0,
          gross_pay: 3_000,
          run: { period_start: "2024-06-01", status: "finalised", cycle: "monthly" },
        },
      ],
      new Date("2024-06-15T00:00:00Z"),
    );
    // (36,000 − 9,100) × 13.8% = 3,712.20 / 12 = £309.35 — the 2024-25 answer.
    expect(r.employer_ni_estimate).toBe(309.35);
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

  it("applies HMRC marginal relief between £50k and £250k (3/200 fraction)", () => {
    const invoices = [
      { status: "paid", vat_total: 0, total: 150_000, amount: 150_000, paid_at: "2026-05-01", created_at: "2026-05-01" },
    ];
    const r = computeCorpTaxYear(invoices, [], yearStart);
    expect(r.estimated_profit).toBe(150_000);
    // HMRC formula: 150,000×25% − (250,000 − 150,000)×3/200
    //             = 37,500 − 1,500 = £36,000  (NOT the old linear £33,000).
    // Effective rate 36,000 / 150,000 = 24.00%.
    expect(r.estimated_tax).toBe(36_000);
    expect(r.rate_applied).toBe(24);
  });

  it("marginal relief is continuous at the £50k lower boundary (= flat 19%)", () => {
    const r = computeCorpTaxYear(
      [{ status: "paid", vat_total: 0, total: 50_000, amount: 50_000, paid_at: "2026-05-01", created_at: "2026-05-01" }],
      [],
      yearStart,
    );
    expect(r.estimated_profit).toBe(50_000);
    // 50,000×25% − (250,000 − 50,000)×3/200 = 12,500 − 3,000 = 9,500 = 50,000×19%.
    expect(r.estimated_tax).toBe(9_500);
    expect(r.rate_applied).toBe(19);
  });

  it("marginal relief is continuous at the £250k upper boundary (= flat 25%)", () => {
    // £249,999 sits inside the marginal band; relief is a rounding-negligible £0.02
    // below the £62,500 that £250,000 pays flat, so the effective rate is ~25%.
    const r = computeCorpTaxYear(
      [{ status: "paid", vat_total: 0, total: 250_000, amount: 250_000, paid_at: "2026-05-01", created_at: "2026-05-01" }],
      [],
      yearStart,
    );
    expect(r.estimated_profit).toBe(250_000);
    // At exactly £250k relief is nil: 250,000×25% − 0 = £62,500.
    expect(r.estimated_tax).toBe(62_500);
    expect(r.rate_applied).toBe(25);
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

  it("EXCLUDES draft (never-issued) invoices from revenue — the launch-blocking fix", () => {
    // `draft` is the schema/new-invoice default: every invoice is a draft carrying
    // real line amounts before it is sent. Counting it as revenue overstated profit
    // and the CT estimate for essentially every org, contradicting the accrual basis.
    const r = computeCorpTaxYear(
      [{ status: "draft", vat_total: 0, total: 30_000, amount: 30_000, paid_at: null, created_at: "2026-05-01" }],
      [],
      yearStart,
    );
    expect(r.estimated_profit).toBe(0);
    expect(r.estimated_tax).toBe(0);
  });

  it("COUNTS issued invoices (sent, paid) of the same amount that a draft does not", () => {
    // A £30k draft contributes £0 (above); a £30k `sent` and a £30k `paid` each
    // contribute in full, on the accrual basis, regardless of payment.
    const sent = computeCorpTaxYear(
      [{ status: "sent", vat_total: 0, total: 30_000, amount: 30_000, paid_at: null, created_at: "2026-05-01" }],
      [],
      yearStart,
    );
    expect(sent.estimated_profit).toBe(30_000);
    expect(sent.estimated_tax).toBe(30_000 * 0.19);

    const paid = computeCorpTaxYear(
      [{ status: "paid", vat_total: 0, total: 30_000, amount: 30_000, paid_at: "2026-05-10", created_at: "2026-05-01" }],
      [],
      yearStart,
    );
    expect(paid.estimated_profit).toBe(30_000);
    expect(paid.estimated_tax).toBe(30_000 * 0.19);
  });

  it("counts all issued statuses but never draft in a mixed set", () => {
    // Issued: sent + awaiting_payment + partially_paid + paid + legacy overdue =
    // 5 × £10k = £50k. The two £10k drafts are excluded. Costs £0 ⇒ profit £50k.
    const invoices = [
      { status: "sent", vat_total: 0, total: 10_000, amount: 10_000, paid_at: null, created_at: "2026-05-01" },
      { status: "awaiting_payment", vat_total: 0, total: 10_000, amount: 10_000, paid_at: null, created_at: "2026-05-02" },
      { status: "partially_paid", vat_total: 0, total: 10_000, amount: 10_000, paid_at: null, created_at: "2026-05-03" },
      { status: "paid", vat_total: 0, total: 10_000, amount: 10_000, paid_at: "2026-05-05", created_at: "2026-05-04" },
      { status: "overdue", vat_total: 0, total: 10_000, amount: 10_000, paid_at: null, created_at: "2026-05-06" },
      { status: "draft", vat_total: 0, total: 10_000, amount: 10_000, paid_at: null, created_at: "2026-05-07" },
      { status: "draft", vat_total: 0, total: 10_000, amount: 10_000, paid_at: null, created_at: "2026-05-08" },
    ];
    const r = computeCorpTaxYear(invoices, [], yearStart);
    expect(r.estimated_profit).toBe(50_000);
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
