/**
 * Shared money helpers (the codebase had none — each surface rolled its own
 * Intl formatter). Money is handled as GBP with 2dp; all arithmetic goes
 * through `round2` to avoid floating-point drift on sums. DB columns stay
 * `numeric` — this is the display/aggregation boundary, never a substitute for
 * database-side precision.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

/** Coerce a numeric/`numeric`-string/null to a finite pounds number (0 fallback). */
export function toPounds(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Round to 2dp the same way the quote/variation totals do (Math.round·100). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Sum a list of money-ish values, rounding each step (order-independent to 2dp). */
export function sumMoney(values: Array<number | string | null | undefined>): number {
  return values.reduce<number>((acc, v) => round2(acc + toPounds(v)), 0);
}

export function formatGbp(v: number | string | null | undefined): string {
  return GBP.format(toPounds(v));
}
