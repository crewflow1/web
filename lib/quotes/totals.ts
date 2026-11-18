/**
 * Pure functions for quote total calculation.
 *
 * All amounts are in major currency units (GBP) and rounded to 2dp at
 * each step to match how invoicing systems behave: line totals are
 * computed pre-VAT, then VAT is applied per line, then we sum.
 *
 * This mirrors HMRC's preferred rounding approach (per-line VAT
 * computation, summed to the invoice) rather than gross-then-back-out
 * which can drift by pennies on multi-line quotes.
 */

import type { LineItem } from "./schema";

export type QuoteTotals = {
  subtotal: number;
  vat_total: number;
  total: number;
  /** Per-line breakdown for display + persistence. */
  lines: Array<{ line_total: number; line_vat: number }>;
};

/**
 * Round to the penny, half away from zero — the same rule Postgres `round(x, 2)`
 * applies to the VAT the database computes itself (billing-plan stages, cost log).
 *
 * `Math.round(n * 100)` alone is NOT that rule: the scaled value is binary
 * floating point and often lands a hair below .5, so some halves went down and
 * others up (2.90 × 5% = 0.145 → 0.14, while 0.10 × 5% = 0.005 → 0.01). Snapping
 * the scaled value to 6 decimal places first removes that representation error
 * (many orders of magnitude below a penny) before the half-up decision.
 */
function round2(n: number): number {
  const pence = Math.round(Number((Math.abs(n) * 100).toFixed(6)));
  return (n < 0 ? -pence : pence) / 100;
}

export function computeTotals(items: LineItem[]): QuoteTotals {
  let subtotal = 0;
  let vat_total = 0;
  const lines: QuoteTotals["lines"] = [];

  for (const li of items) {
    const lineTotal = round2(li.qty * li.unit_price);
    const lineVat = round2((lineTotal * li.vat_rate) / 100);
    subtotal = round2(subtotal + lineTotal);
    vat_total = round2(vat_total + lineVat);
    lines.push({ line_total: lineTotal, line_vat: lineVat });
  }

  return {
    subtotal,
    vat_total,
    total: round2(subtotal + vat_total),
    lines,
  };
}
