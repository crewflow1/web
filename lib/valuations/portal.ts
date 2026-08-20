import { round2, toPounds } from "@/lib/money";
import {
  computeValuationFigures,
  VALUATION_STATUS_LABEL,
  type Numberish,
  type ValuationStatus,
} from "@/lib/valuations/compute";

/**
 * The customer-safe interim-valuation (application-for-payment) view.
 *
 * A valuation certificate is exactly the kind of document a client is entitled
 * to see — it tells them what has been certified for payment this period. But
 * the valuation record and the variations it references sit one join away from
 * the internal cost basis (quotes.cost_* — the priced-in profit) and from operator
 * notes. The portal runs on the RLS-BYPASSING service-role client, so nothing in
 * the database stops an internal column leaking; safety is by EXPLICIT
 * PROJECTION.
 *
 * So, exactly like `buildPortalVariationView`: no row is ever spread. This
 * builder takes named, customer-safe arguments and assembles the DTO field by
 * field, and it accepts NO cost or notes argument — there is no parameter a cost
 * figure could travel through. A security test plants sentinel cost values on the
 * source rows and asserts they are ABSENT FROM THE SERIALISED JSON.
 *
 * The money it shows is derived by the SAME `computeValuationFigures` the app and
 * the DB certify path use, so the certificate the customer sees can never
 * disagree with the invoice that was generated.
 *
 * Pure + server/client-safe.
 */

export type PortalValuationView = {
  id: string;
  sequence: number;
  status: ValuationStatus;
  status_label: string;
  period_start: string | null;
  period_end: string | null;
  valuation_date: string;
  /** Cumulative certified value of works + materials + variations (ex-VAT). */
  gross_valuation: number;
  /** Value of instructed variations reflected in this valuation (ex-VAT). */
  variations_total: number;
  /** Cumulative value certified in earlier applications (ex-VAT). */
  previous_certified: number;
  /** This period's certified increment, ex-VAT (before retention / VAT). */
  net_certified_this: number;
  /** Retention rate applied (%). */
  retention_percent: number;
  /** Retention withheld from this increment (£). */
  retention_this: number;
  /** VAT charged on this increment (£). */
  vat: number;
  /** Amount due for payment this period, net of retention, including VAT (£). */
  amount_due: number;
  /** The generated invoice number, once invoiced. */
  invoice_number: string | null;
};

export const VALUATION_PORTAL_KEYS: ReadonlyArray<keyof PortalValuationView> = [
  "id",
  "sequence",
  "status",
  "status_label",
  "period_start",
  "period_end",
  "valuation_date",
  "gross_valuation",
  "variations_total",
  "previous_certified",
  "net_certified_this",
  "retention_percent",
  "retention_this",
  "vat",
  "amount_due",
  "invoice_number",
];

/** Statuses a customer may see. A draft application is internal until submitted. */
export const PORTAL_VISIBLE_VALUATION_STATUSES: ReadonlyArray<ValuationStatus> = [
  "submitted",
  "certified",
  "invoiced",
];

export function isPortalVisibleValuation(status: string | null | undefined): boolean {
  return (PORTAL_VISIBLE_VALUATION_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * Build ONE customer-safe valuation view. Every money figure is passed as a
 * named scalar — never a spread of the DB row — and there is deliberately no
 * cost/notes parameter. The `amount_due` (net of retention, incl VAT) is the
 * cash figure the certificate presents.
 *
 * `retentionPercent` is the contract rate (snapshot on certified rows, live from
 * the job otherwise); for a submitted (not-yet-certified) row the figures are
 * projected exactly as the certify step would compute them.
 */
export function buildPortalValuationView(input: {
  id: string;
  sequence: number;
  status: ValuationStatus;
  periodStart: string | null;
  periodEnd: string | null;
  valuationDate: string;
  workCompletedToDate: Numberish;
  materialsOnSite: Numberish;
  variationsTotal: Numberish;
  deductions: Numberish;
  previousCertifiedGross: Numberish;
  retentionPercent: Numberish;
  vatRate: Numberish;
  invoiceNumber: string | null;
}): PortalValuationView {
  const figures = computeValuationFigures({
    workCompletedToDate: input.workCompletedToDate,
    materialsOnSite: input.materialsOnSite,
    variationsTotal: input.variationsTotal,
    deductions: input.deductions,
    previousCertifiedGross: input.previousCertifiedGross,
    retentionPercent: input.retentionPercent,
    vatRate: input.vatRate,
  });
  // amount_due = the increment net of retention, plus VAT on the increment.
  const amountDue = round2(figures.netPayableThis + figures.vat);
  const rate = Math.min(100, Math.max(0, toPounds(input.retentionPercent)));
  return {
    id: input.id,
    sequence: input.sequence,
    status: input.status,
    status_label: VALUATION_STATUS_LABEL[input.status] ?? input.status,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    valuation_date: input.valuationDate,
    gross_valuation: figures.gross,
    variations_total: round2(Math.max(0, toPounds(input.variationsTotal))),
    previous_certified: figures.previousCertifiedGross,
    net_certified_this: figures.netCertifiedThis,
    retention_percent: round2(rate),
    retention_this: figures.retentionThis,
    vat: figures.vat,
    amount_due: amountDue,
    invoice_number: input.invoiceNumber,
  };
}
