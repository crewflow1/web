import { describe, it, expect } from "vitest";
import {
  annualEmployerNi,
  annualEmployerNiForCategory,
  employerNiProfileForCategory,
  isNiCategory,
  niCategoryFromStoredProfile,
  standardHoursPerDayFromStoredProfile,
  niCategoryAgeWarning,
  computeGrossBreakdown,
  computePayrollLine,
  employerCostsForStoredLine,
  employerCostsForStoredLineWithPension,
  employerOnCostsFromTimeEntries,
  payrollCsv,
  DEFAULT_NI_CATEGORY,
  DEFAULT_OVERTIME_MULTIPLIER,
  NI_CATEGORIES,
  STANDARD_EMPLOYER_NI_CATEGORIES,
  ZERO_RATE_TO_UST_NI_CATEGORIES,
  type NiCategory,
} from "@/lib/payroll/compute";
import { resolveEmploymentCostRates } from "@/lib/payroll/rates";

/**
 * MP W1 payroll — full NI categories, overtime and holiday pay into gross.
 *
 * All figures are hand-worked against the 2026-27 dated table
 * (Secondary Threshold £5,000, Upper Secondary Threshold £50,270, secondary rate
 * 15%) resolved from a period start inside 2026-27. The overriding requirement is
 * DEFAULT-SAFETY: category 'A', no overtime and no holiday reproduce the historical
 * figures to the penny, so an existing run is unchanged.
 */

const RATES = resolveEmploymentCostRates("2026-06-01").rates;
const NI = RATES.employer_ni;
const ST = NI.secondary_threshold_annual; // 5_000
const UST = NI.upper_secondary_threshold_annual; // 50_270
const RATE = NI.rate; // 0.15

describe("NI category taxonomy", () => {
  it("splits the eight letters into the two employer-cost profiles", () => {
    expect([...NI_CATEGORIES].sort()).toEqual(
      ["A", "B", "C", "H", "J", "M", "V", "Z"].sort(),
    );
    for (const c of STANDARD_EMPLOYER_NI_CATEGORIES) {
      expect(employerNiProfileForCategory(c)).toBe("standard");
    }
    for (const c of ZERO_RATE_TO_UST_NI_CATEGORIES) {
      expect(employerNiProfileForCategory(c)).toBe("zero_rate_to_ust");
    }
  });

  it("recognises valid letters and rejects everything else", () => {
    expect(isNiCategory("A")).toBe(true);
    expect(isNiCategory("M")).toBe(true);
    expect(isNiCategory("Q")).toBe(false);
    expect(isNiCategory("")).toBe(false);
    expect(isNiCategory(null)).toBe(false);
    expect(isNiCategory(undefined)).toBe(false);
  });
});

describe("annualEmployerNiForCategory — standard letters (A/B/C/J)", () => {
  it("is byte-identical to annualEmployerNi for every standard letter", () => {
    for (const gross of [0, ST, ST + 1, 30_000, UST, 60_000, 120_000]) {
      const base = annualEmployerNi(gross, NI);
      for (const c of ["A", "B", "C", "J"] as NiCategory[]) {
        expect(annualEmployerNiForCategory(gross, NI, c)).toBeCloseTo(base, 6);
      }
    }
  });

  it("default category is 'A' and equals the standard rule", () => {
    expect(DEFAULT_NI_CATEGORY).toBe("A");
    expect(annualEmployerNiForCategory(60_000, NI)).toBeCloseTo(
      annualEmployerNi(60_000, NI),
      6,
    );
  });

  it("standard boundary: nil at the Secondary Threshold, charged just above", () => {
    expect(annualEmployerNiForCategory(ST, NI, "A")).toBe(0);
    expect(annualEmployerNiForCategory(ST + 1, NI, "A")).toBeCloseTo(RATE, 6);
    // £60,000: (60000 − 5000) × 15% = 8_250
    expect(annualEmployerNiForCategory(60_000, NI, "A")).toBeCloseTo(8_250, 6);
  });
});

describe("annualEmployerNiForCategory — zero-rate-to-UST letters (H/M/V/Z)", () => {
  it("charges nothing at or below the Upper Secondary Threshold", () => {
    for (const c of ["H", "M", "V", "Z"] as NiCategory[]) {
      expect(annualEmployerNiForCategory(0, NI, c)).toBe(0);
      expect(annualEmployerNiForCategory(ST + 1, NI, c)).toBe(0);
      expect(annualEmployerNiForCategory(30_000, NI, c)).toBe(0);
      // Exactly at the UST is still nil (0% up to AND including the UST band).
      expect(annualEmployerNiForCategory(UST, NI, c)).toBe(0);
    }
  });

  it("charges the standard rate only on earnings ABOVE the UST", () => {
    for (const c of ["H", "M", "V", "Z"] as NiCategory[]) {
      // One pound over the UST.
      expect(annualEmployerNiForCategory(UST + 1, NI, c)).toBeCloseTo(RATE, 6);
      // £60,000: (60000 − 50270) × 15% = 1_459.50
      expect(annualEmployerNiForCategory(60_000, NI, c)).toBeCloseTo(1_459.5, 6);
    }
  });

  it("category transition A → M: identical above the UST, divergent between ST and UST", () => {
    // Between ST and UST: A charges, M is nil (the whole point of the relief).
    expect(annualEmployerNiForCategory(30_000, NI, "A")).toBeCloseTo(3_750, 6);
    expect(annualEmployerNiForCategory(30_000, NI, "M")).toBe(0);
    // Above the UST the ONLY difference is the £5,000→£50,270 band, worth
    // (50270 − 5000) × 15% = £6,790.50; A is exactly that much more than M.
    const a = annualEmployerNiForCategory(60_000, NI, "A");
    const m = annualEmployerNiForCategory(60_000, NI, "M");
    expect(a - m).toBeCloseTo((UST - ST) * RATE, 6);
  });
});

describe("niCategoryFromStoredProfile / standardHoursPerDayFromStoredProfile", () => {
  it("defaults to 'A' for absent/null/invalid, echoes valid letters", () => {
    expect(niCategoryFromStoredProfile(null)).toBe("A");
    expect(niCategoryFromStoredProfile(undefined)).toBe("A");
    expect(niCategoryFromStoredProfile({})).toBe("A");
    expect(niCategoryFromStoredProfile({ ni_category: null })).toBe("A");
    expect(niCategoryFromStoredProfile({ ni_category: "Q" })).toBe("A");
    expect(niCategoryFromStoredProfile({ ni_category: "M" })).toBe("M");
    expect(niCategoryFromStoredProfile({ ni_category: "V" })).toBe("V");
  });

  it("holiday hours-per-day defaults to 0 (no holiday pay) unless set", () => {
    expect(standardHoursPerDayFromStoredProfile(null)).toBe(0);
    expect(standardHoursPerDayFromStoredProfile({})).toBe(0);
    expect(standardHoursPerDayFromStoredProfile({ standard_hours_per_day: null })).toBe(0);
    expect(standardHoursPerDayFromStoredProfile({ standard_hours_per_day: 8 })).toBe(8);
    expect(standardHoursPerDayFromStoredProfile({ standard_hours_per_day: "7.5" })).toBe(7.5);
    expect(standardHoursPerDayFromStoredProfile({ standard_hours_per_day: -3 })).toBe(0);
  });
});

describe("niCategoryAgeWarning — non-blocking consistency check", () => {
  const periodEnd = "2026-06-30";
  it("flags M/Z when the employee is 21 or older at the period end", () => {
    // Born 2005-06-30 ⇒ turns 21 on 2026-06-30 ⇒ age 21 at period end.
    expect(niCategoryAgeWarning("M", "2005-06-30", periodEnd)).toMatch(/under 21/);
    expect(niCategoryAgeWarning("Z", "2005-06-30", periodEnd)).toMatch(/under 21/);
  });
  it("does not flag M/Z for someone still under 21", () => {
    // Born 2006-01-01 ⇒ age 20 at period end.
    expect(niCategoryAgeWarning("M", "2006-01-01", periodEnd)).toBeNull();
  });
  it("flags H at 25+ but not below", () => {
    expect(niCategoryAgeWarning("H", "2001-06-30", periodEnd)).toMatch(/under 25/);
    expect(niCategoryAgeWarning("H", "2003-01-01", periodEnd)).toBeNull();
  });
  it("never flags standard letters, veterans, or when no DOB is recorded", () => {
    expect(niCategoryAgeWarning("A", "1990-01-01", periodEnd)).toBeNull();
    expect(niCategoryAgeWarning("V", "1990-01-01", periodEnd)).toBeNull();
    expect(niCategoryAgeWarning("M", null, periodEnd)).toBeNull();
    expect(niCategoryAgeWarning("M", undefined, periodEnd)).toBeNull();
  });
});

describe("employer-cost helpers honour the NI category", () => {
  it("employerCostsForStoredLine: monthly gross £3,000 — A charges, M is nil", () => {
    // annualised 36,000 < UST ⇒ M nil; A: (36000 − 5000) × 15% / 12 = 387.50
    const a = employerCostsForStoredLine(3_000, "monthly", "2026-06-01", 0, "A");
    const m = employerCostsForStoredLine(3_000, "monthly", "2026-06-01", 0, "M");
    expect(a.employer_ni_estimate).toBeCloseTo(387.5, 2);
    expect(a.ni_category).toBe("A");
    expect(m.employer_ni_estimate).toBe(0);
    expect(m.ni_category).toBe("M");
  });

  it("defaults to 'A' when no category is supplied (unchanged behaviour)", () => {
    const dflt = employerCostsForStoredLine(3_000, "monthly", "2026-06-01");
    const explicitA = employerCostsForStoredLine(3_000, "monthly", "2026-06-01", 0, "A");
    expect(dflt.employer_ni_estimate).toBeCloseTo(explicitA.employer_ni_estimate, 6);
    expect(dflt.ni_category).toBe("A");
  });

  it("employerCostsForStoredLineWithPension threads the category too", () => {
    const m = employerCostsForStoredLineWithPension(
      3_000,
      "monthly",
      "2026-06-01",
      undefined,
      undefined,
      "M",
    );
    expect(m.employer_ni_estimate).toBe(0);
    expect(m.ni_category).toBe("M");
  });

  it("employerOnCostsFromTimeEntries: a category-M worker attracts no employer NI on-cost below the UST", () => {
    const entries = [{ job_id: "job-1", user_id: "u1", hours: 160 }];
    const rateByUser = new Map([["u1", 18.75]]); // 160 × 18.75 = £3,000/mo
    const catA = new Map<string, NiCategory>([["u1", "A"]]);
    const catM = new Map<string, NiCategory>([["u1", "M"]]);
    const rowsA = employerOnCostsFromTimeEntries(entries, rateByUser, "monthly", "2026-06-01", undefined, catA);
    const rowsM = employerOnCostsFromTimeEntries(entries, rateByUser, "monthly", "2026-06-01", undefined, catM);
    const sumA = rowsA.reduce((s, r) => s + r.amount, 0);
    const sumM = rowsM.reduce((s, r) => s + r.amount, 0);
    // A carries employer NI (387.50) + pension; M carries pension only, so it is lower.
    expect(sumA).toBeGreaterThan(sumM);
  });
});

describe("computeGrossBreakdown — overtime + holiday, default-safe", () => {
  it("reproduces plain hours × rate with no extras", () => {
    const b = computeGrossBreakdown(40, 15);
    expect(b.gross_pay).toBe(600);
    expect(b.normal_pay).toBe(600);
    expect(b.overtime_pay).toBe(0);
    expect(b.leave_pay).toBe(0);
    expect(b.overtime_multiplier).toBe(0);
  });

  it("adds overtime at the default 1.5× when no multiplier is given", () => {
    const b = computeGrossBreakdown(40, 15, { overtimeHours: 5 });
    expect(DEFAULT_OVERTIME_MULTIPLIER).toBe(1.5);
    expect(b.overtime_pay).toBe(112.5); // 5 × 15 × 1.5
    expect(b.overtime_multiplier).toBe(1.5);
    expect(b.gross_pay).toBe(712.5);
  });

  it("honours a per-line multiplier (double time)", () => {
    const b = computeGrossBreakdown(40, 15, { overtimeHours: 5, overtimeMultiplier: 2 });
    expect(b.overtime_pay).toBe(150);
    expect(b.gross_pay).toBe(750);
  });

  it("adds holiday pay at plain rate, exactly once", () => {
    const b = computeGrossBreakdown(32, 15, { leaveHours: 8 });
    expect(b.normal_pay).toBe(480); // 32 worked hours
    expect(b.leave_pay).toBe(120); // 8 holiday hours × 15, once
    expect(b.gross_pay).toBe(600);
  });

  it("combines worked + overtime + holiday", () => {
    const b = computeGrossBreakdown(40, 15, {
      overtimeHours: 5,
      overtimeMultiplier: 1.5,
      leaveHours: 8,
    });
    expect(b.gross_pay).toBe(600 + 112.5 + 120);
  });

  it("holiday-only period (no worked hours) still pays the leave once", () => {
    const b = computeGrossBreakdown(0, 15, { leaveHours: 40 });
    expect(b.normal_pay).toBe(0);
    expect(b.leave_pay).toBe(600);
    expect(b.gross_pay).toBe(600);
  });

  it("clamps negatives and treats zero overtime hours as no overtime", () => {
    const b = computeGrossBreakdown(-5, -10, { overtimeHours: 0, overtimeMultiplier: 2 });
    expect(b.gross_pay).toBe(0);
    expect(b.overtime_multiplier).toBe(0);
  });
});

describe("computePayrollLine — extras flow into gross/PAYE/NI/net", () => {
  it("with no extras is byte-identical to the historical line", () => {
    const c = computePayrollLine(40, 15, "weekly", "2026-06-01");
    expect(c.gross_pay).toBe(600);
    expect(c.overtime_hours).toBe(0);
    expect(c.leave_hours).toBe(0);
    // net = gross − PAYE − employee NI (employer costs never touch net)
    expect(c.net_pay).toBeCloseTo(c.gross_pay - c.paye_estimate - c.ni_estimate, 2);
  });

  it("overtime + holiday raise gross and are reflected in net", () => {
    const base = computePayrollLine(40, 15, "weekly", "2026-06-01");
    const withExtras = computePayrollLine(40, 15, "weekly", "2026-06-01", {
      overtimeHours: 5,
      overtimeMultiplier: 1.5,
      leaveHours: 8,
    });
    expect(withExtras.gross_pay).toBe(600 + 112.5 + 120);
    expect(withExtras.overtime_pay).toBe(112.5);
    expect(withExtras.leave_pay).toBe(120);
    expect(withExtras.gross_pay).toBeGreaterThan(base.gross_pay);
    expect(withExtras.net_pay).toBeCloseTo(
      withExtras.gross_pay - withExtras.paye_estimate - withExtras.ni_estimate,
      2,
    );
  });
});

describe("payrollCsv — appended overtime/holiday/category columns", () => {
  const row = {
    full_name: "Jane Doe",
    ni_number: "QQ123456C",
    hours: 40,
    hourly_pay: 15,
    gross_pay: 712.5,
    paye_estimate: 0,
    ni_estimate: 0,
    net_pay: 712.5,
    employer_ni_estimate: 10,
    employer_pension_estimate: 5,
    employment_cost_estimate: 727.5,
    overtime_hours: 5,
    overtime_pay: 112.5,
    holiday_hours: 0,
    holiday_pay: 0,
    ni_category: "M",
  };
  const csv = payrollCsv([row], {
    period_start: "2026-06-01",
    period_end: "2026-06-30",
    cycle: "monthly",
  });
  const lines = csv.split("\n");

  it("adds the new headers", () => {
    for (const h of ["Overtime hours", "Overtime pay", "Holiday hours", "Holiday pay", "NI category"]) {
      expect(lines[0]).toContain(h);
    }
  });

  it("keeps existing column POSITIONS stable (gross still index 7)", () => {
    // The volume test keys on index 7 for gross — appended columns must not shift it.
    const cells = lines[1]!.split(",");
    expect(cells[7]).toBe("712.50");
  });

  it("emits the appended values and the NI category letter", () => {
    expect(lines[1]).toContain("112.50"); // overtime pay
    expect(lines[1]!.trimEnd().endsWith("M")).toBe(true);
  });

  it("defaults the appended columns to 0 / 'A' when omitted (backward compatible)", () => {
    const bare = payrollCsv(
      [
        {
          full_name: "Bob",
          ni_number: null,
          hours: 10,
          hourly_pay: 10,
          gross_pay: 100,
          paye_estimate: 0,
          ni_estimate: 0,
          net_pay: 100,
          employer_ni_estimate: 0,
          employer_pension_estimate: 0,
          employment_cost_estimate: 100,
        },
      ],
      { period_start: "2026-06-01", period_end: "2026-06-30", cycle: "monthly" },
    );
    const cells = bare.split("\n")[1]!.split(",");
    // last five appended columns: 0.00, 0.00, 0.00, 0.00, A
    expect(cells.slice(-5)).toEqual(["0.00", "0.00", "0.00", "0.00", "A"]);
  });
});
