import { describe, it, expect } from "vitest";
import {
  annualScottishIncomeTax,
  annualStudentLoan,
  annualIncomeTax,
  computePayrollLine,
  computeEmployeeDeductionsForStoredLine,
  employmentAllowanceReliefForRun,
} from "@/lib/payroll/compute";
import { resolveEmploymentCostRates } from "@/lib/payroll/rates";

// Rate tables in force for the two years we test against.
const R_2025 = resolveEmploymentCostRates("2025-05-01").rates;
const R_2024 = resolveEmploymentCostRates("2024-05-01").rates;

describe("annualStudentLoan", () => {
  it("is 0 at or below the plan threshold", () => {
    expect(annualStudentLoan(26_065, "plan_1", R_2025.student_loan)).toBe(0);
    expect(annualStudentLoan(10_000, "plan_2", R_2025.student_loan)).toBe(0);
  });

  it("Plan 1: 9% above the 2025-26 threshold (£26,065)", () => {
    // (36,065 − 26,065) × 9% = £900
    expect(annualStudentLoan(36_065, "plan_1", R_2025.student_loan)).toBeCloseTo(900, 2);
  });

  it("Plan 2: 9% above the 2025-26 threshold (£28,470)", () => {
    // (38,470 − 28,470) × 9% = £900
    expect(annualStudentLoan(38_470, "plan_2", R_2025.student_loan)).toBeCloseTo(900, 2);
  });

  it("Plan 4: 9% above the 2025-26 threshold (£32,745)", () => {
    // (42,745 − 32,745) × 9% = £900
    expect(annualStudentLoan(42_745, "plan_4", R_2025.student_loan)).toBeCloseTo(900, 2);
  });

  it("Postgraduate: 6% above £21,000 (not 9%)", () => {
    // (31,000 − 21,000) × 6% = £600
    expect(annualStudentLoan(31_000, "postgraduate", R_2025.student_loan)).toBeCloseTo(
      600,
      2,
    );
  });

  it("thresholds are DATED — 2024-25 differs from 2025-26 for the same gross", () => {
    const gross = 40_000;
    const sl24 = annualStudentLoan(gross, "plan_2", R_2024.student_loan); // thr 27,295
    const sl25 = annualStudentLoan(gross, "plan_2", R_2025.student_loan); // thr 28,470
    expect(sl24).toBeGreaterThan(sl25); // lower threshold ⇒ more repaid
    expect(sl24).toBeCloseTo((40_000 - 27_295) * 0.09, 2);
    expect(sl25).toBeCloseTo((40_000 - 28_470) * 0.09, 2);
  });
});

describe("annualScottishIncomeTax", () => {
  const s = R_2025.scottish_income_tax;

  it("0 at or below the personal allowance", () => {
    expect(annualScottishIncomeTax(12_570, s)).toBe(0);
    expect(annualScottishIncomeTax(0, s)).toBe(0);
  });

  it("starter band (19%) just above the allowance", () => {
    // £13,570 → £1,000 in the 19% starter band = £190
    expect(annualScottishIncomeTax(13_570, s)).toBeCloseTo(190, 2);
  });

  it("bands stack correctly at £38,400", () => {
    // 12,570→15,397 @19% = 537.13
    // 15,397→27,491 @20% = 2,418.80
    // 27,491→38,400 @21% = 2,290.89
    // total = 5,246.82
    expect(annualScottishIncomeTax(38_400, s)).toBeCloseTo(5_246.82, 2);
  });

  it("diverges from rest-of-UK — a mid earner pays MORE in Scotland", () => {
    expect(annualScottishIncomeTax(38_400, s)).toBeGreaterThan(annualIncomeTax(38_400));
  });

  it("top band (48%) above £125,140", () => {
    const base = annualScottishIncomeTax(125_140, s);
    const extra = annualScottishIncomeTax(135_140, s) - base;
    expect(extra).toBeCloseTo(10_000 * 0.48, 2);
  });
});

describe("computeEmployeeDeductionsForStoredLine — backward compatibility", () => {
  it("empty inputs reproduce the stored PAYE/NI/net to the penny", () => {
    for (const [hours, rate, cycle] of [
      [40, 15, "weekly"],
      [160, 20, "monthly"],
      [50, 10, "weekly"],
      [0, 20, "weekly"],
    ] as const) {
      const base = computePayrollLine(hours, rate, cycle, "2025-05-01");
      const ded = computeEmployeeDeductionsForStoredLine(
        base.gross_pay,
        cycle,
        "2025-05-01",
        {},
      );
      expect(ded.paye_estimate).toBe(base.paye_estimate);
      expect(ded.ni_estimate).toBe(base.ni_estimate);
      expect(ded.net_pay).toBe(base.net_pay);
      expect(ded.student_loan_estimate).toBe(0);
      expect(ded.employee_pension_estimate).toBe(0);
      expect(ded.salary_sacrifice).toBe(0);
      expect(ded.tax_region).toBe("rest_of_uk");
    }
  });
});

describe("computeEmployeeDeductionsForStoredLine — fidelity paths", () => {
  it("salary sacrifice reduces the tax/NI base (lower PAYE + NI + take-home)", () => {
    const base = computeEmployeeDeductionsForStoredLine(3_200, "monthly", "2025-05-01", {});
    const sac = computeEmployeeDeductionsForStoredLine(3_200, "monthly", "2025-05-01", {
      salarySacrificeAnnual: 3_600, // £300/mo
    });
    expect(sac.salary_sacrifice).toBeCloseTo(300, 2);
    expect(sac.taxable_pay).toBeCloseTo(2_900, 2);
    // annual base 34,800 → PAYE (34,800−12,570)×20%/12 = 370.50
    expect(sac.paye_estimate).toBeCloseTo(370.5, 2);
    expect(sac.paye_estimate).toBeLessThan(base.paye_estimate);
    expect(sac.ni_estimate).toBeLessThan(base.ni_estimate);
  });

  it("salary sacrifice is clamped to the period gross", () => {
    const sac = computeEmployeeDeductionsForStoredLine(1_000, "monthly", "2025-05-01", {
      salarySacrificeAnnual: 60_000, // £5,000/mo > £1,000 gross
    });
    expect(sac.salary_sacrifice).toBe(1_000);
    expect(sac.taxable_pay).toBe(0);
    expect(sac.paye_estimate).toBe(0);
    expect(sac.ni_estimate).toBe(0);
  });

  it("employee pension is a relief-at-source deduction — hits net, NOT PAYE/NI", () => {
    const base = computeEmployeeDeductionsForStoredLine(3_200, "monthly", "2025-05-01", {});
    const p = computeEmployeeDeductionsForStoredLine(3_200, "monthly", "2025-05-01", {
      employeePensionRate: 0.05,
    });
    // qualifying (38,400 capped) − 6,240 = 32,160 × 5% / 12 = £134
    expect(p.employee_pension_estimate).toBeCloseTo(134, 2);
    expect(p.paye_estimate).toBe(base.paye_estimate); // unchanged
    expect(p.ni_estimate).toBe(base.ni_estimate); // unchanged
    expect(p.net_pay).toBeCloseTo(base.net_pay - 134, 2);
  });

  it("Scottish region routes PAYE through the Scottish scale", () => {
    const ruk = computeEmployeeDeductionsForStoredLine(3_200, "monthly", "2025-05-01", {});
    const sco = computeEmployeeDeductionsForStoredLine(3_200, "monthly", "2025-05-01", {
      taxRegion: "scotland",
    });
    expect(sco.tax_region).toBe("scotland");
    expect(sco.paye_estimate).toBeGreaterThan(ruk.paye_estimate);
    // 5,246.82 / 12 = 437.24
    expect(sco.paye_estimate).toBeCloseTo(437.24, 1);
  });

  it("student-loan plan adds a deduction from the period", () => {
    const pg = computeEmployeeDeductionsForStoredLine(3_200, "monthly", "2025-05-01", {
      studentLoanPlan: "postgraduate",
    });
    // (38,400 − 21,000) × 6% / 12 = £87
    expect(pg.student_loan_estimate).toBeCloseTo(87, 2);
    expect(pg.student_loan_plan).toBe("postgraduate");
  });

  it("combines sacrifice + student loan + region + pension coherently", () => {
    const r = computeEmployeeDeductionsForStoredLine(3_200, "monthly", "2025-05-01", {
      taxRegion: "scotland",
      studentLoanPlan: "plan_2",
      employeePensionRate: 0.05,
      salarySacrificeAnnual: 1_200, // £100/mo
    });
    // net = gross − sacrifice − paye − ni − student loan − pension, all ≥ 0
    const recomputed =
      r.gross_pay -
      r.salary_sacrifice -
      r.paye_estimate -
      r.ni_estimate -
      r.student_loan_estimate -
      r.employee_pension_estimate;
    expect(r.net_pay).toBeCloseTo(recomputed, 2);
    expect(r.net_pay).toBeLessThan(3_200);
  });
});

describe("employmentAllowanceReliefForRun", () => {
  it("caps relief at the run's employer NI when NI is below the allowance", () => {
    const ea = employmentAllowanceReliefForRun(8_000, "2025-05-01");
    expect(ea.allowance_annual).toBe(10_500);
    expect(ea.relief_this_run).toBe(8_000);
    expect(ea.employer_ni_after).toBe(0);
  });

  it("caps relief at the annual allowance when NI exceeds it", () => {
    const ea = employmentAllowanceReliefForRun(15_000, "2025-05-01");
    expect(ea.relief_this_run).toBe(10_500);
    expect(ea.employer_ni_after).toBe(4_500);
  });

  it("uses the DATED allowance — £5,000 for 2024-25 vs £10,500 for 2025-26", () => {
    const ea24 = employmentAllowanceReliefForRun(8_000, "2024-05-01");
    expect(ea24.allowance_annual).toBe(5_000);
    expect(ea24.relief_this_run).toBe(5_000);
    expect(ea24.employer_ni_after).toBe(3_000);
  });

  it("never returns negative relief for a zero-NI run", () => {
    const ea = employmentAllowanceReliefForRun(0, "2025-05-01");
    expect(ea.relief_this_run).toBe(0);
    expect(ea.employer_ni_after).toBe(0);
  });
});
