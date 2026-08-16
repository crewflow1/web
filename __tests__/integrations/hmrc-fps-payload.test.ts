import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  composeFpsReturn,
  RTI_NO_FILING_NOTICE,
  type FpsInputEmployee,
} from "@/lib/integrations/hmrc/rti-fps";

/**
 * HMRC RTI FPS composer (20261156) — field mapping + refusal, as a pure function.
 *
 * Proves the composer folds CrewFlow's stored payroll figures onto the FPS shape
 * correctly WHEN connectable, and refuses WHEN dark. It sets the connectable env
 * locally so the mapping logic can be exercised; the security tier proves the
 * dark refusal against the real (unset) posture.
 */

const CONNECTABLE_ENV = {
  HMRC_CLIENT_ID: "test-client-id",
  HMRC_CLIENT_SECRET: "test-client-secret",
  NEXT_PUBLIC_FEATURE_HMRC_CONNECT: "true",
};

function emp(over: Partial<FpsInputEmployee> = {}): FpsInputEmployee {
  return {
    employeeId: "user-1",
    name: "Alex Mason",
    hoursWorked: 160,
    grossPay: 3000,
    payeDeducted: 400,
    employeeNic: 200,
    netPay: 2400,
    ...over,
  };
}

describe("composeFpsReturn — FPS mapping from stored payroll lines", () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, CONNECTABLE_ENV);
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("maps each employee onto the FPS vocabulary and derives run totals", () => {
    const res = composeFpsReturn({
      payDate: "2026-07-31",
      paymentFrequency: "monthly",
      employer: {
        employerPayeReference: "123/AB456",
        accountsOfficeReference: "123PA00012345",
        name: "Builder Ltd",
      },
      employees: [
        emp(),
        emp({ employeeId: "user-2", name: "Sam Poole", grossPay: 2000, payeDeducted: 250, employeeNic: 140, netPay: 1610 }),
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const p = res.payload;
    expect(p.taxYear).toBe("2026-27"); // pay date 31 Jul 2026 → 2026-27 tax year
    expect(p.payDate).toBe("2026-07-31");
    expect(p.paymentFrequency).toBe("monthly");
    expect(p.employer.employerPayeReference).toBe("123/AB456");
    expect(p.employees).toHaveLength(2);
    expect(p.employees[0]).toMatchObject({
      employeeId: "user-1",
      name: "Alex Mason",
      taxablePay: 3000,
      taxDeducted: 400,
      employeeNic: 200,
      netPay: 2400,
    });
    // Run totals are the sum of the lines (a reconciliation aid).
    expect(p.totals).toEqual({ taxablePay: 5000, taxDeducted: 650, employeeNic: 340, netPay: 4010 });
  });

  it("carries explicit year-to-date cumulatives when supplied", () => {
    const res = composeFpsReturn({
      payDate: "2026-07-31",
      paymentFrequency: "monthly",
      employees: [
        emp({
          grossPay: 3000,
          payeDeducted: 400,
          employeeNic: 200,
          yearToDate: { taxablePay: 12000, taxDeducted: 1600, employeeNic: 800 },
        }),
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.employees[0]!.yearToDate).toEqual({
      taxablePay: 12000,
      taxDeducted: 1600,
      employeeNic: 800,
    });
  });

  it("defaults YTD to THIS period's figures when none is supplied (never invented)", () => {
    const res = composeFpsReturn({
      payDate: "2026-04-30",
      paymentFrequency: "monthly",
      employees: [emp({ grossPay: 3000, payeDeducted: 400, employeeNic: 200 })],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.employees[0]!.yearToDate).toEqual({
      taxablePay: 3000,
      taxDeducted: 400,
      employeeNic: 200,
    });
  });

  it("NEVER asserts the final-submission declaration on the user's behalf", () => {
    const res = composeFpsReturn({
      payDate: "2026-07-31",
      paymentFrequency: "monthly",
      employees: [emp()],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.finalSubmission).toBe(false);
  });

  it("rounds money to 2dp", () => {
    const res = composeFpsReturn({
      payDate: "2026-07-31",
      paymentFrequency: "weekly",
      employees: [emp({ grossPay: 100.005, payeDeducted: 20.004, employeeNic: 10.006, netPay: 70.001 })],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const e = res.payload.employees[0]!;
    expect(e.taxablePay).toBe(100.01);
    expect(e.taxDeducted).toBe(20);
    expect(e.employeeNic).toBe(10.01);
    expect(e.netPay).toBe(70);
  });

  it("derives the tax year across the 5/6 April boundary", () => {
    const before = composeFpsReturn({ payDate: "2026-04-05", paymentFrequency: "monthly", employees: [emp()] });
    const onOrAfter = composeFpsReturn({ payDate: "2026-04-06", paymentFrequency: "monthly", employees: [emp()] });
    expect(before.ok && before.payload.taxYear).toBe("2025-26");
    expect(onOrAfter.ok && onOrAfter.payload.taxYear).toBe("2026-27");
  });

  it("refuses a missing/invalid pay date", () => {
    const res = composeFpsReturn({ payDate: "   ", paymentFrequency: "monthly", employees: [emp()] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid");
  });

  it("refuses an empty employee set (a nil period is an EPS, not an FPS)", () => {
    const res = composeFpsReturn({ payDate: "2026-07-31", paymentFrequency: "monthly", employees: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid");
  });

  it("exposes a no-filing notice that names the recognition gate", () => {
    expect(RTI_NO_FILING_NOTICE).toMatch(/recognition/i);
    expect(RTI_NO_FILING_NOTICE).toMatch(/does not file/i);
  });
});
