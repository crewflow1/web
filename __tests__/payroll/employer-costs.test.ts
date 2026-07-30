import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  annualEmployerNi,
  annualEmployerPension,
  computePayrollLine,
  employerCostsForStoredLine,
  employerOnCostsFromTimeEntries,
  payrollCsv,
} from "@/lib/payroll/compute";
import {
  LATEST_PUBLISHED_TAX_YEAR,
  NOT_MODELLED,
  PUBLISHED_TAX_YEARS,
  resolveEmploymentCostRates,
  taxYearForDate,
} from "@/lib/payroll/rates";
import {
  computeJobProfitability,
  labourCostsFromTimeEntries,
  mapToCostBucket,
} from "@/lib/profitability/compute";

/**
 * Employer NI + employer pension — the cost-of-employment fix.
 *
 * THE DEFECT: payroll computed gross, PAYE and employee NI but no EMPLOYER costs.
 * Employer secondary Class 1 NI and the auto-enrolment employer pension are real
 * costs of employing someone, and they were missing from the `labour` cost bucket —
 * so gross profit and margin were OVERSTATED on every job with direct labour.
 *
 * Every figure below is checked to the penny against a hand-worked example. Rates
 * are the dated tables in `lib/payroll/rates.ts`, sourced in
 * `docs/payroll-employer-costs.md`.
 */

const RATES_2026_27 = resolveEmploymentCostRates("2026-06-01").rates;
const RATES_2024_25 = resolveEmploymentCostRates("2024-06-01").rates;

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/**
 * Strip comments and JSX comment blocks so a source-pinned assertion tests CODE
 * rather than prose. Without this, a docblock that *explains* the 13.8% → 15% step
 * change would trip a "no hardcoded rate" check — the comment is the documentation
 * the house rules demand, not a duplicated rate.
 */
const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// The dated rate table
// ---------------------------------------------------------------------------

describe("taxYearForDate", () => {
  it("splits on 6 April, not 1 January or 1 April", () => {
    expect(taxYearForDate("2026-04-05")).toBe("2025-26"); // last day of 2025-26
    expect(taxYearForDate("2026-04-06")).toBe("2026-27"); // first day of 2026-27
    expect(taxYearForDate("2026-01-31")).toBe("2025-26");
    expect(taxYearForDate("2026-12-31")).toBe("2026-27");
  });

  it("accepts a full ISO timestamp, and parses by string so no timezone can shift the boundary", () => {
    expect(taxYearForDate("2026-04-06T00:00:00Z")).toBe("2026-27");
    expect(taxYearForDate("2026-04-05T23:59:59Z")).toBe("2025-26");
  });
});

describe("rate table resolution", () => {
  it("resolves each published year exactly, with no extrapolation flag", () => {
    for (const ty of PUBLISHED_TAX_YEARS) {
      const startYear = Number(ty.slice(0, 4));
      const r = resolveEmploymentCostRates(`${startYear}-06-01`);
      expect(r.applied_tax_year).toBe(ty);
      expect(r.requested_tax_year).toBe(ty);
      expect(r.extrapolated).toBe(false);
      expect(r.rates.tax_year).toBe(ty);
    }
  });

  it("pins the 6 April 2025 STEP CHANGE — the reason these rates are a dated table", () => {
    // 2024-25: 13.8% above £9,100. 2025-26 onward: 15% above £5,000.
    expect(RATES_2024_25.employer_ni.rate).toBe(0.138);
    expect(RATES_2024_25.employer_ni.secondary_threshold_annual).toBe(9_100);
    expect(RATES_2026_27.employer_ni.rate).toBe(0.15);
    expect(RATES_2026_27.employer_ni.secondary_threshold_annual).toBe(5_000);
  });

  it("FLAGS a future tax year as extrapolated rather than silently applying stale rates", () => {
    const r = resolveEmploymentCostRates("2099-06-01");
    expect(r.requested_tax_year).toBe("2099-00");
    expect(r.applied_tax_year).toBe(LATEST_PUBLISHED_TAX_YEAR);
    // The whole point: staleness is VISIBLE, and payroll still works.
    expect(r.extrapolated).toBe(true);
  });

  it("clamps a pre-history date to the earliest published table, also flagged", () => {
    const r = resolveEmploymentCostRates("1999-06-01");
    expect(r.applied_tax_year).toBe(PUBLISHED_TAX_YEARS[0]);
    expect(r.extrapolated).toBe(true);
  });

  it("holds the auto-enrolment band and trigger frozen across every published year", () => {
    for (const ty of PUBLISHED_TAX_YEARS) {
      const startYear = Number(ty.slice(0, 4));
      const p = resolveEmploymentCostRates(`${startYear}-06-01`).rates.employer_pension;
      expect(p.minimum_employer_rate).toBe(0.03);
      expect(p.qualifying_earnings_lower_annual).toBe(6_240);
      expect(p.qualifying_earnings_upper_annual).toBe(50_270);
      expect(p.earnings_trigger_annual).toBe(10_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Employer NI — to the penny
// ---------------------------------------------------------------------------

describe("annualEmployerNi", () => {
  it("is nil AT the secondary threshold and charges only the excess above it", () => {
    expect(annualEmployerNi(5_000, RATES_2026_27.employer_ni)).toBe(0);
    expect(annualEmployerNi(0, RATES_2026_27.employer_ni)).toBe(0);
    // £1 above the threshold → 15p.
    expect(annualEmployerNi(5_001, RATES_2026_27.employer_ni)).toBeCloseTo(0.15, 10);
  });

  it("£38,400 a year → £5,010 (2026-27)", () => {
    // (38,400 − 5,000) × 15% = 33,400 × 0.15 = 5,010
    expect(annualEmployerNi(38_400, RATES_2026_27.employer_ni)).toBeCloseTo(5_010, 2);
  });

  it("has NO upper limit — unlike employee NI it does not taper to 2%", () => {
    // (200,000 − 5,000) × 15% = 29,250. A capped rate would give far less.
    expect(annualEmployerNi(200_000, RATES_2026_27.employer_ni)).toBeCloseTo(29_250, 2);
  });

  it("uses the 2024-25 regime for a 2024-25 period", () => {
    // (36,000 − 9,100) × 13.8% = 26,900 × 0.138 = 3,712.20
    expect(annualEmployerNi(36_000, RATES_2024_25.employer_ni)).toBeCloseTo(3_712.2, 2);
  });
});

// ---------------------------------------------------------------------------
// Employer pension — to the penny
// ---------------------------------------------------------------------------

describe("annualEmployerPension", () => {
  it("charges 3% of QUALIFYING EARNINGS, not 3% of full pay", () => {
    // 3% × (38,400 − 6,240) = 3% × 32,160 = 964.80
    expect(annualEmployerPension(38_400, RATES_2026_27.employer_pension)).toBeCloseTo(
      964.8,
      2,
    );
    // 3% of FULL pay would be £1,152 — materially more. Pin the difference.
    expect(annualEmployerPension(38_400, RATES_2026_27.employer_pension)).not.toBeCloseTo(
      1_152,
      2,
    );
  });

  it("caps at the upper limit of the qualifying earnings band", () => {
    // 3% × (50,270 − 6,240) = 3% × 44,030 = 1,320.90 — and stays there.
    expect(annualEmployerPension(60_000, RATES_2026_27.employer_pension)).toBeCloseTo(
      1_320.9,
      2,
    );
    expect(annualEmployerPension(250_000, RATES_2026_27.employer_pension)).toBeCloseTo(
      1_320.9,
      2,
    );
  });

  it("charges nothing below the £10,000 automatic-enrolment earnings trigger", () => {
    // £9,999 is ABOVE the £6,240 band floor but BELOW the trigger, so there is no
    // enrolment duty. The trigger governs, not the band.
    expect(annualEmployerPension(9_999, RATES_2026_27.employer_pension)).toBe(0);
    // At the trigger: 3% × (10,000 − 6,240) = 3% × 3,760 = 112.80
    expect(annualEmployerPension(10_000, RATES_2026_27.employer_pension)).toBeCloseTo(
      112.8,
      2,
    );
  });
});

// ---------------------------------------------------------------------------
// The payroll line
// ---------------------------------------------------------------------------

describe("computePayrollLine — employer costs", () => {
  it("monthly 160h × £20: employer NI £417.50, pension £80.40, total cost £3,697.90", () => {
    const r = computePayrollLine(160, 20, "monthly", "2026-06-01");
    expect(r.gross_pay).toBe(3_200);
    // Annualised 38,400.
    //   employer NI      (38,400 − 5,000) × 15%  = 5,010.00 / 12 = 417.50
    //   employer pension 3% × (38,400 − 6,240)   =   964.80 / 12 =  80.40
    expect(r.employer_ni_estimate).toBe(417.5);
    expect(r.employer_pension_estimate).toBe(80.4);
    expect(r.employment_cost_estimate).toBe(3_697.9);
    expect(r.employer_rates_tax_year).toBe("2026-27");
    expect(r.employer_rates_extrapolated).toBe(false);
  });

  it("weekly 40h × £15: employer NI £75.58, pension £14.40", () => {
    const r = computePayrollLine(40, 15, "weekly", "2026-06-01");
    expect(r.gross_pay).toBe(600);
    // Annualised 31,200.
    //   employer NI      (31,200 − 5,000) × 15% = 3,930.00 / 52 = 75.5769… → 75.58
    //   employer pension 3% × (31,200 − 6,240)  =   748.80 / 52 = 14.40
    expect(r.employer_ni_estimate).toBe(75.58);
    expect(r.employer_pension_estimate).toBe(14.4);
    expect(r.employment_cost_estimate).toBe(689.98);
  });

  it("charges employer NI but NO pension when annualised pay is under the trigger", () => {
    // Monthly £600 → annualised £7,200: over the £5,000 NI threshold, under the
    // £10,000 pension trigger.
    const r = computePayrollLine(60, 10, "monthly", "2026-06-01");
    expect(r.gross_pay).toBe(600);
    // (7,200 − 5,000) × 15% = 330.00 / 12 = 27.50
    expect(r.employer_ni_estimate).toBe(27.5);
    expect(r.employer_pension_estimate).toBe(0);
    expect(r.employment_cost_estimate).toBe(627.5);
  });

  it("zero hours → zero employer cost (no phantom NI on nobody)", () => {
    const r = computePayrollLine(0, 20, "weekly", "2026-06-01");
    expect(r.employer_ni_estimate).toBe(0);
    expect(r.employer_pension_estimate).toBe(0);
    expect(r.employment_cost_estimate).toBe(0);
  });

  it("prices a 2024-25 period at 2024-25 rates — a finalised run never re-prices", () => {
    const r = computePayrollLine(160, 18.75, "monthly", "2024-06-01");
    expect(r.gross_pay).toBe(3_000); // annualised 36,000
    // (36,000 − 9,100) × 13.8% = 3,712.20 / 12 = 309.35
    expect(r.employer_ni_estimate).toBe(309.35);
    expect(r.employer_rates_tax_year).toBe("2024-25");
    // The same gross in 2026-27 costs MORE — proof the date, not "today", decides.
    const now = computePayrollLine(160, 18.75, "monthly", "2026-06-01");
    expect(now.employer_ni_estimate).toBe(387.5);
    expect(now.employer_ni_estimate).toBeGreaterThan(r.employer_ni_estimate);
  });
});

// ---------------------------------------------------------------------------
// EMPLOYER COST IS NOT AN EMPLOYEE DEDUCTION
// ---------------------------------------------------------------------------

describe("net pay is untouched by employer costs (regression)", () => {
  it("net_pay is gross − PAYE − EMPLOYEE NI, and nothing else", () => {
    const r = computePayrollLine(40, 15, "weekly", "2026-06-01");
    // 600 − 71.65 − 28.66 = 499.69. Employer NI (75.58) and pension (14.40) are
    // NOT deducted — deducting an employer cost from wages would be unlawful.
    expect(r.net_pay).toBe(499.69);
    expect(r.net_pay).toBe(
      Math.round((r.gross_pay - r.paye_estimate - r.ni_estimate) * 100) / 100,
    );
  });

  it("holds across cycles and pay levels", () => {
    for (const [hours, rate, cycle] of [
      [40, 15, "weekly"],
      [160, 20, "monthly"],
      [10, 12, "weekly"],
      [160, 60, "monthly"],
    ] as const) {
      const r = computePayrollLine(hours, rate, cycle, "2026-06-01");
      expect(r.net_pay).toBeCloseTo(
        r.gross_pay - r.paye_estimate - r.ni_estimate,
        2,
      );
      // Employment cost sits ABOVE gross, never below net.
      expect(r.employment_cost_estimate).toBeGreaterThanOrEqual(r.gross_pay);
    }
  });

  it("the worker's own view (/me) reads only employee-side fields", () => {
    const code = read("app/(app)/me/page.tsx");
    expect(code).not.toMatch(
      /employer_ni_estimate|employer_pension_estimate|employment_cost_estimate/,
    );
  });

  it("the PAYSLIP carries no employer cost — it is the worker's document, not a cost report", () => {
    // A payslip showing employer NI invites the reading that it was deducted.
    for (const f of ["lib/pdf/payslip-pdf.tsx", "app/api/payroll/lines/[id]/pdf/route.ts"]) {
      const code = read(f);
      expect(code, `${f} must not surface employer cost`).not.toMatch(
        /employer_ni|employer_pension|employment_cost/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Derivation from a stored line
// ---------------------------------------------------------------------------

describe("employerCostsForStoredLine", () => {
  it("reproduces the computed line exactly from the stored gross", () => {
    const computed = computePayrollLine(160, 20, "monthly", "2026-06-01");
    const derived = employerCostsForStoredLine(
      computed.gross_pay,
      "monthly",
      "2026-06-01",
    );
    expect(derived.employer_ni_estimate).toBe(computed.employer_ni_estimate);
    expect(derived.employer_pension_estimate).toBe(computed.employer_pension_estimate);
    expect(derived.employment_cost_estimate).toBe(computed.employment_cost_estimate);
    expect(derived.employer_rates_tax_year).toBe(computed.employer_rates_tax_year);
  });

  it("handles Supabase's string-encoded numerics and null", () => {
    expect(
      employerCostsForStoredLine("3200.00", "monthly", "2026-06-01")
        .employer_ni_estimate,
    ).toBe(417.5);
    expect(
      employerCostsForStoredLine(null, "monthly", "2026-06-01").employer_ni_estimate,
    ).toBe(0);
    expect(
      employerCostsForStoredLine(undefined, "monthly", "2026-06-01")
        .employment_cost_estimate,
    ).toBe(0);
  });

  it("never returns a negative cost from corrupt input", () => {
    const r = employerCostsForStoredLine(-5_000, "monthly", "2026-06-01");
    expect(r.employer_ni_estimate).toBe(0);
    expect(r.employer_pension_estimate).toBe(0);
    expect(r.employment_cost_estimate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Job costing — banding on the PERSON, apportioned across jobs
// ---------------------------------------------------------------------------

describe("employerOnCostsFromTimeEntries", () => {
  const rates = new Map([["u1", 20]]);

  it("bands on the worker's TOTAL hours, then apportions penny-exactly by job", () => {
    const rows = employerOnCostsFromTimeEntries(
      [
        { job_id: "jobA", user_id: "u1", hours: 100 },
        { job_id: "jobB", user_id: "u1", hours: 60 },
      ],
      rates,
      "monthly",
      "2026-06-01",
    );
    // 160h × £20 = £3,200 ⇒ on-cost £417.50 + £80.40 = £497.90, split 100:60.
    //   £497.90 × 100/160 = £311.1875 → £311.19 (gets the odd penny)
    //   £497.90 ×  60/160 = £186.7125 → £186.71
    const byJob = new Map(rows.map((r) => [r.job_id, r.amount]));
    expect(byJob.get("jobA")).toBe(311.19);
    expect(byJob.get("jobB")).toBe(186.71);
    // Penny-exact: the parts sum to the on-cost, with nothing lost or invented.
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(497.9, 10);
  });

  it("every row is tagged `labour`, so mapToCostBucket files it under labour", () => {
    const rows = employerOnCostsFromTimeEntries(
      [{ job_id: "jobA", user_id: "u1", hours: 160 }],
      rates,
      "monthly",
      "2026-06-01",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.category).toBe("labour");
      expect(mapToCostBucket(r.category)).toBe("labour");
    }
  });

  it("COUNTERFACTUAL: per-job banding would understate the on-cost by £78.10", () => {
    // The correct answer bands once on 160h.
    const correct = employerOnCostsFromTimeEntries(
      [
        { job_id: "jobA", user_id: "u1", hours: 100 },
        { job_id: "jobB", user_id: "u1", hours: 60 },
      ],
      rates,
      "monthly",
      "2026-06-01",
    ).reduce((s, r) => s + r.amount, 0);

    // The naive alternative bands each job separately, handing job B its own
    // £5,000 NI threshold AND its own £6,240 pension floor.
    const perJob = [100, 60]
      .map((h) => computePayrollLine(h, 20, "monthly", "2026-06-01"))
      .reduce(
        (s, c) => s + c.employer_ni_estimate + c.employer_pension_estimate,
        0,
      );

    expect(correct).toBeCloseTo(497.9, 2);
    expect(perJob).toBeCloseTo(419.8, 2);
    // The gap is exactly one extra nil-band: 15% × £5,000 + 3% × £6,240, monthly.
    expect(correct - perJob).toBeCloseTo(78.1, 2);
    expect(correct - perJob).toBeCloseTo((5_000 * 0.15 + 6_240 * 0.03) / 12, 2);
  });

  it("counts un-jobbed hours toward the band but charges them to no job", () => {
    const rows = employerOnCostsFromTimeEntries(
      [
        { job_id: "jobA", user_id: "u1", hours: 80 },
        { job_id: null, user_id: "u1", hours: 80 }, // overhead, not direct cost
      ],
      rates,
      "monthly",
      "2026-06-01",
    );
    // Banded on all 160h (£497.90) but only half is attributable to jobA.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.job_id).toBe("jobA");
    expect(rows[0]!.amount).toBe(248.95);
  });

  it("skips workers with no hourly rate, and emits nothing when no job is attributable", () => {
    expect(
      employerOnCostsFromTimeEntries(
        [{ job_id: "jobA", user_id: "unknown", hours: 100 }],
        rates,
        "monthly",
        "2026-06-01",
      ),
    ).toEqual([]);
    expect(
      employerOnCostsFromTimeEntries(
        [{ job_id: null, user_id: "u1", hours: 100 }],
        rates,
        "monthly",
        "2026-06-01",
      ),
    ).toEqual([]);
  });

  it("ignores zero, negative and non-finite hours", () => {
    expect(
      employerOnCostsFromTimeEntries(
        [
          { job_id: "jobA", user_id: "u1", hours: 0 },
          { job_id: "jobA", user_id: "u1", hours: -50 },
          { job_id: "jobA", user_id: "u1", hours: Number.NaN },
        ],
        rates,
        "monthly",
        "2026-06-01",
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE MARGIN IMPACT — the defect, measured
// ---------------------------------------------------------------------------

describe("job margin: before vs after the employer-cost fix", () => {
  const JOB = "job-1";
  const revenue = [{ job_id: JOB, amount: 5_000 }];
  const slices = [{ job_id: JOB, user_id: "u1", hours: 160 }];
  const rates = new Map([["u1", 20]]);

  it("a 36% 'green' job is really a 26% 'amber' job once employer costs are counted", () => {
    const labour = labourCostsFromTimeEntries(slices, rates);
    const onCosts = employerOnCostsFromTimeEntries(
      slices,
      rates,
      "monthly",
      "2026-06-01",
    );

    // BEFORE — gross pay only (the defect).
    const before = computeJobProfitability(JOB, revenue, labour);
    expect(before?.costs_by_bucket.labour).toBe(3_200);
    expect(before?.gross_profit).toBe(1_800);
    expect(before?.margin_pct).toBe(36);
    expect(before?.band).toBe("green");

    // AFTER — the true cost of employment.
    const after = computeJobProfitability(JOB, revenue, [...labour, ...onCosts]);
    expect(after?.costs_by_bucket.labour).toBeCloseTo(3_697.9, 2);
    expect(after?.gross_profit).toBeCloseTo(1_302.1, 2);
    expect(after?.margin_pct).toBe(26);
    // The band flips: this job was being reported as healthy when it is not.
    expect(after?.band).toBe("amber");

    // The overstatement: £497.90 of profit and 10 percentage points of margin.
    expect((before?.gross_profit ?? 0) - (after?.gross_profit ?? 0)).toBeCloseTo(
      497.9,
      2,
    );
    expect((before?.margin_pct ?? 0) - (after?.margin_pct ?? 0)).toBe(10);
  });

  it("the on-cost lands in the LABOUR bucket, never materials/subcontractors/misc", () => {
    const onCosts = employerOnCostsFromTimeEntries(
      slices,
      rates,
      "monthly",
      "2026-06-01",
    );
    const p = computeJobProfitability(JOB, revenue, onCosts);
    expect(p?.costs_by_bucket.labour).toBeCloseTo(497.9, 2);
    expect(p?.costs_by_bucket.materials).toBe(0);
    expect(p?.costs_by_bucket.subcontractors).toBe(0);
    expect(p?.costs_by_bucket.misc).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CIS subcontractors are NOT employees
// ---------------------------------------------------------------------------

describe("CIS subcontractors attract NO employer NI and NO pension", () => {
  it("STRUCTURAL: employer on-costs need a membership hourly rate, which a CIS subcontractor can never have", () => {
    // `cis_subcontractors` is keyed on (org_id, SUPPLIER_id) — there is no user_id
    // on it at all. A CIS subcontractor is therefore not a member, has no
    // `users.hourly_pay`, and logs no time_entries. Feeding a subcontractor-shaped
    // payment through the on-cost path yields nothing, because the rate lookup
    // (built from `memberships`) cannot resolve them.
    const membershipRates = new Map([["employee-user", 20]]);
    const rows = employerOnCostsFromTimeEntries(
      [{ job_id: "jobA", user_id: "cis-supplier-id", hours: 160 }],
      membershipRates,
      "monthly",
      "2026-06-01",
    );
    expect(rows).toEqual([]);
  });

  it("a CIS payment is bucketed as `subcontractors`, which the labour on-cost never touches", () => {
    // Even if a CIS cost and an employee's labour sit on the same job, they land in
    // different buckets — no employer NI can attach to the CIS spend.
    const p = computeJobProfitability(
      "jobA",
      [{ job_id: "jobA", amount: 10_000 }],
      [
        { job_id: "jobA", amount: 4_000, category: "subcontractor" },
        { job_id: "jobA", amount: 3_200, category: "labour" },
      ],
    );
    expect(p?.costs_by_bucket.subcontractors).toBe(4_000);
    expect(p?.costs_by_bucket.labour).toBe(3_200);
    expect(mapToCostBucket("subcontractor")).toBe("subcontractors");
    expect(mapToCostBucket("subcontractors")).toBe("subcontractors");
  });

  it("SOURCE-PINNED: no CIS or supplier module imports the employer-cost API", () => {
    // If a future change wires employer NI into a CIS payment path, this fails.
    const files = [
      "lib/cis/deduction.ts",
      "lib/cis/contractor.ts",
      "lib/cis/statements.ts",
      "lib/cis/verification.ts",
      "lib/cis/tax-month.ts",
      "lib/cis/schema.ts",
      "lib/cis/types.ts",
      "lib/suppliers/payments.ts",
    ];
    for (const f of files) {
      const code = readFileSync(resolve(process.cwd(), f), "utf8");
      expect(code, `${f} must not import employer-cost helpers`).not.toMatch(
        /employerCostsForStoredLine|employerOnCostsFromTimeEntries|annualEmployerNi|annualEmployerPension|lib\/payroll/,
      );
    }
  });

  it("SOURCE-PINNED: the employer-cost module has no CIS dependency and touches no CIS table", () => {
    for (const f of ["lib/payroll/compute.ts", "lib/payroll/rates.ts"]) {
      const code = stripComments(read(f));
      // No import of any CIS or supplier module...
      expect(code, `${f} must not import CIS/supplier code`).not.toMatch(
        /from\s+["'](@\/lib\/(cis|suppliers)|\.{1,2}\/(cis|suppliers))/,
      );
      // ...and no reference to a CIS/supplier table in code.
      expect(code, `${f} must not reference CIS/supplier tables`).not.toMatch(
        /cis_subcontractor|supplier_bill|cis_deduction/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Active-org pinning / dual-employment
// ---------------------------------------------------------------------------

describe("dual-employed worker must not blend across orgs", () => {
  it("on-costs follow the hours they are given — the £400-vs-£200 gross regression", () => {
    // The historic defect: a worker employed by BOTH companies had org B's shifts
    // summed into org A's payroll, taking gross from £200 to £400. The fix is the
    // `.eq("org_id", ctx.org.id)` pin on the hours query; this proves the employer
    // on-cost inherits that pin and that blending is NOT harmless.
    const rates = new Map([["dual-worker", 10]]);
    const orgAOnly = [{ job_id: "jobA", user_id: "dual-worker", hours: 20 }];
    const blended = [
      { job_id: "jobA", user_id: "dual-worker", hours: 20 }, // org A
      { job_id: "jobB", user_id: "dual-worker", hours: 20 }, // org B — must not appear
    ];

    const pinned = employerOnCostsFromTimeEntries(orgAOnly, rates, "weekly", "2026-06-01");
    const wrong = employerOnCostsFromTimeEntries(blended, rates, "weekly", "2026-06-01");

    // Pinned: 20h × £10 = £200/wk → annualised £10,400.
    //   NI      (10,400 − 5,000) × 15% = 810.00 / 52 = 15.5769… → 15.58
    //   pension 3% × (10,400 − 6,240)  = 124.80 / 52 =  2.40
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.amount).toBe(17.98);

    // Blended: £400/wk → annualised £20,800 → on-cost £45.58 + £8.40 = £53.98.
    const wrongTotal = wrong.reduce((s, r) => s + r.amount, 0);
    expect(wrongTotal).toBeCloseTo(53.98, 2);

    // Blending is worse than double-counting: because employer NI is BANDED, the
    // error is MORE than 2× (£53.98 vs £35.96), so the threshold is consumed once
    // and the marginal rate applies to the other company's hours too.
    expect(wrongTotal).toBeGreaterThan(pinned[0]!.amount * 2);
  });

  it("banding is per (worker, org-scoped input) — two workers never share a threshold", () => {
    const rates = new Map([
      ["w1", 10],
      ["w2", 10],
    ]);
    const rows = employerOnCostsFromTimeEntries(
      [
        { job_id: "jobA", user_id: "w1", hours: 20 },
        { job_id: "jobA", user_id: "w2", hours: 20 },
      ],
      rates,
      "weekly",
      "2026-06-01",
    );
    // Each worker gets their OWN secondary threshold — 2 × £17.98.
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(35.96, 2);
  });

  it("SOURCE-PINNED: every hours source feeding an employer cost is org-pinned", () => {
    for (const f of ["app/(app)/payroll/actions.ts", "app/(app)/dashboard/page.tsx"]) {
      const code = readFileSync(resolve(process.cwd(), f), "utf8");
      const idx = code.indexOf('from("time_entries")');
      expect(idx, `${f} must read time_entries`).toBeGreaterThan(-1);
      // The org pin must appear in the same query chain as the select.
      expect(code.slice(idx, idx + 500)).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// Estimate-ness must be impossible to lose
// ---------------------------------------------------------------------------

describe("the numbers stay labelled as estimates", () => {
  it("every employer field carries the `_estimate` suffix", () => {
    const r = computePayrollLine(160, 20, "monthly", "2026-06-01");
    const employerKeys = Object.keys(r).filter((k) => k.startsWith("employer_"));
    for (const k of ["employer_ni_estimate", "employer_pension_estimate"]) {
      expect(employerKeys).toContain(k);
    }
    // The composed total, too — nothing reads as a settled figure.
    expect(r).toHaveProperty("employment_cost_estimate");
  });

  it("the CSV header labels employer columns as estimates and separates employee NI", () => {
    const csv = payrollCsv(
      [
        {
          full_name: "Jane Doe",
          ni_number: "QQ123456C",
          hours: 160,
          hourly_pay: 20,
          gross_pay: 3_200,
          paye_estimate: 430.5,
          ni_estimate: 214.24,
          net_pay: 2_555.26,
          employer_ni_estimate: 417.5,
          employer_pension_estimate: 80.4,
          employment_cost_estimate: 3_697.9,
        },
      ],
      { period_start: "2026-06-01", period_end: "2026-06-30", cycle: "monthly" },
    );
    const [header, row] = csv.split("\n");
    expect(header).toContain("Employer NI est");
    expect(header).toContain("Employer pension est");
    expect(header).toContain("Total employment cost est");
    // "NI est" alone was ambiguous once an employer figure exists.
    expect(header).toContain("Employee NI est");
    expect(row).toContain("417.50");
    expect(row).toContain("80.40");
    expect(row).toContain("3697.90");
  });

  it("the run page discloses estimate-ness, the rate year and the biggest omission", () => {
    // JSX text reflows across lines, so match whitespace-tolerantly.
    const code = read("app/(app)/payroll/[id]/page.tsx").replace(/\s+/g, " ");
    expect(code).toMatch(/<strong>estimates<\/strong>/);
    expect(code).toMatch(/Employment Allowance/);
    // It must say the cost is NOT a deduction from the worker.
    expect(code).toMatch(/not deducted from it/);
    // ...and disclose which tax year's rates produced the figure.
    expect(code).toMatch(/ratesTaxYear/);
    expect(code).toMatch(/ratesExtrapolated/);
  });

  it("the dashboard labour tile says what it includes", () => {
    const code = readFileSync(
      resolve(process.cwd(), "app/(app)/dashboard/page.tsx"),
      "utf8",
    );
    expect(code).toMatch(/est\. incl\. employer NI \+ pension/);
  });
});

// ---------------------------------------------------------------------------
// The loud-omission list
// ---------------------------------------------------------------------------

describe("NOT_MODELLED is explicit about what is missing and which way it errs", () => {
  it("names the omissions that materially change the answer", () => {
    const items = NOT_MODELLED.map((n) => n.item.toLowerCase()).join(" | ");
    for (const needle of [
      "employment allowance",
      "veteran",
      "director",
      "salary sacrifice",
      "opt-out",
    ]) {
      expect(items).toContain(needle);
    }
  });

  it("gives every omission a direction of error and a reason it is omitted, not guessed", () => {
    expect(NOT_MODELLED.length).toBeGreaterThanOrEqual(8);
    for (const n of NOT_MODELLED) {
      expect(n.effect).toMatch(
        /^(overstates_employer_cost|understates_employer_cost|either_direction)$/,
      );
      expect(n.needs.length).toBeGreaterThan(0);
      expect(n.detail.length).toBeGreaterThan(40);
    }
  });

  it("flags that exactly one omission UNDERSTATES cost — the opted-in low earner", () => {
    const understating = NOT_MODELLED.filter(
      (n) => n.effect === "understates_employer_cost",
    );
    // Direction matters: everything else is conservative (overstates cost, so
    // margins are pessimistic), and these are the ones that can flatter a margin.
    expect(understating.map((n) => n.item)).toContain(
      "Opted-in workers below the earnings trigger",
    );
  });
});

// ---------------------------------------------------------------------------
// One source of truth
// ---------------------------------------------------------------------------

describe("one rate table, one computation", () => {
  it("no rate literal is duplicated in CODE outside lib/payroll/rates.ts", () => {
    for (const f of [
      "lib/payroll/compute.ts",
      "lib/tax/compute.ts",
      "app/(app)/dashboard/page.tsx",
      "app/(app)/payroll/actions.ts",
      "app/api/payroll/[id]/csv/route.ts",
    ]) {
      // Comments stripped: docblocks SHOULD explain the rates, and explaining the
      // 13.8% → 15% step change is documentation, not a second source of truth.
      const code = stripComments(read(f));
      expect(code, `${f} must not hardcode the employer NI rate`).not.toMatch(
        /0\.138|0\.15\b/,
      );
      expect(code, `${f} must not hardcode the secondary threshold`).not.toMatch(
        /9_100|5_000/,
      );
      // Only £6,240 — the qualifying-earnings LOWER limit — is unique enough to pin.
      // £50,270 is also the frozen higher-rate threshold and employee-NI upper
      // earnings limit (legitimate employee-side constants in
      // lib/payroll/compute.ts), and 10_000 is also a percent-scaling factor in
      // lib/tax/compute.ts. Same numbers, different rules — pinning them would
      // assert a false positive rather than a real duplicated rate.
      expect(code, `${f} must not hardcode the pension band`).not.toMatch(/6_240/);
    }
  });

  it("the rate table cites the tax year of every rate it holds", () => {
    const code = readFileSync(resolve(process.cwd(), "lib/payroll/rates.ts"), "utf8");
    for (const ty of PUBLISHED_TAX_YEARS) {
      expect(code).toContain(`tax year ${ty}`);
    }
    // And points at the sourced document rather than asserting rates on its own.
    expect(code).toMatch(/docs\/payroll-employer-costs\.md/);
  });

  it("employer costs are DERIVED, so no migration and no SQL copy of the rate table", () => {
    // The whole design rests on gross_pay + cycle + period_start being enough. If a
    // future change persists employer columns it must also solve the backfill and
    // the second-source-of-truth problem — this test is the tripwire.
    const migrations = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260525000000_field_operations.sql"),
      "utf8",
    );
    expect(migrations).not.toMatch(/employer_ni|employer_pension/);
  });
});
