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

export type FinanceRow = {
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
  /**
   * True when the parent invoice is a domestic-reverse-charge SALE. RC supplies are
   * excluded from FRS flat-rate turnover (VAT Notice 733 §7.3). Absent/false ⇒
   * ordinary sale. Currently always absent (sales-side RC is not yet modelled).
   */
  reverse_charge?: boolean;
};

/**
 * One row of the supplier_payment_allocations LEDGER — a single payment
 * ALLOCATION against a supplier bill (a `finances` row), carrying the parent
 * bill's VAT-relevant figures (resolved by the caller).
 *
 * This is the CASH-BASIS INPUT-VAT source (CF-1). Under the UK VAT Cash
 * Accounting Scheme input tax, like output tax, is accounted for on the basis of
 * PAYMENTS — you may only reclaim input VAT on a purchase invoice once you have
 * actually PAID it. Reading the allocation ledger captures the VAT on the cash
 * you paid, on the date it left, exactly mirroring how `InvoicePaymentRow`
 * captures output VAT on the cash you received. The apportionment denominator is
 * the bill's GROSS (net + VAT), so a partial settlement reclaims the VAT on the
 * cash actually paid — not £0 and not the whole bill.
 *
 * The caller MUST pass only allocations belonging to LIVE (non-voided) payments,
 * enriched with the parent bill's `vat_total` and gross `total` — the same
 * discipline `InvoicePaymentRow` requires on the sales side.
 */
export type SupplierPaymentLedgerRow = {
  /**
   * supplier_payment_allocations.amount — the GROSS (VAT-inclusive) value this
   * payment settled against the bill. CIS withholding NEVER reduces it (a bill is
   * settled in full even when part of the cash was withheld for HMRC), so a
   * settled CIS bill correctly reclaims its full input VAT.
   */
  amount: number | string | null;
  /** supplier_payments.paid_at — the date the cash was paid (the cash-basis date). */
  paid_at: string | null;
  /** The parent bill's vat_total — whole-bill input VAT. */
  bill_vat_total: number | string | null;
  /** The parent bill's GROSS value (finances.amount net + vat_total); the apportionment denominator. */
  bill_total: number | string | null;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ===========================================================================
// VAT SCHEME + FLAT RATE SCHEME (FRS)
//
// The org's chosen VAT accounting scheme branches OUTPUT VAT inside the ONE
// authority below — it does not add a second calculator. Two dimensions:
//
//   1. OUTPUT-VAT BASIS (`VatScheme`):
//        • "cash"     — output VAT falls due when the CASH is received (the
//                       invoice_payments ledger). This is the EXISTING behaviour
//                       and the DEFAULT, so an org that never opts in is byte-for-
//                       byte unchanged.
//        • "standard" — output VAT falls due at the invoice TAX POINT (accrual):
//                       every ISSUED invoice dated in the window, whether or not it
//                       has been paid.
//
//      INPUT VAT (box 4) mirrors the output basis (CF-1):
//        • "standard" — input VAT is ACCRUAL: the VAT on every logged cost
//                       (`finances`) whose tax point (created_at) is in the window.
//        • "cash"     — input VAT is CASH: the VAT on bills actually PAID in the
//                       window, read from the supplier_payment_allocations ledger
//                       (`VatComputeOptions.supplierPayments`). UK Cash Accounting
//                       accounts for BOTH legs on payments, so an unpaid purchase
//                       invoice may NOT be reclaimed early. When no supplier-payment
//                       ledger is supplied the cash path FALLS BACK to the accrual
//                       `finances` sum, so an existing caller that has not yet wired
//                       the ledger is byte-for-byte unchanged (never silently £0).
//
//   2. FLAT RATE SCHEME (`FlatRateApplied`). When FRS is in force for the period
//      the box-1 VAT is NOT the sum of per-line output VAT; it is a single flat
//      percentage applied to the period's GROSS (VAT-inclusive) flat-rate
//      turnover, and input VAT is NOT reclaimed (box 4 = 0, bar capital assets
//      > £2,000 which are out of scope). The flat percentage is resolved by the
//      pure resolver below from the sector %, the 1% first-year discount, and the
//      limited-cost-trader 16.5% flag.
//
//      LIMITED COST IS AN EXPLICIT DECLARATION, NEVER AN INFERENCE. The HMRC
//      limited-cost test compares VAT-inclusive spend on *relevant goods* (goods
//      only — services, subcontractor labour, rent, software, fuel are excluded)
//      against turnover. CrewFlow's finance rows carry NO goods/services split, so
//      any auto-derived "goods" figure would inflate the goods total for a
//      services-heavy trader, wrongly clear the test, apply the LOWER sector rate,
//      and UNDER-DECLARE box 1 to HMRC. A silent inference must never push a filed
//      figure toward under-declaration. So limited-cost status is a user
//      declaration (`yes`/`no`); when left `unset` the FILED return takes the
//      CONSERVATIVE 16.5% (biased toward over-, never under-declaration) and the
//      surface prompts the org to declare it.
//
//      Domestic reverse charge is accounted OUTSIDE FRS (HMRC VAT Notice 733
//      §7.3): RC supplies are excluded from flat-rate turnover, and the notional
//      VAT still enters boxes 1 AND 4 equally, so it stays net-neutral.
// ===========================================================================

/** The org-level VAT output-basis scheme. `cash` is the default = existing behaviour. */
export const VAT_SCHEMES = ["cash", "standard"] as const;
export type VatScheme = (typeof VAT_SCHEMES)[number];

/** DEFAULT scheme — cash-basis output VAT, byte-for-byte the pre-scheme behaviour. */
export const DEFAULT_VAT_SCHEME: VatScheme = "cash";

/** Narrow an unknown/stored value to a VatScheme, falling back to the default (cash). */
export function normalizeVatScheme(value: unknown): VatScheme {
  return (VAT_SCHEMES as readonly string[]).includes(value as string)
    ? (value as VatScheme)
    : DEFAULT_VAT_SCHEME;
}

/**
 * One ISSUED invoice as the ACCRUAL (standard-scheme) output-VAT source, keyed on
 * its tax point (the invoice date). Only `isIssuedStatus` invoices count — a draft
 * is not a tax point. Structurally a subset the service builds from `invoices`.
 */
export type AccrualInvoiceRow = {
  /** invoices.status — filtered through isIssuedStatus (drafts never create a tax point). */
  status: string;
  /** The invoice tax point (invoice date). CrewFlow uses invoices.created_at. */
  tax_point: string | null;
  /** invoices.vat_total — the whole-invoice output VAT (→ box 1, accrual). */
  vat_total: number | string | null;
  /** invoices.amount — net of VAT (→ box 6, accrual). */
  amount: number | string | null;
  /** invoices.total — GROSS (net + VAT); the FRS flat-rate turnover base. */
  total: number | string | null;
  /**
   * True when this is a domestic-reverse-charge SALE (the customer accounts for
   * the VAT). RC supplies sit OUTSIDE FRS flat-rate turnover (VAT Notice 733 §7.3),
   * so a flagged row is excluded from grossTurnover. Absent/false ⇒ ordinary sale.
   * (CrewFlow does not yet model RC on the sales invoice, so this is currently
   * always absent — the guard is forward-safe and byte-neutral for real data.)
   */
  reverse_charge?: boolean;
};

/** The resolved FRS position for a period — passed into the authority when FRS is on. */
export type FlatRateApplied = {
  /** Whether FRS is in force for this return period (effective-date + enabled gated). */
  applies: boolean;
  /** The resolved flat percentage AFTER the LCT override and first-year discount, e.g. 8.5. */
  effectivePercent: number;
};

/** Options that branch the ONE VAT authority. All optional; absent ⇒ unchanged cash-basis. */
export type VatComputeOptions = {
  /** Output-VAT basis. Default `cash` (existing behaviour). */
  scheme?: VatScheme;
  /** ISSUED invoices for the window — REQUIRED for `standard` output VAT; ignored for `cash`. */
  accrualInvoices?: AccrualInvoiceRow[];
  /** When present and `applies`, box 1 is the flat calculation and box 4 drops the input reclaim. */
  flatRate?: FlatRateApplied;
  /**
   * Supplier-payment ALLOCATION ledger for the window (LIVE payments only, NON
   * reverse-charge, enriched with each parent bill's VAT figures). Under the `cash`
   * scheme this is the cash-basis INPUT source: box 4 (VAT) and box 7 (net) become
   * the values on bills actually PAID in the window (CF-1). Ignored under `standard`
   * (input stays accrual) and under FRS (box 4 = 0, box 7 = 0). When `undefined`
   * under `cash`, box 4/7 FALL BACK to the accrual `finances` sums — so an unwired
   * caller is unchanged, never silently £0.
   *
   * REVERSE CHARGE IS EXCLUDED from this ledger: RC supplies sit OUTSIDE the cash
   * accounting scheme (VAT Notice 731 §5.1), so their notional VAT (boxes 1/4, via
   * `reverseChargeVat`) and net (box 7, via `reverseChargeNet`) stay on the invoice
   * tax-point basis — keeping the C73-A "one quarter" reconciliation intact.
   */
  supplierPayments?: SupplierPaymentLedgerRow[];
  /**
   * The reverse-charge PURCHASE net (box 7) for the window, on the tax-point
   * (`finances.created_at`) basis — the RC counterpart of `reverseChargeVat`. Used
   * ONLY on the `cash` box-7 path (where the accrual `finances` loop that would
   * otherwise carry RC net is bypassed) so reverse-charge purchases still reach box
   * 7 exactly once, on the SAME basis as their notional VAT. Ignored under
   * `standard` (RC net is already in the `finances` sum) and FRS (box 7 = 0).
   */
  reverseChargeNet?: number;
};

// --- FRS rate constants (HMRC VAT Notice 733) ------------------------------

/** Limited-cost trader flat rate — the CONSERVATIVE rate used when LCT is declared/unset. */
export const FRS_LIMITED_COST_PERCENT = 16.5;
/** First-year-of-registration discount — 1 percentage point off the applicable rate. */
export const FRS_FIRST_YEAR_DISCOUNT_PERCENT = 1;

/**
 * The user's limited-cost-trader declaration. This is NOT auto-derived: CrewFlow's
 * finance rows carry no goods/services split, so inferring it would risk applying
 * the LOWER sector rate and UNDER-declaring VAT (see the section header). The org
 * declares it; `unset` is the safe default that files at the conservative 16.5%.
 */
export type LimitedCostDeclaration = "yes" | "no" | "unset";

/**
 * The stored FRS configuration for an org. Absent/disabled ⇒ FRS never applies and
 * numbers are unchanged.
 */
export type FlatRateSchemeConfig = {
  /** Master switch. false ⇒ FRS never applies (default), org stays on scheme output VAT. */
  enabled: boolean;
  /** The org's HMRC FRS sector percentage (e.g. 9.5). Ignored when limited-cost applies (16.5%). */
  sector_percent: number;
  /** VAT registration date (YYYY-MM-DD) — anchors the 1% first-year discount window. Null ⇒ no discount. */
  registration_date: string | null;
  /** Whether the org is eligible for and wants the 1% first-year discount applied. */
  first_year_discount: boolean;
  /** FRS scheme start (YYYY-MM-DD, inclusive). Null ⇒ no lower bound. */
  effective_from: string | null;
  /** FRS scheme end (YYYY-MM-DD, exclusive). Null ⇒ open-ended. */
  effective_to: string | null;
  /**
   * EXPLICIT limited-cost-trader declaration (never inferred from finance data):
   *   • "yes"   — limited cost, flat rate forced to 16.5%.
   *   • "no"    — not limited cost (the org's own declaration), sector rate applies.
   *   • "unset" — not yet declared; the FILED return uses the CONSERVATIVE 16.5% and
   *               the surface prompts the org to declare, so an undeclared org can
   *               never silently under-declare on the lower rate.
   */
  limited_cost: LimitedCostDeclaration;
};

/** The disabled default — FRS off, limited-cost undeclared, so no existing tenant's numbers move. */
export const DEFAULT_FLAT_RATE_CONFIG: FlatRateSchemeConfig = {
  enabled: false,
  sector_percent: 0,
  registration_date: null,
  first_year_discount: false,
  effective_from: null,
  effective_to: null,
  limited_cost: "unset",
};

/**
 * Resolve the effective FRS percentage from the sector rate, the limited-cost flag
 * and the first-year discount. Limited cost forces 16.5% (ignoring the sector rate);
 * the 1% discount then comes off WHATEVER rate applies — including the 16.5% rate
 * (→ 15.5% in the first year), per HMRC. Clamped at 0.
 */
export function resolveFlatRatePercent(input: {
  sectorPercent: number;
  limitedCostTrader: boolean;
  firstYearDiscount: boolean;
}): number {
  const base = input.limitedCostTrader
    ? FRS_LIMITED_COST_PERCENT
    : Math.max(0, Number(input.sectorPercent) || 0);
  const pct = input.firstYearDiscount ? base - FRS_FIRST_YEAR_DISCOUNT_PERCENT : base;
  return round2(Math.max(0, pct));
}

/**
 * Is `periodStartIso` inside the first year of VAT registration? The 1% discount
 * runs from the registration date up to (but not including) its first anniversary.
 * Anchored on the period START so a return belongs wholly to one side of the line.
 */
function isWithinFirstYear(registrationDateIso: string | null, periodStartIso: string): boolean {
  if (!registrationDateIso) return false;
  const reg = new Date(`${registrationDateIso}T00:00:00Z`);
  const ps = new Date(`${periodStartIso}T00:00:00Z`);
  if (Number.isNaN(reg.getTime()) || Number.isNaN(ps.getTime())) return false;
  const anniversary = Date.UTC(
    reg.getUTCFullYear() + 1,
    reg.getUTCMonth(),
    reg.getUTCDate(),
  );
  return ps.getTime() >= reg.getTime() && ps.getTime() < anniversary;
}

/** The full resolved FRS position for a period, including the flags for audit/UI. */
export type FlatRateResolution = FlatRateApplied & {
  /** The limited-cost flag actually applied (declared 'yes', OR undeclared → conservative true). */
  limitedCostTrader: boolean;
  /** Whether the 1% first-year discount was applied this period. */
  firstYearApplied: boolean;
  /**
   * True when FRS applies but limited-cost status is UNDECLARED — the return has
   * been filed at the conservative 16.5% and the surface must prompt the org to
   * declare. Surfacing this is how an undeclared org avoids a permanently-wrong rate.
   */
  limitedCostDeclarationMissing: boolean;
};

/**
 * Resolve whether FRS applies to the period starting `periodStartIso` and, if so, at
 * what effective percentage. PURE — no data reads, no inference. FRS applies only
 * when enabled AND the period start falls within the configured effective window.
 *
 * Limited-cost status comes ONLY from the explicit declaration. When undeclared
 * (`unset`) the resolver takes the CONSERVATIVE 16.5% and flags
 * `limitedCostDeclarationMissing` so the surface can prompt — never the lower sector
 * rate, so an undeclared org can never under-declare box 1.
 */
export function resolveFlatRateForPeriod(
  cfg: FlatRateSchemeConfig,
  periodStartIso: string,
): FlatRateResolution {
  const off: FlatRateResolution = {
    applies: false,
    effectivePercent: 0,
    limitedCostTrader: false,
    firstYearApplied: false,
    limitedCostDeclarationMissing: false,
  };
  if (!cfg.enabled) return off;
  if (cfg.effective_from && periodStartIso < cfg.effective_from) return off;
  if (cfg.effective_to && periodStartIso >= cfg.effective_to) return off;

  // Limited cost from the EXPLICIT declaration only. Undeclared ⇒ conservative 16.5%.
  const limitedCostDeclarationMissing = cfg.limited_cost === "unset";
  const limitedCostTrader = cfg.limited_cost !== "no"; // "yes" OR "unset" ⇒ 16.5%
  const firstYearApplied =
    cfg.first_year_discount && isWithinFirstYear(cfg.registration_date, periodStartIso);
  const effectivePercent = resolveFlatRatePercent({
    sectorPercent: cfg.sector_percent,
    limitedCostTrader,
    firstYearDiscount: firstYearApplied,
  });
  return {
    applies: true,
    effectivePercent,
    limitedCostTrader,
    firstYearApplied,
    limitedCostDeclarationMissing,
  };
}

/** Accumulated sales figures for one window under a given scheme (pre-rounding). */
type SalesAccumulation = {
  /** Σ output VAT (box 1 before FRS/RC). */
  outputVat: number;
  /** Σ GROSS (VAT-inclusive) turnover — the FRS flat-rate base and cash-received total. */
  grossTurnover: number;
  /** Σ NET (ex-VAT) sales (box 6 before FRS). */
  netSales: number;
};

/**
 * Accumulate output VAT, gross turnover and net sales for the window under the
 * chosen scheme. This is the ONE place output-basis branches:
 *   • cash     — proportional shares of each payment in the invoice_payments ledger
 *                (the existing apportionment; grossTurnover = the cash received).
 *   • standard — the whole-invoice figures of every ISSUED invoice whose tax point
 *                is in the window (accrual), regardless of payment.
 */
function accumulateSales(
  scheme: VatScheme,
  invoicePayments: InvoicePaymentRow[],
  accrualInvoices: AccrualInvoiceRow[] | undefined,
  inPeriod: (iso: string) => boolean,
): SalesAccumulation {
  if (scheme === "standard") {
    let outputVat = 0;
    let grossTurnover = 0;
    let netSales = 0;
    for (const inv of accrualInvoices ?? []) {
      if (!inv.tax_point || !inPeriod(inv.tax_point)) continue;
      if (!isIssuedStatus(inv.status)) continue; // a draft is not a tax point
      outputVat += Number(inv.vat_total ?? 0);
      netSales += Number(inv.amount ?? 0);
      // RC sales sit OUTSIDE FRS flat-rate turnover (VAT Notice 733 §7.3), but stay
      // in box 6 for standard VAT — so exclude them from grossTurnover only.
      if (!inv.reverse_charge) grossTurnover += Number(inv.total ?? 0);
    }
    return { outputVat, grossTurnover, netSales };
  }
  // cash (default) — proportional per-payment shares from the ledger.
  let outputVat = 0;
  let grossTurnover = 0;
  let netSales = 0;
  for (const p of invoicePayments) {
    if (!p.paid_at || !inPeriod(p.paid_at)) continue;
    const total = Number(p.invoice_total ?? 0);
    if (!Number.isFinite(total) || total <= 0) continue; // divide-by-zero guard
    const amount = Number(p.amount ?? 0);
    outputVat += amount * (Number(p.invoice_vat_total ?? 0) / total);
    netSales += amount * (Number(p.invoice_amount ?? 0) / total);
    // RC sales are excluded from FRS flat-rate turnover only (VAT Notice 733 §7.3).
    if (!p.reverse_charge) grossTurnover += amount; // gross (VAT-inclusive) cash received
  }
  return { outputVat, grossTurnover, netSales };
}

/** Accumulated purchase figures for one window under a given scheme (pre-rounding). */
type PurchaseAccumulation = {
  /** Σ input VAT (box 4 before FRS/RC). */
  inputVat: number;
  /** Σ NET (ex-VAT) purchases (box 7 before FRS). */
  inputNet: number;
};

/**
 * Accumulate INPUT VAT (box 4) AND net purchases (box 7) for the window on the
 * chosen basis (CF-1). This is the ONE place the input/purchase basis branches, so
 * boxes 4 and 7 are ALWAYS computed from the identical row set and window and
 * therefore reconcile:
 *   • standard — ACCRUAL: every logged cost (`finances`) whose tax point
 *                (created_at) is in the window, whether or not it is paid.
 *   • cash     — CASH: when a supplier-payment ledger is supplied, the apportioned
 *                VAT and net on the bills actually PAID in the window (a partial
 *                settlement counts only the VAT/net on the cash paid). Per row the
 *                VAT share and net share sum back to the gross cash paid, so
 *                box 4 + box 7 = gross paid on one window. When no ledger is supplied
 *                the cash path FALLS BACK to the accrual `finances` sums, so an
 *                existing caller that has not yet wired the ledger is byte-for-byte
 *                unchanged rather than silently dropping to £0.
 *
 * Domestic reverse charge is NOT handled here — its notional VAT is threaded onto
 * boxes 1/4 by the caller via `reverseChargeVat`, and RC bills carry vat_total = 0
 * so their VAT share is 0 (no double count) while their NET still lands in box 7.
 */
function accumulatePurchases(
  scheme: VatScheme,
  finances: FinanceRow[],
  supplierPayments: SupplierPaymentLedgerRow[] | undefined,
  inPeriod: (iso: string) => boolean,
): PurchaseAccumulation {
  // CASH basis with a wired ledger: VAT + net on bills PAID in the window,
  // apportioned per payment exactly like the output-VAT cash basis above.
  if (scheme === "cash" && supplierPayments !== undefined) {
    let inputVat = 0;
    let inputNet = 0;
    for (const p of supplierPayments) {
      if (!p.paid_at || !inPeriod(p.paid_at)) continue;
      const total = Number(p.bill_total ?? 0);
      if (!Number.isFinite(total) || total <= 0) continue; // divide-by-zero / credit-note guard (mirrors sales side)
      const amount = Number(p.amount ?? 0);
      const vatShare = amount * (Number(p.bill_vat_total ?? 0) / total);
      inputVat += vatShare;
      inputNet += amount - vatShare; // net share = gross cash paid − its VAT share
    }
    return { inputVat, inputNet };
  }
  // ACCRUAL basis (standard scheme, OR cash with no ledger wired): VAT and net on
  // all logged costs by tax point (finances.created_at). UNCHANGED legacy behaviour.
  let inputVat = 0;
  let inputNet = 0;
  for (const f of finances) {
    if (inPeriod(f.created_at)) {
      inputVat += Number(f.vat_total ?? 0);
      inputNet += Number(f.amount ?? 0);
    }
  }
  return { inputVat, inputNet };
}

/**
 * The single VAT authority over the quarter `[quarterStartIso, quarterEndIso)`.
 * Output VAT (box 1) and input VAT (box 4) share the org's chosen basis (CF-1):
 * under `cash` both legs are payment-driven (output from the invoice_payments
 * ledger, input from the supplier_payment_allocations ledger); under `standard`
 * both are accrual (invoice tax points / logged finance rows).
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
 * (box 4) follows the SAME basis: CASH (VAT on bills actually paid, apportioned
 * per supplier payment) under `cash`, ACCRUAL (all logged costs) under `standard`.
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
  opts?: VatComputeOptions,
): TaxSummary["vat_quarter"] {
  const scheme = normalizeVatScheme(opts?.scheme);
  const inPeriod = (iso: string): boolean =>
    iso >= quarterStartIso &&
    (quarterEndIso === undefined || iso < quarterEndIso);

  // Box 1 source — output VAT on the chosen basis (cash ledger / accrual invoices),
  // plus the gross turnover the FRS flat calculation needs.
  const sales = accumulateSales(scheme, invoicePayments, opts?.accrualInvoices, inPeriod);

  // Box 4 — input VAT on the chosen basis (CF-1): ACCRUAL (logged costs by tax
  // point) under `standard`, CASH (bills actually paid, from the supplier-payment
  // ledger) under `cash`. The cash path falls back to the accrual sum when no
  // ledger is wired, so an existing caller is unchanged.
  let inputVat = accumulatePurchases(scheme, finances, opts?.supplierPayments, inPeriod).inputVat;

  // Domestic reverse charge: the notional VAT is BOTH output and input, so the
  // net (box 5) is unchanged. Under FRS it is accounted OUTSIDE the flat scheme
  // (HMRC VAT Notice 733 §7.3), so it is still added to BOTH legs equally.
  const rc = Number.isFinite(reverseChargeVat) ? reverseChargeVat : 0;

  const frs = opts?.flatRate;
  if (frs?.applies) {
    // FLAT RATE: box 1 = flat % × gross (VAT-inclusive) flat-rate turnover; input
    // VAT is NOT reclaimed under FRS (box 4 = 0, bar capital assets > £2,000 which
    // are out of scope). Reverse charge stays net-neutral on top.
    const flatVat = (Math.max(0, frs.effectivePercent) / 100) * sales.grossTurnover;
    const outputVat = flatVat + rc;
    const inputVatFrs = rc;
    return {
      output_vat: round2(outputVat),
      input_vat: round2(inputVatFrs),
      net_payable: round2(outputVat - inputVatFrs),
      confidence: "computed",
    };
  }

  // STANDARD/CASH: box 1 is the accumulated output VAT; box 4 the input VAT on the
  // matching basis (accrual finances for `standard`, cash supplier-payment ledger for
  // `cash`). Reverse charge is THREADED (added to both legs), never re-derived — the
  // frozen ledger total enters output AND input so box 5 stays net-neutral.
  let outputVat = sales.outputVat;
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
 *   • BOX 7 (purchases) sums the net purchases whose VAT feeds box 4, on the SAME
 *     basis as box 4 (CF-1): ACCRUAL (the net `amount` of the logged finance rows)
 *     under `standard`, CASH (the apportioned net of the supplier payments actually
 *     made in the window) under `cash`. A domestic reverse-charge purchase bill has
 *     `vat_total` 0 (the supplier charges no VAT), so its VAT share is 0 while its
 *     NET still lands in box 7 — exactly once. HMRC includes reverse-charge
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
  opts?: VatComputeOptions,
): { totalValueSalesExVAT: number; totalValuePurchasesExVAT: number } {
  const scheme = normalizeVatScheme(opts?.scheme);
  const inPeriod = (iso: string): boolean =>
    iso >= quarterStartIso &&
    (quarterEndIso === undefined || iso < quarterEndIso);

  const sales = accumulateSales(scheme, invoicePayments, opts?.accrualInvoices, inPeriod);

  // Box 7 net purchases share box 4's basis (CF-1): accrual finances under
  // `standard`, cash supplier-payment ledger under `cash` (falling back to accrual
  // finances when no ledger is wired). Same set + window as box 4, so box 4 + box 7
  // reconcile to the cash paid.
  const cashLedgerActive = scheme === "cash" && opts?.supplierPayments !== undefined;
  let purchases = accumulatePurchases(scheme, finances, opts?.supplierPayments, inPeriod).inputNet;
  // On the cash-ledger path the accrual `finances` loop (which would otherwise carry
  // reverse-charge purchase net) is bypassed, so add the RC net back on its own
  // tax-point basis — once — mirroring how `reverseChargeVat` feeds boxes 1/4. Under
  // standard/fallback the RC net is already inside the finances sum, so nothing is
  // added (no double count). RC is excluded from cash accounting (VAT Notice 731 §5.1).
  if (cashLedgerActive) {
    const rcNet = Number.isFinite(opts?.reverseChargeNet) ? Number(opts?.reverseChargeNet) : 0;
    purchases += rcNet;
  }

  const frs = opts?.flatRate;
  if (frs?.applies) {
    // FLAT RATE: box 6 is the flat-rate turnover, which HMRC defines as the GROSS
    // (VAT-INCLUSIVE) value of sales (VAT Notice 733 §6.3) — not the ex-VAT net.
    // Box 7 is left at 0: an FRS user does not reclaim input VAT on purchases (bar
    // capital assets > £2,000, out of scope), so purchases are not reported.
    return {
      totalValueSalesExVAT: round2(sales.grossTurnover),
      totalValuePurchasesExVAT: 0,
    };
  }

  return {
    totalValueSalesExVAT: round2(sales.netSales),
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
