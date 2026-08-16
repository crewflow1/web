import { describe, it, expect } from "vitest";
import {
  annualEmployerPension,
  annualEmployerPensionForEnrolment,
  employerCostsForStoredLine,
  employerCostsForStoredLineWithPension,
  type PensionEnrolmentInput,
} from "@/lib/payroll/compute";
import { resolveEmploymentCostRates } from "@/lib/payroll/rates";

/**
 * Pension auto-enrolment feeding the employer-cost ESTIMATE.
 *
 * The contract:
 *   - untracked (no enrolment) → identical to the statutory-3% estimate, so no
 *     existing run changes to the penny;
 *   - not_enrolled / opted_out / postponed → £0 employer pension;
 *   - enrolled → the scheme's employer rate × qualifying earnings, charged even
 *     below the earnings trigger (the one omission that used to UNDERSTATE cost);
 *   - employer NI is never touched by pension state.
 */

const PENSION_RATES = resolveEmploymentCostRates("2026-06-01").rates
  .employer_pension;

// Monthly £3,200 → annualised £38,400. Qualifying = min(38400,50270) − 6240 =
// 32,160. Statutory 3% = £964.80/yr = £80.40/mo (matches the CSV fixture).
const GROSS = 3_200;

describe("annualEmployerPensionForEnrolment", () => {
  const enrolled = (rate: number): PensionEnrolmentInput => ({
    status: "enrolled",
    employer_contribution_rate: rate,
  });

  it("enrolled at 3% equals the statutory minimum for a mid earner", () => {
    const annual = 38_400;
    expect(annualEmployerPensionForEnrolment(annual, PENSION_RATES, enrolled(0.03))).toBeCloseTo(
      annualEmployerPension(annual, PENSION_RATES),
      6,
    );
  });

  it("enrolled at a richer 5% scheme costs more than the statutory 3%", () => {
    const annual = 38_400;
    const at5 = annualEmployerPensionForEnrolment(annual, PENSION_RATES, enrolled(0.05));
    expect(at5).toBeCloseTo(32_160 * 0.05, 6); // 1608
    expect(at5).toBeGreaterThan(annualEmployerPension(annual, PENSION_RATES));
  });

  it("opted_out / not_enrolled / postponed cost nothing", () => {
    const annual = 38_400;
    for (const status of ["opted_out", "not_enrolled", "postponed"] as const) {
      expect(
        annualEmployerPensionForEnrolment(annual, PENSION_RATES, {
          status,
          employer_contribution_rate: 0.03,
        }),
      ).toBe(0);
    }
  });

  it("an ENROLLED low earner below the trigger is still charged (the understatement fix)", () => {
    const annual = 8_400; // below the £10,000 auto-enrolment trigger
    // Statutory path charges nothing below the trigger…
    expect(annualEmployerPension(annual, PENSION_RATES)).toBe(0);
    // …but an actively-enrolled worker must still receive employer contributions.
    // Qualifying = 8400 − 6240 = 2160 → 3% = 64.80.
    expect(
      annualEmployerPensionForEnrolment(annual, PENSION_RATES, enrolled(0.03)),
    ).toBeCloseTo(2_160 * 0.03, 6);
  });

  it("a negative rate is floored at 0", () => {
    expect(
      annualEmployerPensionForEnrolment(38_400, PENSION_RATES, {
        status: "enrolled",
        employer_contribution_rate: -0.5,
      }),
    ).toBe(0);
  });
});

describe("employerCostsForStoredLineWithPension", () => {
  it("is IDENTICAL to the statutory helper when no enrolment is tracked", () => {
    for (const gross of [0, 500, GROSS, 9_000, 60_000]) {
      const statutory = employerCostsForStoredLine(gross, "monthly", "2026-06-01");
      const tracked = employerCostsForStoredLineWithPension(
        gross,
        "monthly",
        "2026-06-01",
        undefined,
      );
      expect(tracked).toEqual(statutory);
    }
  });

  it("zeroes the pension for an opted-out employee, leaving employer NI intact", () => {
    const statutory = employerCostsForStoredLine(GROSS, "monthly", "2026-06-01");
    const optedOut = employerCostsForStoredLineWithPension(
      GROSS,
      "monthly",
      "2026-06-01",
      { status: "opted_out", employer_contribution_rate: 0.03 },
    );
    expect(optedOut.employer_pension_estimate).toBe(0);
    // Employer NI unchanged; total employment cost drops by exactly the pension.
    expect(optedOut.employer_ni_estimate).toBe(statutory.employer_ni_estimate);
    expect(optedOut.employment_cost_estimate).toBeCloseTo(
      statutory.employment_cost_estimate - statutory.employer_pension_estimate,
      2,
    );
  });

  it("prices an enrolled 5% scheme above the statutory estimate", () => {
    const statutory = employerCostsForStoredLine(GROSS, "monthly", "2026-06-01");
    const enrolled = employerCostsForStoredLineWithPension(
      GROSS,
      "monthly",
      "2026-06-01",
      { status: "enrolled", employer_contribution_rate: 0.05 },
    );
    // 32,160 × 5% / 12 = 134.00.
    expect(enrolled.employer_pension_estimate).toBeCloseTo(134, 2);
    expect(enrolled.employer_pension_estimate).toBeGreaterThan(
      statutory.employer_pension_estimate,
    );
  });

  it("carries the estimate metadata through unchanged", () => {
    const r = employerCostsForStoredLineWithPension(
      GROSS,
      "monthly",
      "2026-06-01",
      { status: "enrolled", employer_contribution_rate: 0.03 },
    );
    expect(r).toHaveProperty("employer_rates_tax_year");
    expect(r).toHaveProperty("employer_rates_extrapolated");
    expect(r).toHaveProperty("employment_cost_estimate");
  });
});
