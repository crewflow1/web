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
 *     `vat_total` feeds box 4 (ACCRUAL basis). A domestic reverse-charge purchase
 *     bill IS one of those finance rows (its net is `amount`, its `vat_total` is 0
 *     because the supplier charges no VAT), so the finances loop ALREADY carries
 *     its net value into box 7 — exactly once. HMRC includes reverse-charge
 *     purchases in box 7 but EXCLUDES them from box 6 (a purchase is never a sale).
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
      // Net of VAT. Reverse-charge purchase bills are finance rows too, so their
      // net enters box 7 HERE — once — with every other purchase. No separate add.
      purchases += Number(f.amount ?? 0);
    }
  }
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
  /**
   * Optional annual salary sacrifice (£) for this line's employee. Sacrifice is
   * outside employer NI, so it reduces the HMRC liability. Absent ⇒ no sacrifice,
   * employer NI byte-identical to before.
   */
  salary_sacrifice_annual?: number | null;
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
      l.salary_sacrifice_annual ?? undefined,
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

/**
 * VAT RETURN PERIOD SELECTION — the SINGLE place the [start, end) window fed to
 * `computeVatQuarter` is derived. This is period SELECTION, not VAT arithmetic:
 * `computeVatQuarter` remains the one and only VAT calculator; these helpers
 * only pick WHICH window it sums over, driven by the org's HMRC stagger.
 *
 * HMRC assigns every VAT-registered business one of three quarterly "staggers"
 * (or monthly returns):
 *   group_1  periods END Mar/Jun/Sep/Dec  → START Jan/Apr/Jul/Oct  (calendar quarter)
 *   group_2  periods END Apr/Jul/Oct/Jan  → START Feb/May/Aug/Nov
 *   group_3  periods END Feb/May/Aug/Nov  → START Dec/Mar/Jun/Sep
 *   monthly  one calendar month per return
 *
 * `group_1` is the DEFAULT and is byte-for-byte the previous calendar-quarter
 * behaviour, so an org that never sets a stagger sees no change.
 */
export const VAT_STAGGERS = ["group_1", "group_2", "group_3", "monthly"] as const;
export type VatStagger = (typeof VAT_STAGGERS)[number];

/** The default stagger: HMRC group 1 == the calendar quarter (unchanged behaviour). */
export const DEFAULT_VAT_STAGGER: VatStagger = "group_1";

/** Narrow an unknown/stored value to a VatStagger, falling back to the default. */
export function normalizeVatStagger(value: unknown): VatStagger {
  return (VAT_STAGGERS as readonly string[]).includes(value as string)
    ? (value as VatStagger)
    : DEFAULT_VAT_STAGGER;
}

/** Months in one VAT return period for a stagger (quarters = 3, monthly = 1). */
function vatPeriodMonths(stagger: VatStagger): number {
  return stagger === "monthly" ? 1 : 3;
}

/**
 * The calendar-month phase each stagger's periods begin on, modulo the period
 * length. group_1 starts Jan/Apr/Jul/Oct (phase 0), group_2 starts
 * Feb/May/Aug/Nov (phase 1), group_3 starts Dec/Mar/Jun/Sep (phase 2), monthly
 * every month (phase 0).
 */
function vatStaggerPhase(stagger: VatStagger): number {
  switch (stagger) {
    case "group_1":
      return 0;
    case "group_2":
      return 1;
    case "group_3":
      return 2;
    case "monthly":
      return 0;
  }
}

/**
 * Start (YYYY-MM-DD, inclusive) of the VAT return period containing `now` for
 * the given stagger. Date.UTC absorbs a negative month (e.g. group_3 in January
 * belongs to the Dec–Feb period, which starts the prior December).
 */
export function startOfVatPeriodIso(
  stagger: VatStagger = DEFAULT_VAT_STAGGER,
  now: Date = new Date(),
): string {
  const months = vatPeriodMonths(stagger);
  const phase = vatStaggerPhase(stagger);
  const m = now.getUTCMonth();
  // How many months `now` sits past its period's start month.
  const offset = (((m - phase) % months) + months) % months;
  return new Date(Date.UTC(now.getUTCFullYear(), m - offset, 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * EXCLUSIVE upper bound of the VAT period that starts at `periodStartIso` for
 * the given stagger: the first day of the NEXT period. Feed this to
 * `computeVatQuarter` so a future-dated payment cannot leak in, keeping the
 * tile, PDF, HMRC composer and /cash on one boundary.
 */
export function endOfVatPeriodExclusiveIso(
  periodStartIso: string,
  stagger: VatStagger = DEFAULT_VAT_STAGGER,
): string {
  const d = new Date(periodStartIso);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + vatPeriodMonths(stagger), 1),
  )
    .toISOString()
    .slice(0, 10);
}

/**
 * Start of the calendar quarter containing `now`.
 *
 * Backward-compatible thin wrapper over the stagger-aware selector (group_1 ==
 * calendar quarter). Existing callers that do not know about staggers keep the
 * exact previous behaviour; stagger-aware callers use `startOfVatPeriodIso`.
 */
export function startOfQuarterIso(now: Date = new Date()): string {
  return startOfVatPeriodIso(DEFAULT_VAT_STAGGER, now);
}

/**
 * EXCLUSIVE upper bound for a quarter: the first day of the NEXT quarter after
 * the one starting at `quarterStartIso`. Feed this to `computeVatQuarter` so a
 * future-dated payment cannot leak into the current quarter, and to keep the
 * dashboard tile, the PDF working paper and the HMRC composer on one boundary.
 *
 * Backward-compatible thin wrapper over `endOfVatPeriodExclusiveIso` (group_1).
 */
export function endOfQuarterExclusiveIso(quarterStartIso: string): string {
  return endOfVatPeriodExclusiveIso(quarterStartIso, DEFAULT_VAT_STAGGER);
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
