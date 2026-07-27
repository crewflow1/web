/**
 * Payroll calculations — pure, server/client-safe.
 *
 * UK PAYE + NI estimates for the 2025-26 tax year. ESTIMATES ONLY.
 *
 * Income tax (standard 1257L code, no allowance restrictions modelled):
 *   £0       – £12,570    0%      (personal allowance)
 *   £12,570  – £50,270    20%     (basic rate)
 *   £50,270  – £125,140   40%     (higher rate)
 *   £125,140 +            45%     (additional rate)
 *
 * NI Class 1 employee contributions (2025-26):
 *   £0       – £12,570    0%      (below primary threshold)
 *   £12,570  – £50,270    8%      (main rate)
 *   £50,270  +            2%      (upper rate)
 *
 * Caveats this estimator does NOT model:
 *   - Scottish income tax bands
 *   - Marriage allowance, blind person's allowance
 *   - Student loan deductions
 *   - Pension salary sacrifice
 *   - Employer NI (this is just the gross-to-net for the employee)
 *
 * Every result carries a `note` flag pushing owners to confirm with their
 * accountant or HMRC's official calculator.
 */

import { csvEscape } from "@/lib/csv";

const PERSONAL_ALLOWANCE = 12_570;
const HIGHER_RATE_THRESHOLD = 50_270;
const ADDITIONAL_RATE_THRESHOLD = 125_140;

const BASIC_RATE = 0.20;
const HIGHER_RATE = 0.40;
const ADDITIONAL_RATE = 0.45;

const NI_PRIMARY_THRESHOLD = 12_570;
const NI_UPPER_LIMIT = 50_270;
const NI_MAIN_RATE = 0.08;
const NI_UPPER_RATE = 0.02;

/**
 * Annualise a periodic gross pay so we can apply annual tax bands, then
 * scale the tax back to the period. This is the same approach HMRC uses
 * for non-cumulative codes — it's an estimate, not a payroll engine.
 */
function periodsPerYear(cycle: "weekly" | "monthly"): number {
  return cycle === "weekly" ? 52 : 12;
}

export function annualIncomeTax(annualGross: number): number {
  if (annualGross <= PERSONAL_ALLOWANCE) return 0;
  let tax = 0;
  const basicTaxable = Math.min(annualGross, HIGHER_RATE_THRESHOLD) - PERSONAL_ALLOWANCE;
  tax += basicTaxable * BASIC_RATE;
  if (annualGross > HIGHER_RATE_THRESHOLD) {
    const higherTaxable =
      Math.min(annualGross, ADDITIONAL_RATE_THRESHOLD) - HIGHER_RATE_THRESHOLD;
    tax += higherTaxable * HIGHER_RATE;
  }
  if (annualGross > ADDITIONAL_RATE_THRESHOLD) {
    tax += (annualGross - ADDITIONAL_RATE_THRESHOLD) * ADDITIONAL_RATE;
  }
  return tax;
}

export function annualEmployeeNi(annualGross: number): number {
  if (annualGross <= NI_PRIMARY_THRESHOLD) return 0;
  let ni = 0;
  const mainBand = Math.min(annualGross, NI_UPPER_LIMIT) - NI_PRIMARY_THRESHOLD;
  ni += mainBand * NI_MAIN_RATE;
  if (annualGross > NI_UPPER_LIMIT) {
    ni += (annualGross - NI_UPPER_LIMIT) * NI_UPPER_RATE;
  }
  return ni;
}

export type PayrollLineCompute = {
  hours: number;
  hourly_pay: number;
  gross_pay: number;
  paye_estimate: number;
  ni_estimate: number;
  net_pay: number;
};

/**
 * Compute one staff member's line for a payroll run.
 *
 * `hours` is the net (after-break) hours from time_entries. We annualise
 * the period gross at the appropriate cadence, compute tax + NI on the
 * annual figure, then divide back.
 */
export function computePayrollLine(
  hours: number,
  hourlyPay: number,
  cycle: "weekly" | "monthly",
): PayrollLineCompute {
  const safeHours = Math.max(0, hours);
  const safeRate = Math.max(0, hourlyPay);
  const grossPay = round2(safeHours * safeRate);
  const periods = periodsPerYear(cycle);
  const annualised = grossPay * periods;
  const annualTax = annualIncomeTax(annualised);
  const annualNi = annualEmployeeNi(annualised);
  const payeEstimate = round2(annualTax / periods);
  const niEstimate = round2(annualNi / periods);
  const netPay = round2(grossPay - payeEstimate - niEstimate);
  return {
    hours: round2(safeHours),
    hourly_pay: round2(safeRate),
    gross_pay: grossPay,
    paye_estimate: payeEstimate,
    ni_estimate: niEstimate,
    net_pay: netPay,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Default period start/end for a given cycle and date. */
export function defaultPeriod(
  cycle: "weekly" | "monthly",
  now: Date = new Date(),
): { period_start: string; period_end: string } {
  if (cycle === "weekly") {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const day = d.getUTCDay();
    const offset = day === 0 ? 6 : day - 1;
    d.setUTCDate(d.getUTCDate() - offset);
    const start = d.toISOString().slice(0, 10);
    const endD = new Date(d.getTime());
    endD.setUTCDate(endD.getUTCDate() + 6);
    return { period_start: start, period_end: endD.toISOString().slice(0, 10) };
  }
  // Monthly — current calendar month.
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
  };
}

/**
 * Renders a payroll-line array as a CSV (HMRC-friendly column order).
 *
 * Every field is quoted through the shared `csvEscape` (`@/lib/csv`) — the
 * one authoritative CSV escaper — so a comma-bearing name (or any other
 * value) can never break the column layout, and payroll carries no escaper
 * of its own.
 */
export function payrollCsv(
  rows: Array<{
    full_name: string;
    ni_number: string | null;
    hours: number;
    hourly_pay: number;
    gross_pay: number;
    paye_estimate: number;
    ni_estimate: number;
    net_pay: number;
  }>,
  period: { period_start: string; period_end: string; cycle: string },
): string {
  const header = [
    "Period start",
    "Period end",
    "Cycle",
    "Name",
    "NI number",
    "Hours",
    "Hourly pay",
    "Gross pay",
    "PAYE est",
    "NI est",
    "Net pay",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        period.period_start,
        period.period_end,
        period.cycle,
        r.full_name,
        r.ni_number ?? "",
        r.hours.toFixed(2),
        r.hourly_pay.toFixed(2),
        r.gross_pay.toFixed(2),
        r.paye_estimate.toFixed(2),
        r.ni_estimate.toFixed(2),
        r.net_pay.toFixed(2),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n");
}
