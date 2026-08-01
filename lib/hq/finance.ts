import { SIGNAL_KIND_LABEL } from "@/lib/intelligence/provenance";

/**
 * CrewFlow HQ — FINANCE AI, pure board compute (super-admin surface).
 *
 * Server- AND client-safe: NO Supabase imports, NO clock. The server-only
 * aggregator (`server/services/hq-finance.ts`) gathers the raw figures from the
 * existing HQ snapshot + customer-financials layer and hands a plain
 * `FinanceInput` to `computeFinanceBoard` here.
 *
 * ── THE HONESTY DOCTRINE (mirrors lib/intelligence/provenance.ts) ────────────
 * Every figure this board emits LABELS ITSELF and carries a plain-English
 * `basis`. There are exactly three labels:
 *
 *   fact         A count read straight from the org records (active subs, new,
 *                churned this period). Nothing computed beyond counting rows.
 *   derived      Exact arithmetic over facts (MRR = active × contracted price,
 *                ARR = MRR × 12). Reproducible from the inputs alone.
 *   insufficient The input this figure needs DOES NOT EXIST in the schema.
 *                We return `value: null` and a one-line basis saying why —
 *                NEVER a fabricated 0-as-real. Gross margin (no cost-of-revenue
 *                source), cash in (no collected-payment feed — Stripe not
 *                landed), runway (no burn source) and CAC (no acquisition-spend
 *                source) are all insufficient TODAY, by construction.
 *
 * A metric with no source is a first-class honest answer, not a crash and not a
 * zero. `now` is injected so the layer is deterministic and replayable — there
 * is no `Date.now()` here.
 */

// ---------------------------------------------------------------------------
// The label ladder — fact / derived reuse the provenance wording; insufficient
// is this board's honest no-data state (absence is an answer, never a zero).
// ---------------------------------------------------------------------------

export type FinanceMetricKind = "fact" | "derived" | "insufficient";

export const FINANCE_KIND_LABEL: Record<FinanceMetricKind, string> = {
  fact: SIGNAL_KIND_LABEL.fact, // "Fact"
  derived: SIGNAL_KIND_LABEL.derived, // "Derived"
  insufficient: "Insufficient data",
};

export type FinanceFormat = "gbp" | "int" | "pct" | "months";

/**
 * A board figure that carries its own label + basis. `value` is `null` if and
 * only if `kind === "insufficient"` — a labelled figure with a real value can
 * never be an insufficient one, and vice versa (enforced by the constructors
 * and asserted in the tests).
 */
export interface FinanceMetric {
  key: string;
  /** Display name — "MRR", "Gross margin", … */
  label: string;
  kind: FinanceMetricKind;
  /** The figure, or `null` when the input source does not exist. */
  value: number | null;
  format: FinanceFormat;
  /** Plain English: where the number comes from, or why it can't be computed. */
  basis: string;
}

export interface FinanceBoard {
  /** ISO timestamp the board was assembled at (from the injected `now`). */
  asOf: string;
  /** Human month label the "this period" figures cover, e.g. "August 2026". */
  periodLabel: string;
  metrics: FinanceMetric[];
}

// ---------------------------------------------------------------------------
// Input — every raw figure the board derives from. The four "…Gbp | null"
// fields are the ABSENT sources: the aggregator passes `null` because the
// schema has nowhere to read them from, and the pure layer turns each `null`
// into an honest `insufficient` metric. When a real source lands later, the
// aggregator passes a number and the SAME code computes a real figure.
// ---------------------------------------------------------------------------

export interface FinanceInput {
  /** Count of organisations with status = active. FACT. */
  activeCustomers: number;
  /** Count of organisations on trial. FACT. */
  trials: number;
  /** Organisations that became customers in the current month. FACT. */
  newCustomersThisMonth: number;
  /** Organisations cancelled in the current month. FACT. */
  churnedThisMonth: number;
  /** The contracted monthly price per active customer (£500 today). */
  monthlyPriceGbp: number;

  /** Cost of revenue for the period, or null when no COGS source exists. */
  costOfRevenueGbp: number | null;
  /** Cash actually collected in the period (cash-in metric), or null when no payment/invoice-paid feed exists. */
  cashCollectedGbp: number | null;
  /** Cash balance on hand — the runway NUMERATOR (cash ÷ burn), or null when no cash-balance source exists. Distinct from period inflow above. */
  cashBalanceGbp: number | null;
  /** Monthly operating burn, or null when no cost/burn source exists. */
  monthlyBurnGbp: number | null;
  /** Acquisition spend for the period, or null when no marketing-spend source exists. */
  acquisitionSpendGbp: number | null;
}

// ---------------------------------------------------------------------------
// Metric constructors — the ONLY way a figure gets onto the board, so the
// value/kind invariant holds by construction.
// ---------------------------------------------------------------------------

function fact(
  key: string,
  label: string,
  value: number,
  format: FinanceFormat,
  basis: string,
): FinanceMetric {
  return { key, label, kind: "fact", value, format, basis };
}

function derived(
  key: string,
  label: string,
  value: number,
  format: FinanceFormat,
  basis: string,
): FinanceMetric {
  return { key, label, kind: "derived", value, format, basis };
}

function insufficient(
  key: string,
  label: string,
  format: FinanceFormat,
  basis: string,
): FinanceMetric {
  return { key, label, kind: "insufficient", value: null, format, basis };
}

// ---------------------------------------------------------------------------
// Board assembly.
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeFinanceBoard(input: FinanceInput, now: Date): FinanceBoard {
  const active = Math.max(0, Math.trunc(input.activeCustomers));
  const price = input.monthlyPriceGbp;

  const mrr = active * price;
  const arr = mrr * 12;

  const metrics: FinanceMetric[] = [
    derived(
      "mrr",
      "MRR",
      mrr,
      "gbp",
      `${active} active organisation${active === 1 ? "" : "s"} × £${price} contracted monthly price. Contracted recurring revenue — no invoice/collection feed exists, so this is booked-not-collected.`,
    ),
    derived(
      "arr",
      "ARR",
      arr,
      "gbp",
      "MRR × 12 (annual run-rate of the contracted recurring revenue).",
    ),
    fact(
      "active_subscriptions",
      "Active subscriptions",
      active,
      "int",
      "Count of organisations with status = active.",
    ),
    fact(
      "trials",
      "Trials",
      Math.max(0, Math.trunc(input.trials)),
      "int",
      "Count of organisations with status = trial.",
    ),
    fact(
      "new_this_period",
      "New this period",
      Math.max(0, Math.trunc(input.newCustomersThisMonth)),
      "int",
      "Organisations that became customers in the current month (customer-growth series).",
    ),
    fact(
      "churned_this_period",
      "Churned this period",
      Math.max(0, Math.trunc(input.churnedThisMonth)),
      "int",
      "Organisations cancelled in the current month (cancellation series).",
    ),
    // Gross margin — needs a cost-of-revenue source that does not exist.
    input.costOfRevenueGbp == null
      ? insufficient(
          "gross_margin",
          "Gross margin",
          "pct",
          "No cost-of-revenue (COGS) source exists in the schema; a margin cannot be computed from revenue alone without costs.",
        )
      : mrr <= 0
        ? insufficient(
            "gross_margin",
            "Gross margin",
            "pct",
            "MRR is £0, so a margin percentage is undefined for this period.",
          )
        : derived(
            "gross_margin",
            "Gross margin",
            round2(((mrr - input.costOfRevenueGbp) / mrr) * 100),
            "pct",
            "(MRR − cost of revenue) ÷ MRR × 100.",
          ),
    // Cash in — needs a collected-payment feed (Stripe / invoices-paid) that
    // does not exist. Contracted MRR is NOT cash received, so we do not pass it
    // off as one.
    input.cashCollectedGbp == null
      ? insufficient(
          "cash_in",
          "Cash in",
          "gbp",
          "No payment/invoice-paid records exist (billing is not integrated); only contracted MRR is known, which is not cash received.",
        )
      : fact(
          "cash_in",
          "Cash in",
          input.cashCollectedGbp,
          "gbp",
          "Sum of payments collected in the period.",
        ),
    // Runway — needs a cash-balance source AND a monthly burn source, neither of
    // which exists. The numerator is the cash BALANCE on hand, not period inflow.
    input.monthlyBurnGbp == null || input.cashBalanceGbp == null
      ? insufficient(
          "runway",
          "Runway",
          "months",
          "No cash balance and no monthly burn/operating-cost source exist in the schema; runway needs cash ÷ burn.",
        )
      : input.monthlyBurnGbp <= 0
        ? insufficient(
            "runway",
            "Runway",
            "months",
            "Reported monthly burn is £0 or negative, so runway is undefined.",
          )
        : derived(
            "runway",
            "Runway",
            round2(input.cashBalanceGbp / input.monthlyBurnGbp),
            "months",
            "Cash balance ÷ monthly burn.",
          ),
    // CAC — needs an acquisition-spend source that does not exist.
    input.acquisitionSpendGbp == null
      ? insufficient(
          "cac",
          "CAC",
          "gbp",
          "No acquisition/marketing-spend source exists in the schema; CAC needs spend ÷ new customers.",
        )
      : input.newCustomersThisMonth <= 0
        ? insufficient(
            "cac",
            "CAC",
            "gbp",
            "No new customers this period, so cost-per-acquisition is undefined.",
          )
        : derived(
            "cac",
            "CAC",
            round2(input.acquisitionSpendGbp / input.newCustomersThisMonth),
            "gbp",
            "Acquisition spend ÷ new customers this period.",
          ),
  ];

  const periodLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;

  return {
    asOf: now.toISOString(),
    periodLabel,
    metrics,
  };
}
