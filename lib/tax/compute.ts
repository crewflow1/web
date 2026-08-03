/**
 * Tax estimate helpers — pure, server/client-safe.
 *
 * Estimates ONLY. Owners must confirm with their accountant before
 * filing. UK numbers (small Ltd) baked in:
 *   Corporation tax  19% (small profits rate, profit under £50k)
 *                    25% (main rate, profit over £250k)
 *                    HMRC marginal relief between £50k–£250k
 *                    (tax = profit×25% − (£250k − profit)×3/200, FY2023+)
 *   VAT              already computed from invoice/finance rows
 *   PAYE             PAYE + employee NI + employer NI from payroll runs
 *
 * Every figure carries a `confidence` flag in the calling UI:
 *   'computed' — derived from real CrewFlow data
 *   'placeholder' — needs upstream data we don't have yet
 */

import { employerCostsForStoredLine } from "@/lib/payroll/compute";
import { isIssuedStatus } from "@/lib/invoices/schema";

const UK_CT_SMALL_RATE = 0.19;
const UK_CT_MAIN_RATE = 0.25;
const UK_CT_SMALL_THRESHOLD = 50_000;
const UK_CT_MAIN_THRESHOLD = 250_000;
/**
 * HMRC's standard marginal relief fraction for financial years 2023 onward
 * (3/200 = 0.015). Marginal relief reduces the 25% main-rate charge for profits
 * between the two thresholds. See HMRC "Marginal Relief for Corporation Tax".
 */
const UK_CT_MARGINAL_FRACTION = 3 / 200;

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

/**
 * The single VAT authority — output VAT on PAID invoices, input VAT on logged
 * finance rows, over the quarter `[quarterStartIso, quarterEndIso)`.
 *
 * The lower bound is INCLUSIVE; the optional upper bound is EXCLUSIVE. Pass the
 * exclusive end (start of the next quarter — see `endOfQuarterExclusiveIso`) so a
 * future-dated `paid_at` / `created_at` cannot leak a LATER quarter's VAT into
 * this one. Omitting it preserves the historical open-ended behaviour
 * (everything on/after the start), which the cash-out consumer still relies on.
 *
 * Basis is disclosed and deliberate: output VAT is CASH (paid invoices), input
 * VAT is ACCRUAL (all logged costs). The dashboard tile, the quarterly PDF and
 * the HMRC 9-box composer all read THIS function — there is no second calculator.
 */
export function computeVatQuarter(
  invoices: InvoiceRow[],
  finances: FinanceRow[],
  quarterStartIso: string,
  quarterEndIso?: string,
): TaxSummary["vat_quarter"] {
  const inPeriod = (iso: string): boolean =>
    iso >= quarterStartIso &&
    (quarterEndIso === undefined || iso < quarterEndIso);
  let outputVat = 0;
  for (const inv of invoices) {
    if (inv.status === "paid" && inv.paid_at && inPeriod(inv.paid_at)) {
      outputVat += Number(inv.vat_total ?? 0);
    }
  }
  let inputVat = 0;
  for (const f of finances) {
    if (inPeriod(f.created_at)) {
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
 *
 * Revenue counts ONLY ISSUED invoices (see ISSUED_INVOICE_STATUSES): `draft`
 * invoices are never-issued and carry the schema/new-invoice default status while
 * still holding real line amounts, so including them would count every unsent
 * invoice as revenue and overstate profit — and the tax due — for essentially
 * every org. This keeps the estimate on the "Invoiced · accrual" basis the page
 * declares. Basis matches computeVatQuarter's disclosed treatment.
 */
export function computeCorpTaxYear(
  invoices: InvoiceRow[],
  finances: FinanceRow[],
  yearStartIso: string,
): TaxSummary["corp_tax_year"] {
  let revenue = 0;
  for (const inv of invoices) {
    if (inv.created_at >= yearStartIso && isIssuedStatus(inv.status)) {
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
    // HMRC marginal relief (single company, full 12-month accounting period, no
    // associated companies, no franked investment income — the case this
    // estimator already assumes): charge the full 25% main rate, then subtract
    //   MR = (upper limit − profit) × standard fraction (3/200).
    // At £50k this equals a flat 19%; at £250k relief is nil (flat 25%); it is
    // continuous at both boundaries. `rate` is the resulting EFFECTIVE rate.
    const marginalRelief =
      (UK_CT_MAIN_THRESHOLD - estimatedProfit) * UK_CT_MARGINAL_FRACTION;
    estimatedTax = estimatedProfit * UK_CT_MAIN_RATE - marginalRelief;
    rate = estimatedTax / estimatedProfit;
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

/**
 * EXCLUSIVE upper bound for a quarter: the first day of the NEXT quarter after
 * the one starting at `quarterStartIso`. Feed this to `computeVatQuarter` so a
 * future-dated payment cannot leak into the current quarter, and to keep the
 * dashboard tile, the PDF working paper and the HMRC composer on one boundary.
 */
export function endOfQuarterExclusiveIso(quarterStartIso: string): string {
  const d = new Date(quarterStartIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1))
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
