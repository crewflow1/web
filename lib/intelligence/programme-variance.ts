import { daysBetween } from "@/lib/schedule/window";
import { type DelayEventStatus } from "@/lib/eot/lifecycle";
import type {
  ProgrammeBaselineRow,
  ProgrammeMilestoneRow,
} from "@/lib/job-programme/planned";
import { labelled, type LabelledMetric } from "./provenance";

/**
 * PROGRAMME VARIANCE ROLLUP — the org-level PLANNED-vs-actual and
 * delay-exposure counterpart to lib/intelligence/progress-rollup.ts. PURE.
 *
 * progress-rollup.ts is the ACTUAL-only detector (stalled / regressing, from
 * the recorded progress series). This module is its planned-side sibling: it
 * asks whether jobs are behind the PROGRAMME they signed themselves up to, and
 * how much recorded delay time is still open. Same split, same reason as every
 * pure lib in this layer — every threshold and comparison is unit-testable
 * without a database.
 *
 * COMPOSE, DON'T RE-DERIVE. Every input here is fetched by the read layer
 * (server/services/intelligence.ts, mirroring #524) from ledgers that already
 * exist. Specifically:
 *   • the baseline/milestone SHAPES are lib/job-programme/planned.ts's
 *     (ProgrammeBaselineRow / ProgrammeMilestoneRow) — the caller reads only
 *     the CURRENT revision (superseded_at IS NULL, planned.ts §1), so a
 *     superseded plan is never counted here;
 *   • the delay lifecycle is lib/eot/lifecycle.ts's — only RECORDED events
 *     count as exposure, drafts and withdrawn events are excluded exactly as
 *     the evidence pack excludes them;
 *   • the "agreed resolution" test reads the SAME variation EoT columns the
 *     pack does (eot_agreed_at / eot_agreed_completion_date).
 * This module NEVER re-derives the planned curve (that is planned.ts's) and
 * NEVER re-detects progress (that is series.ts's) — behind-baseline is a date
 * comparison against the baseline window, and practical completion is taken
 * from the job's OWN status, not re-inferred from progress readings.
 *
 * ── FOUR SIGNALS, NO SCORE ──────────────────────────────────────────────────
 * There is deliberately NO composite "programme health" number (the negative
 * ratchet in provenance.ts / source-assertions.test.ts). Four separate,
 * self-labelling figures:
 *
 *   BEHIND BASELINE (derived) — a live job whose CURRENT baseline's planned
 *   end day is in the PAST and which is not practically complete. An exact
 *   day-key comparison; "the past" is measured against the London day the page
 *   rendered for (todayKey, injected), never a UTC slice — a plan ending
 *   31 July is overdue at 00:30 BST on 1 August, and a UTC day would miss that
 *   for an hour a night.
 *
 *   OVERDUE MILESTONES (derived) — milestones on those current baselines whose
 *   planned end day is past. A count of exact date comparisons; NO
 *   customer-visibility logic is applied (that is the portal's concern, not the
 *   owner's operational view), and a completed job's milestones are not counted
 *   because the job population is already the live one.
 *
 *   OPEN EOT EXPOSURE (derived, quantities only) — the SUM of HUMAN-CLAIMED
 *   working_days_lost over RECORDED delay events whose linked variation carries
 *   no AGREED extension of time. working_days_lost is never computed from a
 *   date range (the pack's iron rule): a null claim contributes 0 and is
 *   disclosed as unquantified, never invented. No money anywhere — this is a
 *   count of days, full stop.
 *
 *   NO-BASELINE GAP (heuristic) — how many live jobs have NO current baseline
 *   at all. Surfaced HONESTLY as a gap rather than folded into a fake zero: a
 *   job with no programme cannot be behind one, and pretending otherwise would
 *   read as "everything on plan". Which jobs OUGHT to have a baseline is a
 *   chosen rule (live jobs), so this figure is a heuristic and states the rule.
 *
 * PRACTICAL COMPLETION == job.status === 'completed' (lib/jobs/schema.ts's
 * enum: new / in-progress / completed / blocked). The LIVE population this
 * rollup measures is every non-completed job — a new/in-progress/blocked job
 * can be behind its plan; a completed one is history.
 *
 * Dates are `YYYY-MM-DD` Europe/London day keys throughout; arithmetic is
 * lib/schedule/window's `daysBetween` (never toISOString day maths). Pure,
 * clock-free and permutation-independent: lists sort by a total order.
 */

/** A completed job is practically complete; every other status is live. */
export const PRACTICAL_COMPLETION_STATUS = "completed";

// ---------------------------------------------------------------------------
// Inputs — exactly what the read layer composes
// ---------------------------------------------------------------------------

/** One job with its CURRENT baseline (or none) and that baseline's milestones. */
export type ProgrammeVarianceJobInput = {
  jobId: string;
  label: string | null;
  href: string;
  /** The job's own status — practical completion is read from here, not progress. */
  status: string | null;
  /** Current revision only (the caller filters superseded_at IS NULL). Null = no plan. */
  baseline: Pick<ProgrammeBaselineRow, "revision" | "planned_start" | "planned_end"> | null;
  /** Milestones of the current baseline. Only `planned_end` is examined here. */
  milestones: readonly Pick<ProgrammeMilestoneRow, "planned_end">[];
};

/**
 * One delay event, org-wide (any job, any status). The caller resolves the
 * linked variation's EoT columns; agreement is decided HERE so it is testable.
 */
export type ProgrammeDelayInput = {
  eventId: string;
  jobId: string;
  status: DelayEventStatus;
  /** The HUMAN'S claim, passed through untouched. Null = not quantified. */
  workingDaysLost: number | null;
  /** Linked variation's agreed-at stamp, when linked AND agreed. */
  variationEotAgreedAt: string | null;
  /** Linked variation's agreed completion date, when linked AND agreed. */
  variationEotAgreedCompletionDate: string | null;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type BehindBaselineJob = {
  jobId: string;
  label: string | null;
  href: string;
  revision: number;
  plannedStart: string;
  plannedEnd: string;
  /** Whole days the planned end is in the past (always > 0 here). */
  daysOverdue: number;
};

export type ProgrammeVarianceRollup = {
  /** Live (non-completed) jobs given to the rollup. */
  jobsConsidered: number;
  /** Live jobs carrying a current baseline. */
  jobsWithBaseline: number;
  /** Live jobs with NO current baseline — the honest gap, never summed away. */
  jobsWithoutBaseline: number;
  /** Live, past-planned-end, not practically complete. Worst (most overdue) first. */
  behindBaseline: BehindBaselineJob[];
  /** Milestones on live baselines whose planned end is past. */
  overdueMilestoneCount: number;
  /** Live jobs that have at least one overdue milestone. */
  jobsWithOverdueMilestones: number;
  /** Σ human-claimed working_days_lost on recorded, unresolved delay events. */
  openEotWorkingDaysLost: number;
  /** Recorded delay events with no agreed resolution (the exposure population). */
  openEotEventCount: number;
  /** Of those, how many have NOT quantified their claim (disclosed, not invented). */
  openEotUnquantifiedCount: number;
  /** Recorded delay events, whole org (context for the exposure figure). */
  recordedDelayEventCount: number;
  /** Excluded from exposure, disclosed so the reader knows they exist. */
  withdrawnDelayEventCount: number;
  draftDelayEventCount: number;
};

/** A recorded delay event's linked variation carries an agreed extension of time. */
export function hasAgreedResolution(delay: ProgrammeDelayInput): boolean {
  return (
    delay.variationEotAgreedAt !== null ||
    delay.variationEotAgreedCompletionDate !== null
  );
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

export function computeProgrammeVariance(input: {
  jobs: readonly ProgrammeVarianceJobInput[];
  delayEvents: readonly ProgrammeDelayInput[];
  /** The London day the page rendered for — injected, never read from a clock. */
  todayKey: string;
}): ProgrammeVarianceRollup {
  const live = input.jobs.filter((j) => j.status !== PRACTICAL_COMPLETION_STATUS);

  const behindBaseline: BehindBaselineJob[] = [];
  let jobsWithBaseline = 0;
  let overdueMilestoneCount = 0;
  let jobsWithOverdueMilestones = 0;

  for (const job of live) {
    if (!job.baseline) continue; // counted as a gap below, never behind.
    jobsWithBaseline += 1;

    // BEHIND: the current baseline's planned end is strictly in the past.
    // daysBetween(plannedEnd, today) > 0 ⇔ plannedEnd < today (chronologically);
    // due-today is NOT behind — the boundary is measured on the London day.
    const daysOverdue = daysBetween(job.baseline.planned_end, input.todayKey);
    if (daysOverdue > 0) {
      behindBaseline.push({
        jobId: job.jobId,
        label: job.label,
        href: job.href,
        revision: job.baseline.revision,
        plannedStart: job.baseline.planned_start,
        plannedEnd: job.baseline.planned_end,
        daysOverdue,
      });
    }

    // OVERDUE MILESTONES: an exact per-milestone date comparison. No
    // customer-visibility filter — this is the owner's operational view.
    let jobOverdueMilestones = 0;
    for (const m of job.milestones) {
      if (daysBetween(m.planned_end, input.todayKey) > 0) jobOverdueMilestones += 1;
    }
    overdueMilestoneCount += jobOverdueMilestones;
    if (jobOverdueMilestones > 0) jobsWithOverdueMilestones += 1;
  }

  // OPEN EOT EXPOSURE — recorded (not draft/withdrawn) events with no agreed
  // resolution. working_days_lost is summed as claimed; null is unquantified.
  let openEotWorkingDaysLost = 0;
  let openEotEventCount = 0;
  let openEotUnquantifiedCount = 0;
  let recordedDelayEventCount = 0;
  let withdrawnDelayEventCount = 0;
  let draftDelayEventCount = 0;

  for (const d of input.delayEvents) {
    if (d.status === "draft") {
      draftDelayEventCount += 1;
      continue;
    }
    if (d.status === "withdrawn") {
      withdrawnDelayEventCount += 1;
      continue;
    }
    // recorded
    recordedDelayEventCount += 1;
    if (hasAgreedResolution(d)) continue; // resolved — not open exposure.
    openEotEventCount += 1;
    if (d.workingDaysLost === null) {
      openEotUnquantifiedCount += 1;
    } else {
      openEotWorkingDaysLost += d.workingDaysLost;
    }
  }

  // Worst first, then the unique id so the order is total.
  behindBaseline.sort(
    (a, b) => b.daysOverdue - a.daysOverdue || a.jobId.localeCompare(b.jobId),
  );

  return {
    jobsConsidered: live.length,
    jobsWithBaseline,
    jobsWithoutBaseline: live.length - jobsWithBaseline,
    behindBaseline,
    overdueMilestoneCount,
    jobsWithOverdueMilestones,
    openEotWorkingDaysLost,
    openEotEventCount,
    openEotUnquantifiedCount,
    recordedDelayEventCount,
    withdrawnDelayEventCount,
    draftDelayEventCount,
  };
}

// ---------------------------------------------------------------------------
// Metrics — each labels itself; there is no combined score
// ---------------------------------------------------------------------------

/** Evidence: the per-job programme panel and the delays panel. */
const PROGRAMME_EVIDENCE = { label: "Job programmes", href: "/jobs" };
const DELAYS_EVIDENCE = { label: "Delay events", href: "/jobs" };

/** Behind baseline: DERIVED — an exact day comparison against the current plan. */
export function behindBaselineMetric(
  r: ProgrammeVarianceRollup,
): LabelledMetric<BehindBaselineJob[]> {
  return labelled(r.behindBaseline, {
    kind: "derived",
    basis:
      "A live job whose CURRENT programme baseline's planned end date is in the past — an exact " +
      "comparison of day keys, measured on the Europe/London day (a plan ending yesterday is " +
      "overdue from the first minute of today's UK day). Practical completion is taken from the " +
      "job's own status, not re-derived from progress readings, so a completed job is never here. " +
      "Superseded baselines are excluded (current revision only).",
    computedFrom: [PROGRAMME_EVIDENCE],
  });
}

/** Overdue milestones: DERIVED — a count of exact per-milestone date comparisons. */
export function overdueMilestonesMetric(
  r: ProgrammeVarianceRollup,
): LabelledMetric<{ overdueMilestoneCount: number; jobsWithOverdueMilestones: number }> {
  return labelled(
    {
      overdueMilestoneCount: r.overdueMilestoneCount,
      jobsWithOverdueMilestones: r.jobsWithOverdueMilestones,
    },
    {
      kind: "derived",
      basis:
        "Milestones on live jobs' current baselines whose planned end date is in the past, " +
        "measured on the Europe/London day. An exact date comparison; no customer-visibility " +
        "logic is applied — this is the owner's operational view, not the customer portal's.",
      computedFrom: [PROGRAMME_EVIDENCE],
    },
  );
}

/** Open EoT exposure: DERIVED — a SUM OF HUMAN CLAIMS, quantities only, no money. */
export function eotExposureMetric(
  r: ProgrammeVarianceRollup,
): LabelledMetric<{
  openEotWorkingDaysLost: number;
  openEotEventCount: number;
  openEotUnquantifiedCount: number;
}> {
  return labelled(
    {
      openEotWorkingDaysLost: r.openEotWorkingDaysLost,
      openEotEventCount: r.openEotEventCount,
      openEotUnquantifiedCount: r.openEotUnquantifiedCount,
    },
    {
      kind: "derived",
      basis:
        "The sum of the working days lost CLAIMED by your team on recorded delay events whose " +
        "linked variation carries no agreed extension of time. It is a total of human-entered " +
        "claims — never a figure computed from date ranges — and it is a count of DAYS, not money. " +
        "Draft and withdrawn events are excluded; events with no days claimed yet are counted as " +
        "unquantified and disclosed, never guessed at.",
      computedFrom: [DELAYS_EVIDENCE],
    },
  );
}

/** No-baseline gap: HEURISTIC — "a live job ought to have a programme" is a chosen rule. */
export function noBaselineGapMetric(
  r: ProgrammeVarianceRollup,
): LabelledMetric<{ jobsWithoutBaseline: number; jobsConsidered: number }> {
  return labelled(
    {
      jobsWithoutBaseline: r.jobsWithoutBaseline,
      jobsConsidered: r.jobsConsidered,
    },
    {
      kind: "heuristic",
      basis:
        "How many live (not completed) jobs have no current programme baseline at all. Surfaced " +
        "as a gap rather than a zero: a job with no plan cannot be behind one, so counting it as " +
        "\"on plan\" would be a lie. The rule that a live job OUGHT to carry a baseline is a chosen " +
        "one, which is why this is a heuristic and not a bare fact.",
      computedFrom: [PROGRAMME_EVIDENCE],
    },
  );
}
