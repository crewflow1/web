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
  /**
   * The £500/month LIST price — the FALLBACK used (a) per-org when an active
   * org has no recorded `mrr_gbp`, (b) to price pipeline-weighted forecast
   * conversions (a pipeline deal has no contracted figure yet), and (c) for the
   * whole MRR figure only when the per-org source below was unreadable.
   */
  monthlyPriceGbp: number;

  /**
   * P12 — the REAL per-org MRR source: one entry per ACTIVE organisation, the
   * org's `organizations.mrr_gbp` (null when no contracted figure is recorded
   * for that org — counted at the list-price fallback, documented in the
   * basis). `null` (the whole field) = the per-org source could not be read
   * this cycle → MRR degrades to the count × list-price estimate, labelled so.
   */
  activeOrgMrrsGbp: ReadonlyArray<number | null> | null;
  /**
   * P12 — one entry per ACTIVE organisation: the org's cached
   * `organizations.ltv_gbp`, null when unrecorded. `null` (whole field) = the
   * source could not be read this cycle → both LTV metrics go insufficient.
   */
  activeOrgLtvsGbp: ReadonlyArray<number | null> | null;
  /**
   * P12 — the demo-request lifecycle counts (real `demo_requests` statuses),
   * the pipeline + historical win-rate inputs of the 3-month forecast. `null`
   * = source unreadable this cycle → forecast is insufficient.
   */
  demoLifecycle: {
    /** Requests awaiting first contact (incl. legacy 'new'). Live pipeline. */
    pendingDemo: number;
    /** Requests with a demo booked. Live pipeline. */
    demoBooked: number;
    /** Requests that converted (won). Historical outcome. */
    approved: number;
    /** Requests rejected. Historical outcome. */
    rejected: number;
    /** Requests cancelled. Historical outcome. */
    cancelled: number;
  } | null;

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

/**
 * P12 — the minimum number of DECIDED demo requests (approved + rejected +
 * cancelled) below which a win rate is not estimated: with fewer outcomes the
 * rate is noise, so the forecast honestly reports insufficient instead.
 */
export const FORECAST_MIN_DECIDED_DEMOS = 5;

export function computeFinanceBoard(input: FinanceInput, now: Date): FinanceBoard {
  const active = Math.max(0, Math.trunc(input.activeCustomers));
  const price = input.monthlyPriceGbp;

  // ── MRR — the REAL figure (P12): sum of per-org contracted mrr_gbp across
  // active orgs, an org falling back to the list price ONLY when its mrr_gbp is
  // null (no contracted figure recorded). The count × list-price estimate
  // survives solely as the labelled degraded path when the per-org source was
  // unreadable this cycle — never silently.
  const perOrg = input.activeOrgMrrsGbp;
  let mrr: number;
  let mrrBasis: string;
  if (perOrg != null) {
    const fallbackCount = perOrg.filter((v) => v == null).length;
    mrr = round2(perOrg.reduce<number>((sum, v) => sum + (v ?? price), 0));
    mrrBasis =
      `Sum of contracted per-organisation MRR (organizations.mrr_gbp) across ${perOrg.length} active organisation${perOrg.length === 1 ? "" : "s"}` +
      (fallbackCount > 0
        ? `; ${fallbackCount} without a recorded mrr_gbp counted at the £${price} list price.`
        : ".") +
      " Booked-not-collected — no invoice/collection feed exists.";
  } else {
    mrr = active * price;
    mrrBasis = `Estimate: ${active} active organisation${active === 1 ? "" : "s"} × £${price} list price — the per-organisation mrr_gbp source could not be read this cycle. Booked-not-collected.`;
  }
  const arr = round2(mrr * 12);

  const metrics: FinanceMetric[] = [
    derived("mrr", "MRR", mrr, "gbp", mrrBasis),
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
    // ── LTV (P12) — the cached per-org organizations.ltv_gbp, summed and
    // averaged over the active orgs that HAVE a recorded value. Orgs without
    // one are excluded (and counted in the basis), never fabricated as £0.
    ...ltvMetrics(input.activeOrgLtvsGbp),
    // ── 3-month pipeline-weighted revenue forecast (P12) — deterministic,
    // from the real demo_requests lifecycle. Honest `insufficient` below the
    // minimum decided-demo sample.
    forecastMetric(input.demoLifecycle, mrr, price),
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

// ---------------------------------------------------------------------------
// P12 helpers — LTV and the pipeline-weighted forecast. Pure; every path is
// labelled and every degradation is an honest `insufficient`, never a zero.
// ---------------------------------------------------------------------------

/** Total + average of the recorded per-org cached LTVs, or honest absences. */
function ltvMetrics(
  ltvs: ReadonlyArray<number | null> | null,
): FinanceMetric[] {
  if (ltvs == null) {
    const basis =
      "The per-organisation ltv_gbp source could not be read this cycle; no figure is shown rather than a fabricated zero.";
    return [
      insufficient("ltv_total", "LTV (total, cached)", "gbp", basis),
      insufficient("ltv_avg", "LTV (average, cached)", "gbp", basis),
    ];
  }
  // Recorded = a non-null, positive cached figure. The column defaults to 0 for
  // orgs nobody has estimated yet — a 0/null is "unrecorded", not "worth £0".
  const recorded = ltvs.filter((v): v is number => v != null && v > 0);
  if (recorded.length === 0) {
    const basis = `None of the ${ltvs.length} active organisation${ltvs.length === 1 ? "" : "s"} has a recorded ltv_gbp yet, so no lifetime value is computed (an unrecorded LTV is not £0).`;
    return [
      insufficient("ltv_total", "LTV (total, cached)", "gbp", basis),
      insufficient("ltv_avg", "LTV (average, cached)", "gbp", basis),
    ];
  }
  const total = round2(recorded.reduce((s, v) => s + v, 0));
  const excluded = ltvs.length - recorded.length;
  const suffix =
    excluded > 0
      ? ` ${excluded} org${excluded === 1 ? "" : "s"} without a recorded value excluded (never counted as £0).`
      : "";
  return [
    derived(
      "ltv_total",
      "LTV (total, cached)",
      total,
      "gbp",
      `Sum of cached organizations.ltv_gbp across the ${recorded.length} active org${recorded.length === 1 ? "" : "s"} with a recorded value.${suffix}`,
    ),
    derived(
      "ltv_avg",
      "LTV (average, cached)",
      round2(total / recorded.length),
      "gbp",
      `Total cached LTV ÷ the ${recorded.length} active org${recorded.length === 1 ? "" : "s"} with a recorded value.${suffix}`,
    ),
  ];
}

/**
 * The deterministic 3-month pipeline-weighted recurring-revenue forecast:
 *
 *   winRate        = approved ÷ decided        (decided = approved + rejected + cancelled)
 *   pipelineMrr    = winRate × livePipeline × list price
 *   forecast (3mo) = 3 × (current MRR + pipelineMrr)
 *
 * Every input is a real demo_requests lifecycle count; pipeline conversions are
 * priced at the list price because a pipeline deal has no contracted mrr_gbp
 * yet, and the basis states the simplifying assumption (weighted conversions
 * counted from the start of the window — an upper-bound framing, said plainly).
 * Below FORECAST_MIN_DECIDED_DEMOS decided outcomes the win rate would be
 * noise, so the metric is honestly insufficient.
 */
function forecastMetric(
  demos: FinanceInput["demoLifecycle"],
  mrr: number,
  price: number,
): FinanceMetric {
  const KEY = "revenue_forecast_3m";
  const LABEL = "Revenue forecast (3 months)";
  if (demos == null) {
    return insufficient(
      KEY,
      LABEL,
      "gbp",
      "The demo-request lifecycle source could not be read this cycle; no forecast is shown rather than a fabricated one.",
    );
  }
  const decided =
    Math.max(0, demos.approved) + Math.max(0, demos.rejected) + Math.max(0, demos.cancelled);
  if (decided < FORECAST_MIN_DECIDED_DEMOS) {
    return insufficient(
      KEY,
      LABEL,
      "gbp",
      `Only ${decided} demo request${decided === 1 ? "" : "s"} ever reached a decision — below the minimum sample of ${FORECAST_MIN_DECIDED_DEMOS} needed to estimate a win rate honestly.`,
    );
  }
  const winRate = Math.max(0, demos.approved) / decided;
  const pipeline = Math.max(0, demos.pendingDemo) + Math.max(0, demos.demoBooked);
  const pipelineMrr = winRate * pipeline * price;
  const forecast = round2(3 * (mrr + pipelineMrr));
  return derived(
    KEY,
    LABEL,
    forecast,
    "gbp",
    `3 × (current MRR £${round2(mrr)} + win-rate-weighted pipeline: ${Math.round(winRate * 100)}% historical demo win rate (${demos.approved} of ${decided} decided) × ${pipeline} live pipeline request${pipeline === 1 ? "" : "s"} × £${price} list price). Assumes weighted conversions from the start of the window — an upper-bound framing.`,
  );
}
