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

// ---------------------------------------------------------------------------
// Currency-aware formatting (multi-country readiness)
// ---------------------------------------------------------------------------
//
// The GBP formatter above is the pre-wave default. `formatCurrency` generalises
// it to any (locale, currency) while the GBP path stays BYTE-IDENTICAL: calling
// formatCurrency with the defaults produces the exact same Intl.NumberFormat as
// `GBP`, so formatGbp is unchanged and no existing figure moves. Per-org currency
// flows in from organizations.currency / .locale (lib/i18n/config.ts defaults
// GBP/en-GB), so an existing UK org renders identically.

/** The org money identity: an amount paired with the currency it is denominated in. */
export type Money = {
  /** Major units (pounds/dollars/euros), 2dp — NOT minor units. */
  amount: number;
  /** ISO 4217 alpha-3 (e.g. "GBP"). */
  currency: string;
};

export type CurrencyFormatOptions = {
  /** BCP-47 locale for grouping/symbol placement. Default "en-GB". */
  locale?: string;
  /** ISO 4217 currency. Default "GBP". */
  currency?: string;
  /** minimumFractionDigits (default 2, matching the legacy GBP formatter). */
  minimumFractionDigits?: number;
  /** maximumFractionDigits (defaults to Intl's currency-derived value). */
  maximumFractionDigits?: number;
};

// Intl.NumberFormat construction is not free; cache by the option signature.
const currencyFormatterCache = new Map<string, Intl.NumberFormat>();

function currencyFormatter(opts: CurrencyFormatOptions): Intl.NumberFormat {
  const locale = opts.locale || "en-GB";
  const currency = (opts.currency || "GBP").toUpperCase();
  const minFrac = opts.minimumFractionDigits ?? 2;
  const key = `${locale}|${currency}|${minFrac}|${opts.maximumFractionDigits ?? ""}`;
  let fmt = currencyFormatterCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: minFrac,
        ...(opts.maximumFractionDigits !== undefined
          ? { maximumFractionDigits: opts.maximumFractionDigits }
          : {}),
      });
    } catch {
      // A bad locale/currency (should be filtered upstream by lib/i18n) must never
      // throw at a render boundary — fall back to the pre-wave GBP/en-GB formatter.
      fmt = GBP;
    }
    currencyFormatterCache.set(key, fmt);
  }
  return fmt;
}

/**
 * Locale/currency-aware money formatter. The generalisation of `formatGbp`.
 * With the defaults (en-GB, GBP) it is byte-identical to formatGbp — that
 * equivalence is pinned by a default-safety test. Route per-org money display
 * through this with the org's locale + currency.
 */
export function formatCurrency(
  v: number | string | null | undefined,
  opts: CurrencyFormatOptions = {},
): string {
  return currencyFormatter(opts).format(toPounds(v));
}

/** Format a {@link Money} value with a locale (currency travels with the value). */
export function formatMoney(money: Money, locale = "en-GB"): string {
  return formatCurrency(money.amount, { locale, currency: money.currency });
}

/** Pair an amount with a currency (the org base currency by default). */
export function money(amount: number | string | null | undefined, currency = "GBP"): Money {
  return { amount: toPounds(amount), currency: currency.toUpperCase() };
}

// ---------------------------------------------------------------------------
// Currency conversion authority (INTERFACE ONLY — dark)
// ---------------------------------------------------------------------------
//
// The roadmap does NOT require cross-currency conversion yet: each org has ONE
// base currency and all its stored amounts are denominated in it. This interface
// defines the seam so a future FX provider plugs in without a second money model.
// The only implementation shipped is the identity converter, which refuses any
// cross-currency conversion (there is no rate source) — so nothing can silently
// invent an exchange rate.

export type CurrencyConverter = {
  /**
   * Convert `amount` from one currency to another as at `asOf` (or now).
   * MUST throw when it has no authoritative rate for the pair — never guess.
   */
  convert(
    amount: number,
    from: string,
    to: string,
    asOf?: Date,
  ): Money;
  /** Does this converter have a rate for the pair (same-currency is always true)? */
  supports(from: string, to: string): boolean;
};

/**
 * The only converter shipped: a no-op that passes same-currency amounts through
 * and REFUSES any real conversion (no rate authority exists yet). Keeps the
 * platform single-base-currency and honest until an FX source is wired.
 */
export const identityConverter: CurrencyConverter = {
  supports: (from, to) => from.toUpperCase() === to.toUpperCase(),
  convert: (amount, from, to) => {
    const f = from.toUpperCase();
    const t = to.toUpperCase();
    if (f === t) return { amount: round2(amount), currency: t };
    throw new Error(
      `No currency conversion authority: cannot convert ${f}→${t}. ` +
        `The platform is single-base-currency; wire an FX provider before converting.`,
    );
  },
};

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
