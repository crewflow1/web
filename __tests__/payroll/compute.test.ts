import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  annualIncomeTax,
  annualEmployeeNi,
  computePayrollLine,
  defaultPeriod,
  payrollCsv,
} from "@/lib/payroll/compute";
import { computePayeMonth } from "@/lib/tax/compute";

describe("annualIncomeTax", () => {
  it("0 below the personal allowance", () => {
    expect(annualIncomeTax(0)).toBe(0);
    expect(annualIncomeTax(12_570)).toBe(0);
  });

  it("20% on the basic-rate band", () => {
    // £25,000 gross → tax on £12,430 at 20% = £2,486
    expect(annualIncomeTax(25_000)).toBeCloseTo(2_486, 2);
  });

  it("higher-rate kicks in above £50,270", () => {
    // £60,000: basic on £37,700 (20%) + higher on £9,730 (40%)
    // = £7,540 + £3,892 = £11,432
    expect(annualIncomeTax(60_000)).toBeCloseTo(11_432, 2);
  });

  it("additional rate (45%) above £125,140", () => {
    // £150,000: basic £37,700 × 20% = £7,540
    //          higher £74,870 × 40% = £29,948
    //          additional £24,860 × 45% = £11,187
    //          total = £48,675
    expect(annualIncomeTax(150_000)).toBeCloseTo(48_675, 2);
  });
});

describe("annualEmployeeNi", () => {
  it("0 below the primary threshold", () => {
    expect(annualEmployeeNi(12_570)).toBe(0);
  });

  it("8% on the main NI band", () => {
    // £25,000: £12,430 × 8% = £994.40
    expect(annualEmployeeNi(25_000)).toBeCloseTo(994.4, 2);
  });

  it("2% on the upper band", () => {
    // £60,000: main £37,700 × 8% = £3,016
    //          upper £9,730 × 2% = £194.60
    //          total = £3,210.60
    expect(annualEmployeeNi(60_000)).toBeCloseTo(3_210.6, 2);
  });
});

describe("computePayrollLine", () => {
  it("weekly: 40h × £15 with no tax (under threshold)", () => {
    const r = computePayrollLine(40, 15, "weekly");
    expect(r.gross_pay).toBe(600);
    // Annualised: 600 × 52 = 31,200 → taxable 18,630 × 20% = 3,726
    // → weekly PAYE = 71.65 (rounded to 2dp)
    expect(r.paye_estimate).toBeCloseTo(71.65, 2);
    // NI: (31,200 − 12,570) × 8% = 1,490.40 / 52 ≈ 28.66
    expect(r.ni_estimate).toBeCloseTo(28.66, 2);
    expect(r.net_pay).toBeCloseTo(600 - 71.65 - 28.66, 2);
  });

  it("monthly: 160h × £20 (higher-rate territory? no — annual £38,400)", () => {
    const r = computePayrollLine(160, 20, "monthly");
    expect(r.gross_pay).toBe(3_200);
    // Annual gross 38,400. Tax: 25,830 × 20% = 5,166 / 12 = 430.50
    expect(r.paye_estimate).toBeCloseTo(430.5, 2);
  });

  it("clamps negatives to 0", () => {
    expect(computePayrollLine(-5, -10, "weekly").gross_pay).toBe(0);
    expect(computePayrollLine(40, -10, "weekly").gross_pay).toBe(0);
  });

  it("zero hours → all-zero line", () => {
    const r = computePayrollLine(0, 20, "weekly");
    expect(r.gross_pay).toBe(0);
    expect(r.paye_estimate).toBe(0);
    expect(r.ni_estimate).toBe(0);
    expect(r.net_pay).toBe(0);
  });

  it("annualisation differs between weekly and monthly cycles", () => {
    // Same period gross of £500 yields different tax depending on cycle.
    const weekly = computePayrollLine(50, 10, "weekly"); // £500/wk → £26k/yr
    const monthly = computePayrollLine(50, 10, "monthly"); // £500/mo → £6k/yr
    expect(weekly.paye_estimate).toBeGreaterThan(0);
    expect(monthly.paye_estimate).toBe(0); // under personal allowance annualised
  });
});

describe("defaultPeriod", () => {
  it("weekly window is Monday → Sunday", () => {
    // 2026-05-19 is a Tuesday
    const p = defaultPeriod("weekly", new Date("2026-05-19T10:00:00Z"));
    expect(p.period_start).toBe("2026-05-18");
    expect(p.period_end).toBe("2026-05-24");
  });

  it("monthly window is calendar month", () => {
    const p = defaultPeriod("monthly", new Date("2026-05-19T10:00:00Z"));
    expect(p.period_start).toBe("2026-05-01");
    expect(p.period_end).toBe("2026-05-31");
  });

  it("monthly window handles leap February", () => {
    const p = defaultPeriod("monthly", new Date("2028-02-15T00:00:00Z"));
    expect(p.period_start).toBe("2028-02-01");
    expect(p.period_end).toBe("2028-02-29");
  });
});

describe("payrollCsv", () => {
  it("renders a header + a row per staff member", () => {
    const csv = payrollCsv(
      [
        {
          full_name: "Jane Doe",
          ni_number: "QQ123456C",
          hours: 40,
          hourly_pay: 15,
          gross_pay: 600,
          paye_estimate: 71.65,
          ni_estimate: 28.66,
          net_pay: 499.69,
          employer_ni_estimate: 75.58,
          employer_pension_estimate: 28.83,
          employment_cost_estimate: 704.41,
        },
      ],
      { period_start: "2026-05-19", period_end: "2026-05-25", cycle: "weekly" },
    );
    const lines = csv.split("\n");
    expect(lines[0]).toContain("Name");
    expect(lines[0]).toContain("NI number");
    expect(lines[1]).toContain("Jane Doe");
    expect(lines[1]).toContain("QQ123456C");
    expect(lines[1]).toContain("600.00");
  });

  it("CSV-escapes names with commas", () => {
    const csv = payrollCsv(
      [
        {
          full_name: 'Smith, "Big" Bob',
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
      { period_start: "2026-05-19", period_end: "2026-05-25", cycle: "weekly" },
    );
    expect(csv).toContain('"Smith, ""Big"" Bob"');
  });

  it("quotes a newline-bearing name and renders a null NI as an empty field (shared escaper)", () => {
    const csv = payrollCsv(
      [
        {
          full_name: "Ops\nTeam",
          ni_number: null,
          hours: 5,
          hourly_pay: 12,
          gross_pay: 60,
          paye_estimate: 0,
          ni_estimate: 0,
          net_pay: 60,
          employer_ni_estimate: 0,
          employer_pension_estimate: 0,
          employment_cost_estimate: 60,
        },
      ],
      { period_start: "2026-05-19", period_end: "2026-05-25", cycle: "weekly" },
    );
    // The newline forces RFC-4180 quoting via the shared csvEscape...
    expect(csv).toContain('"Ops\nTeam"');
    // ...and a null NI number collapses to an empty field — never the text "null".
    expect(csv).toContain(`weekly,"Ops\nTeam",,`);
    expect(csv).not.toContain("null");
  });
});

describe("computePayeMonth (tax integration)", () => {
  it("returns placeholder when no payroll lines exist", () => {
    const r = computePayeMonth([]);
    expect(r.confidence).toBe("placeholder");
    expect(r.estimate).toBe(0);
  });

  // `gross_pay: 0` in these two cases isolates the EMPLOYEE-side summing and the
  // month filter (zero gross ⇒ zero employer NI). The employer-NI contribution to
  // this liability is covered to the penny in __tests__/tax/compute.test.ts.
  it("sums PAYE + NI for runs in the current month", () => {
    const now = new Date("2026-05-19T00:00:00Z");
    const r = computePayeMonth(
      [
        {
          paye_estimate: 100,
          ni_estimate: 30,
          gross_pay: 0,
          run: { period_start: "2026-05-01", status: "finalised", cycle: "monthly" },
        },
        {
          paye_estimate: 75,
          ni_estimate: 20,
          gross_pay: 0,
          run: { period_start: "2026-05-12", status: "draft", cycle: "weekly" },
        },
        {
          paye_estimate: 999,
          ni_estimate: 999,
          gross_pay: 0,
          // Previous month — excluded
          run: { period_start: "2026-04-01", status: "finalised", cycle: "monthly" },
        },
      ],
      now,
    );
    expect(r.confidence).toBe("computed");
    expect(r.estimate).toBeCloseTo(225, 2);
  });

  it("handles string-encoded numerics from Supabase", () => {
    const now = new Date("2026-05-19T00:00:00Z");
    const r = computePayeMonth(
      [
        {
          paye_estimate: "100.50" as unknown as number,
          ni_estimate: "30.50" as unknown as number,
          // Supabase hands back `numeric` as a string — employer NI must be derived
          // from the string form just as reliably as from a number.
          gross_pay: "0" as unknown as number,
          run: { period_start: "2026-05-01", status: "finalised", cycle: "monthly" },
        },
      ],
      now,
    );
    expect(r.estimate).toBe(131);
  });
});

// ---------------------------------------------------------------------
// Source-pinned architecture — one authoritative CSV escaper
// ---------------------------------------------------------------------

describe("payrollCsv wiring (shared escaper authority)", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const SRC = "lib/payroll/compute.ts";

  it("routes through the one shared csvEscape and defines no local escaper", () => {
    const code = read(SRC);
    expect(code).toMatch(/import \{ csvEscape \} from ["']@\/lib\/csv["']/);
    // The private csvCell copy is gone — no fourth escaper anywhere in the tree.
    expect(code).not.toMatch(/function csvCell/);
    // The quoting body now lives only in lib/csv.ts, never duplicated here.
    expect(code).not.toMatch(/replace\(\/"\/g/);
  });
});
