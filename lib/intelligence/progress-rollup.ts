import { daysBetween } from "@/lib/schedule/window";
import {
  PROGRESS_STALE_AFTER_DAYS,
  type ProgressPoint,
  type ProgressSummary,
} from "@/lib/job-progress/series";
import { labelled, type LabelledMetric } from "./provenance";

/**
 * JOB PROGRESS ROLLUP — the org-level stalled / regressing detector. PURE.
 *
 * COMPOSE, DON'T RE-DETECT. Every input here is the OUTPUT of
 * lib/job-progress/series.ts (`buildProgressSeries` + `summariseProgress`),
 * fetched by the existing read layer (server/services/job-progress.ts's
 * batched `loadProgressForJobs`). This module never reads
 * `job_progress_observations` or `site_reports` and never re-implements the
 * observation-beats-report collision rule — the enforced house rule
 * /operations was pinned on: where a series authority exists, downstream
 * surfaces consume it, they do not re-derive it.
 *
 * TWO DETECTORS, TWO KINDS — deliberately not one:
 *
 *   STALLED (heuristic) — an ACTIVE job with readings whose latest reading is
 *   older than PROGRESS_STALE_AFTER_DAYS (14 — the series module's own
 *   staleness constant, composed rather than re-declared; weekly reporting is
 *   the UK site norm, so a silent fortnight means the number on screen is no
 *   longer evidence). "14 days" is a chosen threshold, so the verdict is
 *   labelled heuristic and the rule is stated verbatim in the basis.
 *
 *   REGRESSING (derived) — the latest reading is LOWER than a reading taken
 *   at least REGRESSION_LOOKBACK_DAYS (7) earlier. That is an exact
 *   comparison of two recorded observations — rework, a failed inspection, a
 *   re-measure — not a judgement. The 7-day lookback exists only to skip
 *   same-week measurement noise and is stated; the comparison itself is
 *   arithmetic.
 *
 * Jobs with NO readings at all are a third population ("never assessed") and
 * are NOT called stalled: a job nobody has ever measured has nothing to go
 * stale. Collapsing the two would punish teams for not using a feature by
 * telling them their jobs are stuck.
 *
 * ACTIVE means `jobs.status === 'in-progress'` (lib/jobs/schema.ts's enum:
 * new / in-progress / completed / blocked). A 'new' job has not started, a
 * 'completed' one is finished, and a 'blocked' one is ALREADY flagged by its
 * own status — re-flagging it as stalled would double-report one fact.
 */

export const ACTIVE_JOB_STATUS = "in-progress";

/** Days of silence before an active job's series is called stalled. */
export const STALLED_AFTER_DAYS = PROGRESS_STALE_AFTER_DAYS;

/** Minimum age gap of the comparison point for a regression verdict. */
export const REGRESSION_LOOKBACK_DAYS = 7;

// ---------------------------------------------------------------------------
// Input — one active job with its series authority outputs
// ---------------------------------------------------------------------------

export type ProgressJobInput = {
  jobId: string;
  label: string | null;
  href: string;
  /** From buildProgressSeries — oldest first. */
  points: readonly ProgressPoint[];
  /** From summariseProgress, same series, same `now`. */
  summary: ProgressSummary;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type StalledJob = {
  jobId: string;
  label: string | null;
  href: string;
  lastDay: string;
  daysSince: number;
  lastPercent: number;
};

export type RegressingJob = {
  jobId: string;
  label: string | null;
  href: string;
  /** The earlier, higher reading it fell from. */
  fromDay: string;
  fromPercent: number;
  latestDay: string;
  latestPercent: number;
  /** fromPercent − latestPercent (always positive here). */
  drop: number;
};

export type ProgressRollup = {
  activeJobs: number;
  /** Active jobs with at least one reading. */
  assessedJobs: number;
  /** Active jobs with no reading at all — NOT stalled (see the header). */
  neverAssessed: number;
  stalled: StalledJob[];
  regressing: RegressingJob[];
};

/**
 * Roll active jobs' series up into the two org-level lists.
 *
 * `todayKey` is the London day the page rendered for — injected, never read
 * from a clock, so the rollup and every per-job panel agree on what "today"
 * is.
 */
export function computeProgressRollup(
  jobs: readonly ProgressJobInput[],
  todayKey: string,
): ProgressRollup {
  const stalled: StalledJob[] = [];
  const regressing: RegressingJob[] = [];
  let assessed = 0;

  for (const job of jobs) {
    const latest = job.summary.latest;
    if (!latest) continue; // never assessed — counted below, never flagged.
    assessed += 1;

    const daysSince = Math.max(0, daysBetween(latest.day, todayKey));
    if (daysSince > STALLED_AFTER_DAYS) {
      stalled.push({
        jobId: job.jobId,
        label: job.label,
        href: job.href,
        lastDay: latest.day,
        daysSince,
        lastPercent: latest.percent,
      });
    }

    // REGRESSING: latest < some reading at least REGRESSION_LOOKBACK_DAYS
    // older. The HIGHEST qualifying earlier reading is reported, because the
    // honest size of the fall is measured from the best position the job had
    // held, not from a convenient lower one.
    let from: ProgressPoint | null = null;
    for (const p of job.points) {
      if (daysBetween(p.day, latest.day) < REGRESSION_LOOKBACK_DAYS) continue;
      if (p.percent <= latest.percent) continue;
      if (!from || p.percent > from.percent) from = p;
    }
    if (from) {
      regressing.push({
        jobId: job.jobId,
        label: job.label,
        href: job.href,
        fromDay: from.day,
        fromPercent: from.percent,
        latestDay: latest.day,
        latestPercent: latest.percent,
        drop: from.percent - latest.percent,
      });
    }
  }

  // Worst first, then the unique id so the order is total.
  stalled.sort((a, b) => b.daysSince - a.daysSince || a.jobId.localeCompare(b.jobId));
  regressing.sort((a, b) => b.drop - a.drop || a.jobId.localeCompare(b.jobId));

  return {
    activeJobs: jobs.length,
    assessedJobs: assessed,
    neverAssessed: jobs.length - assessed,
    stalled,
    regressing,
  };
}

/** Stalled list: HEURISTIC — the 14-day rule is a chosen threshold, stated. */
export function stalledMetric(r: ProgressRollup): LabelledMetric<StalledJob[]> {
  return labelled(r.stalled, {
    kind: "heuristic",
    basis:
      `An in-progress job with progress readings whose latest reading is more than ` +
      `${STALLED_AFTER_DAYS} days old (rule: ${STALLED_AFTER_DAYS} days — weekly reporting is ` +
      "the site norm, so a silent fortnight means the last figure is no longer evidence). " +
      `Jobs never assessed at all are counted separately (${r.neverAssessed}), not called stalled.`,
    computedFrom: [{ label: "Job progress readings", href: "/jobs" }],
  });
}

/** Regressing list: DERIVED — an exact comparison of two recorded readings. */
export function regressingMetric(r: ProgressRollup): LabelledMetric<RegressingJob[]> {
  return labelled(r.regressing, {
    kind: "derived",
    basis:
      "The job's latest progress reading is lower than a reading taken at least " +
      `${REGRESSION_LOOKBACK_DAYS} days earlier — an exact comparison of two recorded ` +
      "observations (rework, a failed inspection, a re-measure), measured from the highest " +
      "qualifying earlier reading.",
    computedFrom: [{ label: "Job progress readings", href: "/jobs" }],
  });
}
