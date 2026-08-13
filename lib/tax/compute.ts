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
 * One row of the invoice_payments LEDGER — a single payment against an invoice,
 * carrying the parent invoice's VAT-relevant figures (resolved by the caller).
 *
 * This is the CASH-BASIS output-VAT source, and it REPLACES the coarse
 * `invoice.status === "paid"` flag. The payment trigger stamps `invoices.paid_at`
 * only when an invoice flips FULLY to 'paid': a `partially_paid` invoice keeps
 * status≠'paid' and paid_at=NULL, so a status-gated sum contributed £0 for the
 * quarter the cash was actually received — understating boxes 1 and 6. Reading
 * the ledger instead captures every payment (deposits, instalments spanning
 * quarters, never-fully-paid invoices) on the date the cash landed.
 */
export type InvoicePaymentRow = {
  /** invoice_payments.amount — the cash received in this payment (VAT-inclusive). */
  amount: number | string | null;
  /** invoice_payments.paid_at — the date the cash was received (the cash-basis date). */
  paid_at: string | null;
  /** The parent invoice's vat_total — whole-invoice output VAT. */
  invoice_vat_total: number | string | null;
  /** The parent invoice's amount — net of VAT. */
  invoice_amount: number | string | null;
  /** The parent invoice's total — GROSS (net + VAT); the apportionment denominator. */
  invoice_total: number | string | null;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The single VAT authority — CASH-basis output VAT from the invoice_payments
 * LEDGER, ACCRUAL-basis input VAT from logged finance rows, over the quarter
 * `[quarterStartIso, quarterEndIso)`.
 *
 * The lower bound is INCLUSIVE; the optional upper bound is EXCLUSIVE. ALWAYS
 * pass the exclusive end (start of the next quarter — see
 * `endOfQuarterExclusiveIso`) so a future-dated `paid_at` / `created_at` (e.g. a
 * post-dated cheque) cannot leak a LATER quarter's VAT into this one. The
 * parameter is optional only for backwards compatibility; every live consumer
 * passes it, and omitting it degrades to open-ended `iso >= quarterStart` with
 * no upper bound — do not rely on that.
 *
 * OUTPUT VAT (box 1) is CASH and PAYMENT-LEDGER-DRIVEN. For each payment in the
 * window it adds `amount × (invoice.vat_total / invoice.total)` — the payment's
 * proportional share of the invoice's VAT — so a partial payment contributes the
 * VAT on the cash actually received, not £0 and not the whole invoice. INPUT VAT
 * (box 4) is ACCRUAL (all logged costs).
 *
 * DOMESTIC REVERSE CHARGE (S55A VATA94). When the org is the contractor/recipient
 * of a CIS domestic reverse-charge supply it self-accounts the notional VAT: the
 * SAME figure enters BOX 1 (output) AND BOX 4 (input), so box 5 net is neutral.
 * That figure is the frozen ledger total (Σ supplier_payment_allocations
 * .cis_reverse_charge_vat over the window) computed by the SERVICE layer and
 * passed in as `reverseChargeVat` — this pure function never re-derives it, so
 * there is one and only one reverse-charge engine (lib/cis/deduction.ts + the DB).
 *
 * The dashboard tile, the quarterly PDF, the HMRC 9-box composer AND the /cash
 * outflow surface (lib/commercial/cash-out) all read THIS function on the SAME
 * bounded window — there is no second calculator and no divergent window.
 */
export function computeVatQuarter(
  invoicePayments: InvoicePaymentRow[],
  finances: FinanceRow[],
  quarterStartIso: string,
  quarterEndIso?: string,
  reverseChargeVat = 0,
): TaxSummary["vat_quarter"] {
  const inPeriod = (iso: string): boolean =>
    iso >= quarterStartIso &&
    (quarterEndIso === undefined || iso < quarterEndIso);
  // Box 1 — output VAT on the CASH received in the window, apportioned per payment.
  let outputVat = 0;
  for (const p of invoicePayments) {
    if (!p.paid_at || !inPeriod(p.paid_at)) continue;
    const total = Number(p.invoice_total ?? 0);
    // Guard divide-by-zero / NaN: a £0-total invoice has no VAT to apportion.
    if (!Number.isFinite(total) || total <= 0) continue;
    const amount = Number(p.amount ?? 0);
    const vatTotal = Number(p.invoice_vat_total ?? 0);
    outputVat += amount * (vatTotal / total);
  }
  // Box 4 — input VAT on all logged costs in the window.
  let inputVat = 0;
  for (const f of finances) {
    if (inPeriod(f.created_at)) {
      inputVat += Number(f.vat_total ?? 0);
    }
  }
  // Domestic reverse charge: the notional VAT is BOTH output and input, so the
  // net (box 5) is unchanged — it only surfaces the liability in boxes 1 and 4.
  const rc = Number.isFinite(reverseChargeVat) ? reverseChargeVat : 0;
  outputVat += rc;
  inputVat += rc;
  return {
    output_vat: round2(outputVat),
    input_vat: round2(inputVat),
    net_payable: round2(outputVat - inputVat),
    confidence: "computed",
  };
}

/**
 * MTD VAT boxes 6/7 — the total ex-VAT VALUE of the sales and purchases whose VAT
 * feeds boxes 1 and 4. These are MANDATORY on every UK VAT scheme (not EU-only
 * like boxes 8/9), and they ARE derivable from CrewFlow's own data.
 *
 * Computed over the SAME `[quarterStartIso, quarterEndIso)` window and the SAME
 * predicates as computeVatQuarter:
 *   • BOX 6 (sales) sums each payment's proportional NET share
 *     `amount × (invoice.amount / invoice.total)` from the invoice_payments
 *     ledger — the CASH-basis net that backs box 1. Reverse-charge purchases are
 *     PURCHASES, not sales, so they never enter box 6.
 *   • BOX 7 (purchases) sums the net `amount` of the finance rows whose
 *     `vat_total` feeds box 4 (ACCRUAL basis), PLUS the net (ex-VAT) value of
 *     domestic reverse-charge purchases (`reverseChargeNet`). HMRC includes
 *     reverse-charge purchases in box 7 but EXCLUDES them from box 6.
 *
 * So the reported net totals reconcile with the VAT boxes — same set, same
 * window, one authority. Values are the raw ex-VAT sums (rounded to 2dp to match
 * this authority's output shape); the composer applies HMRC's whole-pound
 * rounding for boxes 6-9, mirroring how boxes 1/4 sum raw then round.
 */
export function computeVatNetTotals(
  invoicePayments: InvoicePaymentRow[],
  finances: FinanceRow[],
  quarterStartIso: string,
  quarterEndIso?: string,
  reverseChargeNet = 0,
): { totalValueSalesExVAT: number; totalValuePurchasesExVAT: number } {
  const inPeriod = (iso: string): boolean =>
    iso >= quarterStartIso &&
    (quarterEndIso === undefined || iso < quarterEndIso);
  let sales = 0;
  for (const p of invoicePayments) {
    if (!p.paid_at || !inPeriod(p.paid_at)) continue;
    const total = Number(p.invoice_total ?? 0);
    if (!Number.isFinite(total) || total <= 0) continue;
    const amount = Number(p.amount ?? 0);
    const net = Number(p.invoice_amount ?? 0);
    sales += amount * (net / total); // this payment's net (ex-VAT) share
  }
  let purchases = 0;
  for (const f of finances) {
    if (inPeriod(f.created_at)) {
      purchases += Number(f.amount ?? 0); // net of VAT
    }
  }
  // Box 7 (NOT box 6) carries the net value of reverse-charge purchases.
  const rcNet = Number.isFinite(reverseChargeNet) ? reverseChargeNet : 0;
  purchases += rcNet;
  return {
    totalValueSalesExVAT: round2(sales),
    totalValuePurchasesExVAT: round2(purchases),
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
