import { round2, sumMoney, toPounds } from "@/lib/money";
import { COST_BUCKETS, type CostBucket } from "@/lib/profitability/compute";

/**
 * Job cost baseline — budget vs actual, variance, forecast final cost, and the
 * cost-value reconciliation. PURE and DETERMINISTIC: numbers in, numbers out,
 * no client, no clock, no AI.
 *
 * ── THE ACCOUNTING BOUNDARY ─────────────────────────────────────────────────
 * A budget is a PLAN, not a transaction. Nothing here writes anywhere, and the
 * baseline never becomes a cost: it is compared with `finances`, never posted to
 * it. A planned figure in the actual-cost ledger would be double-counted the
 * moment the real supplier bill arrived and would silently inflate the job's
 * cost — the same double-count hazard the operational-stock milestone shipped on
 * (CEO decision D1 still undecided there). Swept by
 * __tests__/security/job-budgets.test.ts. This module does not even NAME the
 * ledger: it takes already-aggregated actuals as arguments.
 *
 * ── WHAT IT COMPOSES (nothing is re-derived) ────────────────────────────────
 *   actual        ← computeJobProfitability() — lib/profitability/compute.ts
 *                   (Σ finances.amount ex-VAT, already bucketed by
 *                   mapToCostBucket, so plan and actual share one taxonomy)
 *   remaining     ← computeCommittedCosts().remaining — lib/purchase-orders/committed.ts
 *                   (ex-VAT commitment not yet billed, floored per PO)
 *   revisedValue  ← computeJobCommercialPosition().revisedNet — lib/jobs/commercial-position.ts
 *                   (original + ACCEPTED variations, ex-VAT)
 *
 * ── FORECAST FINAL COST = ACTUAL + REMAINING COMMITTED ──────────────────────
 * The standard construction: cost to date + cost to complete. Both sides are
 * ex-VAT, and `remaining` has already subtracted the bills posted against each
 * PO (`finances.purchase_order_id`, 20261009), so a received-and-billed order
 * is counted exactly once.
 *
 * It is a FLOOR, not a prophecy, and the UI must say so: it knows about money
 * already spent and money already ordered. Labour still to be worked and
 * materials not yet ordered are in neither, so a job with a real baseline and no
 * POs forecasts at its actual cost. Stated, not hidden.
 *
 * One deliberate asymmetry in the safe direction: per-PO `billed` is measured
 * from the costs attributed to THIS job, so a bill re-attributed to another job
 * leaves its commitment still counted here. The forecast then errs HIGH, never
 * low — the only tolerable direction for a cost forecast.
 *
 * ── WHY THERE IS NO PER-BUCKET FORECAST ─────────────────────────────────────
 * Purchase orders carry no cost bucket (PO lines are free text, 20261006), so
 * apportioning `remaining` across labour/materials/subcontractors/misc would be
 * a guess presented as a figure. Per-bucket goes as far as the data does —
 * budget vs actual and its variance — and the forecast stays at job level.
 */

/** The four existing buckets, as an optional plan. */
export type BudgetBuckets = Record<CostBucket, number>;

/** A `job_budgets` row (the CURRENT revision), as read. */
export type JobBudgetRow = {
  revision: number | string | null;
  total_cost: number | string | null;
  labour_cost: number | string | null;
  materials_cost: number | string | null;
  subcontractors_cost: number | string | null;
  misc_cost: number | string | null;
  target_margin_pct: number | string | null;
  note: string | null;
  created_at: string | null;
};

/**
 * A `quote_cost_estimates` row for an ACCEPTED variation — the cost side of an
 * approved scope change, mirroring how its `total` joins the revised value.
 */
export type VariationCostEstimate = {
  total_cost: number | string | null;
  labour_cost: number | string | null;
  materials_cost: number | string | null;
  subcontractors_cost: number | string | null;
  misc_cost: number | string | null;
};

export type BudgetBucketLine = {
  bucket: CostBucket;
  /** null when the baseline carries no bucket detail. */
  budget: number | null;
  actual: number;
  /** budget − actual. Positive = under budget. null without detail. */
  variance: number | null;
  /** variance as a % of budget. null without detail, or when budget is 0. */
  variancePct: number | null;
};

export type JobBudgetPosition = {
  /** False when the job has no current baseline — every figure below is 0/null. */
  hasBudget: boolean;
  /** Revision number of the current baseline (0 when there is none). */
  revision: number;
  /** When the current baseline was set. */
  setAt: string | null;
  /** The reason given for this revision (null on revision 1). */
  note: string | null;

  /** The baseline as set, ex-VAT. */
  baseline: number;
  /** Σ cost estimates of ACCEPTED variations, ex-VAT. */
  approvedVariationCost: number;
  /** baseline + approvedVariationCost — the plan as it stands today. */
  revisedBudget: number;
  /** True when the baseline carries the four-bucket breakdown. */
  hasBucketDetail: boolean;
  /** Always four rows, in COST_BUCKETS order. */
  buckets: BudgetBucketLine[];

  /** Σ actual cost to date, ex-VAT. */
  actual: number;
  /** revisedBudget − actual. Positive = headroom left. */
  variance: number;
  /** variance as a % of revisedBudget. null when there is no budget to divide by. */
  variancePct: number | null;
  /** True once actual has passed the revised budget. */
  overBudget: boolean;

  /** Ex-VAT commitment ordered but not yet billed (from committed.ts). */
  remainingCommitted: number;
  /** actual + remainingCommitted. */
  forecastFinalCost: number;
  /** revisedBudget − forecastFinalCost. Positive = forecast lands under plan. */
  forecastVariance: number;
  forecastVariancePct: number | null;
  /** True when the forecast lands over the revised budget. */
  forecastOverBudget: boolean;

  /** Ex-VAT revised contract value — the reconciliation denominator. */
  revisedValue: number;
  /** revisedValue − revisedBudget: the profit the PLAN promises. */
  plannedProfit: number;
  plannedMarginPct: number | null;
  /** revisedValue − forecastFinalCost: the profit the FORECAST implies. */
  forecastProfit: number;
  forecastMarginPct: number | null;
  /** The per-job target, when set — what marginBand() should band against. */
  targetMarginPct: number | null;
};

const ZERO_BUCKETS: BudgetBuckets = {
  labour: 0,
  materials: 0,
  subcontractors: 0,
  misc: 0,
};

/** Read a row's four bucket columns, or null when the detail is absent. */
export function budgetBuckets(row: JobBudgetRow | null): BudgetBuckets | null {
  if (!row) return null;
  // The DB CHECK makes detail all-four-or-none, so testing one is testing all;
  // the loop below still reads every column so a hand-written row that somehow
  // has partial detail cannot silently contribute a phantom bucket.
  if (row.labour_cost == null) return null;
  return {
    labour: toPounds(row.labour_cost),
    materials: toPounds(row.materials_cost),
    subcontractors: toPounds(row.subcontractors_cost),
    misc: toPounds(row.misc_cost),
  };
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return round2((numerator / denominator) * 100);
}

/** The empty position — what every surface renders for a job with no baseline. */
export const NO_BUDGET: JobBudgetPosition = {
  hasBudget: false,
  revision: 0,
  setAt: null,
  note: null,
  baseline: 0,
  approvedVariationCost: 0,
  revisedBudget: 0,
  hasBucketDetail: false,
  buckets: COST_BUCKETS.map((bucket) => ({
    bucket,
    budget: null,
    actual: 0,
    variance: null,
    variancePct: null,
  })),
  actual: 0,
  variance: 0,
  variancePct: null,
  overBudget: false,
  remainingCommitted: 0,
  forecastFinalCost: 0,
  forecastVariance: 0,
  forecastVariancePct: null,
  forecastOverBudget: false,
  revisedValue: 0,
  plannedProfit: 0,
  plannedMarginPct: null,
  forecastProfit: 0,
  forecastMarginPct: null,
  targetMarginPct: null,
};

export function computeJobBudgetPosition(input: {
  /** The CURRENT `job_budgets` revision, or null when the job has none. */
  budget: JobBudgetRow | null;
  /** Cost estimates for the job's ACCEPTED variations only. */
  approvedVariationEstimates: VariationCostEstimate[];
  /** Σ actual cost ex-VAT — `computeJobProfitability().costs_total`. */
  actualTotal: number;
  /** Actual cost per bucket — `computeJobProfitability().costs_by_bucket`. */
  actualByBucket: BudgetBuckets;
  /** Ex-VAT commitment not yet billed — `computeCommittedCosts().remaining`. */
  remainingCommitted: number;
  /** Ex-VAT revised contract value — `computeJobCommercialPosition().revisedNet`. */
  revisedValueNet: number;
}): JobBudgetPosition {
  const actual = round2(toPounds(input.actualTotal));
  const remainingCommitted = round2(Math.max(0, toPounds(input.remainingCommitted)));
  const forecastFinalCost = round2(actual + remainingCommitted);
  const revisedValue = round2(toPounds(input.revisedValueNet));

  if (!input.budget) {
    // No baseline: forecast and reconciliation are still real (they need no
    // plan), but every budget/variance figure stays absent rather than 0 —
    // "£0 budget, 100 % over" is the lie a default would tell.
    return {
      ...NO_BUDGET,
      buckets: COST_BUCKETS.map((bucket) => ({
        bucket,
        budget: null,
        actual: round2(toPounds(input.actualByBucket[bucket])),
        variance: null,
        variancePct: null,
      })),
      actual,
      remainingCommitted,
      forecastFinalCost,
      revisedValue,
      forecastProfit: round2(revisedValue - forecastFinalCost),
      forecastMarginPct: pct(round2(revisedValue - forecastFinalCost), revisedValue),
    };
  }

  const baseline = round2(toPounds(input.budget.total_cost));
  const approvedVariationCost = sumMoney(
    input.approvedVariationEstimates.map((e) => e.total_cost),
  );
  const revisedBudget = round2(baseline + approvedVariationCost);

  // Bucket detail. An approved variation's estimate is always fully bucketed
  // (computeVariation produces all four), so its buckets are folded in whenever
  // the baseline itself carries detail — otherwise the bucket rows would sum to
  // less than the revised budget and the column would not add up.
  const baseBuckets = budgetBuckets(input.budget);
  const hasBucketDetail = baseBuckets !== null;
  const plannedByBucket: BudgetBuckets = { ...(baseBuckets ?? ZERO_BUCKETS) };
  if (hasBucketDetail) {
    for (const e of input.approvedVariationEstimates) {
      plannedByBucket.labour = round2(plannedByBucket.labour + toPounds(e.labour_cost));
      plannedByBucket.materials = round2(plannedByBucket.materials + toPounds(e.materials_cost));
      plannedByBucket.subcontractors = round2(
        plannedByBucket.subcontractors + toPounds(e.subcontractors_cost),
      );
      plannedByBucket.misc = round2(plannedByBucket.misc + toPounds(e.misc_cost));
    }
  }

  const buckets: BudgetBucketLine[] = COST_BUCKETS.map((bucket) => {
    const actualBucket = round2(toPounds(input.actualByBucket[bucket]));
    if (!hasBucketDetail) {
      return { bucket, budget: null, actual: actualBucket, variance: null, variancePct: null };
    }
    const budgetBucket = round2(plannedByBucket[bucket]);
    const variance = round2(budgetBucket - actualBucket);
    return {
      bucket,
      budget: budgetBucket,
      actual: actualBucket,
      variance,
      variancePct: pct(variance, budgetBucket),
    };
  });

  const variance = round2(revisedBudget - actual);
  const forecastVariance = round2(revisedBudget - forecastFinalCost);
  const plannedProfit = round2(revisedValue - revisedBudget);
  const forecastProfit = round2(revisedValue - forecastFinalCost);
  const targetRaw = input.budget.target_margin_pct;

  return {
    hasBudget: true,
    revision: Math.max(1, Math.trunc(Number(input.budget.revision ?? 1)) || 1),
    setAt: input.budget.created_at ?? null,
    note: input.budget.note ?? null,

    baseline,
    approvedVariationCost,
    revisedBudget,
    hasBucketDetail,
    buckets,

    actual,
    variance,
    variancePct: pct(variance, revisedBudget),
    overBudget: actual > revisedBudget,

    remainingCommitted,
    forecastFinalCost,
    forecastVariance,
    forecastVariancePct: pct(forecastVariance, revisedBudget),
    forecastOverBudget: forecastFinalCost > revisedBudget,

    revisedValue,
    plannedProfit,
    plannedMarginPct: pct(plannedProfit, revisedValue),
    forecastProfit,
    forecastMarginPct: pct(forecastProfit, revisedValue),
    targetMarginPct: targetRaw == null ? null : toPounds(targetRaw),
  };
}

/**
 * Is there any FIGURE worth showing? False only for a job with no baseline, no
 * spend and nothing on order — where the honest surface is the prompt to set a
 * budget, not a row of zeroes.
 */
export function hasBudgetPosition(p: JobBudgetPosition): boolean {
  return p.hasBudget || p.actual > 0 || p.remainingCommitted > 0;
}

/**
 * Tone for a variance figure, from the viewer's point of view: money left is
 * good, money over is bad, exactly on plan is neutral.
 */
export type VarianceTone = "good" | "bad" | "neutral";

export function varianceTone(variance: number): VarianceTone {
  if (variance > 0) return "good";
  if (variance < 0) return "bad";
  return "neutral";
}
