/**
 * Tax estimate helpers — pure, server/client-safe.
 *
 * Estimates ONLY. Owners must confirm with their accountant before
 * filing. UK numbers (small Ltd) baked in:
 *   Corporation tax  19% (small profits rate, profit under £50k)
 *                    25% (main rate, profit over £250k)
 *                    Marginal relief between £50k–£250k (approximated)
 *   VAT              already computed from invoice/finance rows
 *   PAYE             PAYE + employee NI + employer NI from payroll runs
 *
 * Every figure carries a `confidence` flag in the calling UI:
 *   'computed' — derived from real CrewFlow data
 *   'placeholder' — needs upstream data we don't have yet
 */

import { employerCostsForStoredLine } from "@/lib/payroll/compute";

const UK_CT_SMALL_RATE = 0.19;
const UK_CT_MAIN_RATE = 0.25;
const UK_CT_SMALL_THRESHOLD = 50_000;
const UK_CT_MAIN_THRESHOLD = 250_000;

export type TaxSummary = {
  vat_quarter: {
    output_vat: number;
    input_vat: number;
    net_payable: number;
    confidence: "computed" | "placeholder";
  };
  paye_month: {
    /**
     * TOTAL estimated payment to HMRC: PAYE + employee NI + EMPLOYER NI. Employer
     * pension is deliberately excluded — it is paid to the pension provider, not
     * to HMRC, so it is not part of this liability.
     */
    estimate: number;
    paye_estimate: number;
    employee_ni_estimate: number;
    employer_ni_estimate: number;
    confidence: "computed" | "placeholder";
    note: string;
  };
  corp_tax_year: {
    estimated_profit: number;
    estimated_tax: number;
    confidence: "computed" | "placeholder";
    rate_applied: number;
  };
};

type InvoiceRow = {
  status: string;
  vat_total: number | string | null;
  total: number | string | null;
  amount: number | string | null;
  paid_at: string | null;
  created_at: string;
};

type FinanceRow = {
  vat_total: number | string | null;
  amount: number | string | null;
  created_at: string;
};

/** Output VAT = sum of vat_total on PAID invoices within the period. */
export function computeVatQuarter(
  invoices: InvoiceRow[],
  finances: FinanceRow[],
  quarterStartIso: string,
): TaxSummary["vat_quarter"] {
  let outputVat = 0;
  for (const inv of invoices) {
    if (
      inv.status === "paid" &&
      inv.paid_at &&
      inv.paid_at >= quarterStartIso
    ) {
      outputVat += Number(inv.vat_total ?? 0);
    }
  }
  let inputVat = 0;
  for (const f of finances) {
    if (f.created_at >= quarterStartIso) {
      inputVat += Number(f.vat_total ?? 0);
    }
  }
  return {
    output_vat: Math.round(outputVat * 100) / 100,
    input_vat: Math.round(inputVat * 100) / 100,
    net_payable: Math.round((outputVat - inputVat) * 100) / 100,
    confidence: "computed",
  };
}

type PayrollLineRow = {
  paye_estimate: number | string | null;
  ni_estimate: number | string | null;
  /**
   * REQUIRED — employer NI is derived from it. Not optional: an omitted gross would
   * silently drop employer NI out of an HMRC liability figure, which is exactly the
   * understatement this fix exists to remove.
   */
  gross_pay: number | string | null;
  run: { period_start: string; status: string; cycle: string } | null;
};

/**
 * PAYE / NI estimate for the current calendar month — what is owed to HMRC.
 *
 * Sums PAYE + employee NI + EMPLOYER NI across every payroll_line whose parent run's
 * period starts in the current month. Returns 'placeholder' confidence when no
 * payroll has been run yet, so the UI can keep the "set this up" affordance until it
 * has real data.
 *
 * Employer secondary NI is a genuine part of the monthly PAYE bill, so leaving it out
 * understated this liability for every org with staff. It is DERIVED from the stored
 * gross via the one shared `employerCostsForStoredLine`, at the rates in force for
 * the run's own period — never re-priced at today's rates.
 *
 * Employer PENSION is intentionally NOT included: it is payable to the pension
 * provider, not to HMRC.
 */
export function computePayeMonth(
  payrollLines: PayrollLineRow[] = [],
  now: Date = new Date(),
): TaxSummary["paye_month"] {
  if (payrollLines.length === 0) {
    return {
      estimate: 0,
      paye_estimate: 0,
      employee_ni_estimate: 0,
      employer_ni_estimate: 0,
      confidence: "placeholder",
      note: "No payroll runs this month. Generate a weekly or monthly payroll in /payroll to populate this tile.",
    };
  }
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let paye = 0;
  let ni = 0;
  let employerNi = 0;
  for (const l of payrollLines) {
    if (!l.run) continue;
    if (l.run.period_start.slice(0, 7) !== monthKey) continue;
    paye += Number(l.paye_estimate ?? 0);
    ni += Number(l.ni_estimate ?? 0);
    const cycle = l.run.cycle === "weekly" ? "weekly" : "monthly";
    employerNi += employerCostsForStoredLine(
      l.gross_pay,
      cycle,
      l.run.period_start,
    ).employer_ni_estimate;
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    estimate: round2(paye + ni + employerNi),
    paye_estimate: round2(paye),
    employee_ni_estimate: round2(ni),
    employer_ni_estimate: round2(employerNi),
    confidence: "computed",
    note: `Estimate: PAYE ${paye.toFixed(2)} + employee NI ${ni.toFixed(2)} + employer NI ${employerNi.toFixed(2)} from this month's payroll runs. Pay HMRC by the 22nd of the following month. Confirm with your accountant before paying — the Employment Allowance may reduce the employer NI due.`,
  };
}

/**
 * Corporation tax — estimate based on annual profit since current
 * year started. Profit = invoiced revenue (net) – finance costs (net),
 * roughly approximating P&L gross margin.
 */
export function computeCorpTaxYear(
  invoices: InvoiceRow[],
  finances: FinanceRow[],
  yearStartIso: string,
): TaxSummary["corp_tax_year"] {
  let revenue = 0;
  for (const inv of invoices) {
    if (inv.created_at >= yearStartIso) {
      revenue += Number(inv.amount ?? 0); // net of VAT
    }
  }
  let costs = 0;
  for (const f of finances) {
    if (f.created_at >= yearStartIso) {
      costs += Number(f.amount ?? 0);
    }
  }
  const estimatedProfit = Math.max(0, revenue - costs);
  let estimatedTax: number;
  let rate: number;
  if (estimatedProfit <= UK_CT_SMALL_THRESHOLD) {
    estimatedTax = estimatedProfit * UK_CT_SMALL_RATE;
    rate = UK_CT_SMALL_RATE;
  } else if (estimatedProfit >= UK_CT_MAIN_THRESHOLD) {
    estimatedTax = estimatedProfit * UK_CT_MAIN_RATE;
    rate = UK_CT_MAIN_RATE;
  } else {
    // Linear marginal relief between thresholds — approximation.
    const fraction = (estimatedProfit - UK_CT_SMALL_THRESHOLD) /
      (UK_CT_MAIN_THRESHOLD - UK_CT_SMALL_THRESHOLD);
    rate = UK_CT_SMALL_RATE + fraction * (UK_CT_MAIN_RATE - UK_CT_SMALL_RATE);
    estimatedTax = estimatedProfit * rate;
  }
  return {
    estimated_profit: Math.round(estimatedProfit * 100) / 100,
    estimated_tax: Math.round(estimatedTax * 100) / 100,
    confidence: "computed",
    rate_applied: Math.round(rate * 10_000) / 100, // % to 2dp
  };
}

/** Start of the calendar quarter containing `now`. */
export function startOfQuarterIso(now: Date = new Date()): string {
  const q = Math.floor(now.getUTCMonth() / 3);
  return new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1))
    .toISOString()
    .slice(0, 10);
}

/** Start of the UK tax year containing `now` (6 April). */
export function startOfTaxYearIso(now: Date = new Date()): string {
  const taxYearStartMonth = 3; // April (0-indexed)
  const taxYearStartDay = 6;
  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), taxYearStartMonth, taxYearStartDay),
  );
  if (now.getTime() < candidate.getTime()) {
    candidate.setUTCFullYear(now.getUTCFullYear() - 1);
  }
  return candidate.toISOString().slice(0, 10);
}
