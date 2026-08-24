import { round2 } from "@/lib/money";
import type { JobBudgetPosition } from "@/lib/jobs/budget";
import { labelled, type LabelledMetric } from "./provenance";

/**
 * CVR ORG ROLLUP — forecast cost variance across every job that HAS a budget.
 * PURE.
 *
 * COMPOSES `computeJobBudgetPosition` (lib/jobs/budget.ts) and adds ONE piece
 * of arithmetic: a sum of the per-job `forecastVariance` figures. Everything
 * inside each position — forecast final cost = actual + remaining committed,
 * the ex-VAT discipline, the bill-beats-PO precedence — is the budget
 * authority's, unchanged. If a job's number is wrong the defect is THERE.
 *
 * ── ONLY JOBS WITH A BUDGET ARE IN THE TOTAL ────────────────────────────────
 * `forecastVariance` on a job with no baseline is `revisedBudget(0) −
 * forecast`, i.e. minus-everything-you've-spent — a fiction the NO_BUDGET
 * convention exists to refuse ("£0 budget, 100 % over" is the lie a default
 * would tell). So unbudgeted jobs are COUNTED and disclosed, never summed.
 *
 * ── THE FLOOR-FORECAST CAVEAT TRAVELS WITH THE NUMBER ───────────────────────
 * The forecast is a FLOOR, not a prophecy (lib/jobs/budget.ts header): it
 * knows money spent and money ordered, and nothing about labour still to be
 * worked or materials not yet ordered. The basis states this verbatim,
 * because an org-level "£12k under plan" read as a prophecy is exactly how a
 * floor gets mistaken for a ceiling.
 *
 * ── TWO METRICS, TWO KINDS ──────────────────────────────────────────────────
 *   the TOTAL   derived — Σ of exact per-job figures.
 *   the BANDS   heuristic — "red" (forecast already over budget) is a fact of
 *               the comparison, but "amber" (headroom under
 *               CVR_AMBER_HEADROOM_PCT %) is a chosen warning line, so the
 *               banding as a whole ships as a heuristic with the threshold
 *               stated verbatim. No composite: a job is listed under its
 *               band with its own numbers, never scored.
 */

/** Forecast headroom (as % of revised budget) below which a job reads amber. */
export const CVR_AMBER_HEADROOM_PCT = 10;

export type CvrBand = "red" | "amber" | "ok";

export type CvrJobInput = {
  jobId: string;
  label: string | null;
  href: string;
  position: JobBudgetPosition;
};

export type CvrJobLine = {
  jobId: string;
  label: string | null;
  href: string;
  band: CvrBand;
  revisedBudget: number;
  forecastFinalCost: number;
  forecastVariance: number;
  forecastVariancePct: number | null;
};

export type CvrRollup = {
  /** Jobs given to the rollup (the caller's active set). */
  jobsConsidered: number;
  jobsWithBudget: number;
  /** Disclosed, never summed (see the header). */
  jobsWithoutBudget: number;
  /** Σ forecastVariance over budgeted jobs. Positive = forecast under plan. */
  forecastVarianceTotal: number;
  redCount: number;
  amberCount: number;
  /** Budgeted jobs, worst first (red, then amber, then ok; most over first). */
  lines: CvrJobLine[];
};

/** The banding rule — exported so the test pins it and the basis quotes it. */
export function cvrBand(p: JobBudgetPosition): CvrBand {
  if (!p.hasBudget) return "ok"; // unbudgeted jobs never reach a band; guarded by caller.
  if (p.forecastOverBudget) return "red";
  if (p.forecastVariancePct != null && p.forecastVariancePct < CVR_AMBER_HEADROOM_PCT) {
    return "amber";
  }
  return "ok";
}

const BAND_RANK: Record<CvrBand, number> = { red: 0, amber: 1, ok: 2 };

export function computeCvrRollup(jobs: readonly CvrJobInput[]): CvrRollup {
  const budgeted = jobs.filter((j) => j.position.hasBudget);

  const lines: CvrJobLine[] = budgeted.map((j) => ({
    jobId: j.jobId,
    label: j.label,
    href: j.href,
    band: cvrBand(j.position),
    revisedBudget: j.position.revisedBudget,
    forecastFinalCost: j.position.forecastFinalCost,
    forecastVariance: j.position.forecastVariance,
    forecastVariancePct: j.position.forecastVariancePct,
  }));

  lines.sort(
    (a, b) =>
      BAND_RANK[a.band] - BAND_RANK[b.band] ||
      a.forecastVariance - b.forecastVariance ||
      a.jobId.localeCompare(b.jobId),
  );

  return {
    jobsConsidered: jobs.length,
    jobsWithBudget: budgeted.length,
    jobsWithoutBudget: jobs.length - budgeted.length,
    forecastVarianceTotal: round2(
      budgeted.reduce((s, j) => s + j.position.forecastVariance, 0),
    ),
    redCount: lines.filter((l) => l.band === "red").length,
    amberCount: lines.filter((l) => l.band === "amber").length,
    lines,
  };
}

/** The org total: DERIVED — Σ of the budget authority's exact per-job figures. */
export function cvrTotalMetric(r: CvrRollup): LabelledMetric<CvrRollup> {
  return labelled(r, {
    kind: "derived",
    basis:
      "Sum of each budgeted job's forecast variance (revised budget − forecast final cost), " +
      "where forecast final cost = actual spend + committed-but-unbilled orders. That forecast " +
      "is a FLOOR, not a prophecy: it knows nothing about labour still to be worked or " +
      "materials not yet ordered, so the true final cost can only be higher. Jobs with no cost " +
      `baseline (${r.jobsWithoutBudget}) are disclosed and excluded — a £0 budget would make ` +
      "every pound spent read as overrun.",
    computedFrom: [
      { label: "Job budgets", href: "/jobs" },
      { label: "Costs", href: "/finances" },
      { label: "Purchase orders", href: "/purchase-orders" },
    ],
  });
}

/** The bands: HEURISTIC — the amber line is a chosen threshold, stated. */
export function cvrBandsMetric(
  r: CvrRollup,
): LabelledMetric<{ redCount: number; amberCount: number; lines: CvrJobLine[] }> {
  return labelled(
    { redCount: r.redCount, amberCount: r.amberCount, lines: r.lines },
    {
      kind: "heuristic",
      basis:
        "Red = the floor forecast already exceeds the revised budget (an exact comparison). " +
        `Amber = forecast headroom under ${CVR_AMBER_HEADROOM_PCT}% of the revised budget — a ` +
        "chosen warning line, not a measurement. Each job is listed with its own figures; " +
        "there is no combined score.",
      computedFrom: [{ label: "Job budgets", href: "/jobs" }],
    },
  );
}
