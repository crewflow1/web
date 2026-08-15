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

/**
 * Pounds (major units, 2dp) → INTEGER PENCE. `Math.round` because float
 * multiplication of e.g. 19.99 does not land exactly on 1999. A non-finite /
 * null input is treated as 0. This is the write boundary for the curated
 * price-book / template tables, whose money columns are integer pence.
 */
export function poundsToPence(v: number | string | null | undefined): number {
  return Math.round(toPounds(v) * 100);
}

/**
 * INTEGER PENCE → pounds (major units). The read boundary: the legacy
 * quotes/quote_line_items columns are `numeric` pounds, so a picked price-book
 * item or an applied template line converts here before it populates a quote
 * line. Non-integer / null input is treated as 0 pence.
 */
export function penceToPounds(pence: number | string | null | undefined): number {
  const n = Number(pence ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

export function formatPence(pence: number | string | null | undefined): string {
  return GBP.format(penceToPounds(pence));
}

/**
 * Split `total` into parts proportional to `weights`, PENNY-EXACT: the returned
 * amounts always sum to EXACTLY round2(total) (largest-remainder method), so a
 * percentage stage split like 33.33 / 33.33 / 33.34 of £10,000 yields
 * £3,333.00 / £3,333.00 / £3,334.00 = £10,000.00, never £9,999.99.
 *
 * Weights need not sum to 100 — each part is `weight / Σweights` of the total.
 * Non-positive weights are treated as 0. A zero total or all-zero weights yields
 * all-zero parts. Works in integer pennies internally to avoid float drift.
 */
export function apportion(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const totalWeight = clean.reduce((a, b) => a + b, 0);
  const totalPennies = Math.round(round2(toPounds(total)) * 100);
  if (totalPennies === 0 || totalWeight <= 0) return new Array<number>(n).fill(0);

  const raw = clean.map((w) => (w / totalWeight) * totalPennies);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = totalPennies - floors.reduce((a, b) => a + b, 0);

  // Give the leftover pennies to the largest fractional parts (stable by index).
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const pennies = floors.slice();
  for (let k = 0; k < order.length && remainder > 0; k++) {
    pennies[order[k]!.i] = (pennies[order[k]!.i] ?? 0) + 1;
    remainder -= 1;
  }
  return pennies.map((p) => p / 100);
}
