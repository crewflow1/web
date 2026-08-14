import type { ProgressRollup } from "./progress-rollup";
import type { ProgrammeVarianceRollup } from "./programme-variance";
import { labelled, type LabelledMetric } from "./provenance";

/**
 * DELAY / DELIVERY RISK — a per-job board of INDEPENDENT recorded signals. PURE.
 *
 * ── NO BLENDED GRADE (the house doctrine, applied to risk) ──────────────────
 * A single "delay score" would need an exchange rate between "14 days behind
 * plan" and "21 days of silence on the progress series", and nothing in this
 * database knows it (lib/suppliers/performance.ts points 1–2; the
 * lib/health/company-health.ts header). So this module NEVER emits one. Each job
 * carries a LIST of the factors that actually tripped, each with its own
 * severity and the threshold that fired, plus a COUNT of how many are `high` —
 * a tally of independent facts, not a weighted composite. `highFactorCount` is
 * "how many red thresholds tripped", never "how bad, out of 100".
 *
 * ── COMPOSE, DON'T RE-DETECT ────────────────────────────────────────────────
 * Every factor is read from an authority that already owns it: behind-baseline
 * from programme variance (lib/intelligence/programme-variance), stalled and
 * regressing from the progress rollup (lib/intelligence/progress-rollup). This
 * module adds only the banding — the one opinion, stated verbatim in `basis`.
 * Milestone and Extension-of-Time exposure are org-level in the programme
 * authority (not attributed per job there), so they are surfaced as board-level
 * context, not invented onto individual jobs.
 *
 * ── HONESTY ─────────────────────────────────────────────────────────────────
 * A job appears ONLY when a real signal fired — no job is asserted "at risk"
 * off missing data, and a job never measured is not on the board (the progress
 * rollup counts those separately, and a job with no baseline is a programme-gap,
 * not a delay). An empty board means the recorded signals show nothing, stated
 * as such — never a green "all on track" over jobs nobody has measured.
 *
 * ── KIND: HEURISTIC ─────────────────────────────────────────────────────────
 * The banding thresholds are choices; they live in one `DEFAULT_DELAY_THRESHOLDS`
 * config object and are printed in the metric basis, so a surface can never show
 * a severity without the rule that produced it.
 *
 * PURE: no I/O, no clock. Takes the already-computed rollups.
 */

export type RiskSeverity = "watch" | "high";

export const DELAY_FACTOR_KEYS = [
  "behind_baseline",
  "stalled",
  "regressing",
] as const;
export type DelayFactorKey = (typeof DELAY_FACTOR_KEYS)[number];

export const DELAY_FACTOR_LABEL: Record<DelayFactorKey, string> = {
  behind_baseline: "Behind baseline",
  stalled: "Progress stalled",
  regressing: "Progress went backwards",
};

export type DelayFactor = {
  key: DelayFactorKey;
  severity: RiskSeverity;
  /** The concrete figure that fired, e.g. "18 days past planned end". */
  detail: string;
};

export type JobDelayRisk = {
  jobId: string;
  label: string | null;
  href: string;
  factors: DelayFactor[];
  /** Count of `high` factors on this job — a tally, NOT a weighted score. */
  highFactorCount: number;
  watchFactorCount: number;
};

export type DelayRiskBoard = {
  jobs: JobDelayRisk[];
  /** Jobs the composed authorities were able to assess. */
  jobsConsidered: number;
  /** Jobs carrying ≥ 1 high factor. */
  jobsAtRisk: number;
  /** Jobs carrying watch factors but no high factor. */
  jobsWatch: number;
  factorCounts: Record<DelayFactorKey, number>;
  /** Board-level programme context (org-wide in the authority, not per job). */
  overdueMilestoneCount: number;
  openEotWorkingDaysLost: number;
};

export const DEFAULT_DELAY_THRESHOLDS = {
  /** Behind baseline by ≥ this many days is `high` (below it, `watch`). */
  behindHighDays: 14,
  /** Stalled for ≥ this many days is `high`. */
  stalledHighDays: 21,
  /** A progress drop of ≥ this many points is `high`. */
  regressHighPct: 10,
} as const;

export type DelayThresholds = typeof DEFAULT_DELAY_THRESHOLDS;

export function computeDelayRiskBoard(
  input: {
    programme: ProgrammeVarianceRollup;
    progress: ProgressRollup;
  },
  thresholds: DelayThresholds = DEFAULT_DELAY_THRESHOLDS,
): DelayRiskBoard {
  const byJob = new Map<string, JobDelayRisk>();

  const ensure = (jobId: string, label: string | null, href: string): JobDelayRisk => {
    let row = byJob.get(jobId);
    if (!row) {
      row = { jobId, label, href, factors: [], highFactorCount: 0, watchFactorCount: 0 };
      byJob.set(jobId, row);
    } else if (row.label == null && label != null) {
      row.label = label;
    }
    return row;
  };

  const add = (row: JobDelayRisk, factor: DelayFactor) => {
    row.factors.push(factor);
    if (factor.severity === "high") row.highFactorCount += 1;
    else row.watchFactorCount += 1;
  };

  // Behind baseline — from the programme authority.
  for (const j of input.programme.behindBaseline) {
    const row = ensure(j.jobId, j.label, j.href);
    add(row, {
      key: "behind_baseline",
      severity: j.daysOverdue >= thresholds.behindHighDays ? "high" : "watch",
      detail: `${j.daysOverdue} day${j.daysOverdue === 1 ? "" : "s"} past planned end`,
    });
  }

  // Stalled — from the progress rollup (already filtered past the silence floor).
  for (const j of input.progress.stalled) {
    const row = ensure(j.jobId, j.label, j.href);
    add(row, {
      key: "stalled",
      severity: j.daysSince >= thresholds.stalledHighDays ? "high" : "watch",
      detail: `${j.daysSince} days without a reading, last at ${j.lastPercent}%`,
    });
  }

  // Regressing — from the progress rollup.
  for (const j of input.progress.regressing) {
    const row = ensure(j.jobId, j.label, j.href);
    add(row, {
      key: "regressing",
      severity: j.drop >= thresholds.regressHighPct ? "high" : "watch",
      detail: `fell ${j.fromPercent}% → ${j.latestPercent}% (−${j.drop})`,
    });
  }

  const jobs = [...byJob.values()].sort(
    (a, b) =>
      b.highFactorCount - a.highFactorCount ||
      b.watchFactorCount - a.watchFactorCount ||
      (a.label ?? "").localeCompare(b.label ?? "") ||
      a.jobId.localeCompare(b.jobId),
  );

  const factorCounts: Record<DelayFactorKey, number> = {
    behind_baseline: 0,
    stalled: 0,
    regressing: 0,
  };
  for (const job of jobs) {
    for (const f of job.factors) factorCounts[f.key] += 1;
  }

  return {
    jobs,
    // The programme authority's considered set is the widest measured population.
    jobsConsidered: Math.max(input.programme.jobsConsidered, input.progress.activeJobs),
    jobsAtRisk: jobs.filter((j) => j.highFactorCount > 0).length,
    jobsWatch: jobs.filter((j) => j.highFactorCount === 0 && j.watchFactorCount > 0).length,
    factorCounts,
    overdueMilestoneCount: input.programme.overdueMilestoneCount,
    openEotWorkingDaysLost: input.programme.openEotWorkingDaysLost,
  };
}

// ---------------------------------------------------------------------------
// Labelled metric
// ---------------------------------------------------------------------------

export function delayRiskMetric(
  board: DelayRiskBoard,
  thresholds: DelayThresholds = DEFAULT_DELAY_THRESHOLDS,
): LabelledMetric<DelayRiskBoard> {
  return labelled(board, {
    kind: "heuristic",
    basis:
      "Each job lists only the delay signals that actually fired, each with the figure behind it: " +
      `behind baseline (high at ≥ ${thresholds.behindHighDays} days past planned end), progress ` +
      `stalled (high at ≥ ${thresholds.stalledHighDays} days without a reading) and progress ` +
      `going backwards (high at a drop of ≥ ${thresholds.regressHighPct} points). There is no ` +
      "combined delay score — the factors have different units and no honest exchange rate — only " +
      "a count of how many high signals a job carries. A job appears only when a real signal fired.",
    computedFrom: [
      { label: "Programme", href: "/insights" },
      { label: "Job progress", href: "/insights" },
    ],
  });
}
