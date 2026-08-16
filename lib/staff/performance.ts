import { round2 } from "@/lib/money";
import { hoursRatio, type HoursRatio } from "@/lib/intelligence/utilisation";

/**
 * STAFF PERFORMANCE — a per-person read-model derived from ledgers CrewFlow
 * already keeps. PURE: rows in, metrics out, no I/O, no clock read.
 *
 * KIND: DERIVED, and honest about its limits. Nothing here is a rating or a
 * prediction — each figure is exact arithmetic over records the person is
 * already attached to:
 *   · JOBS — jobs where `assigned_to` is this person: how many, how many
 *     completed, and — for those with BOTH a target date and a recorded
 *     practical-completion date — how many finished on time.
 *   · QUALITY — non-conformance reports where they are the responsible party
 *     (`non_conformance_reports.responsible_user_id`): open vs total.
 *   · UTILISATION — recorded vs rostered hours over a trailing window, reusing
 *     the SAME coverage arithmetic (and sample floor) as lib/intelligence/
 *     utilisation, so the two surfaces cannot disagree.
 *
 * WHAT IT REFUSES TO DO. It never invents an on-time verdict for a job with no
 * target or no completion date (those are counted separately as "not
 * measurable", never silently as on-time OR late), and it withholds a rate
 * whenever the sample is too small to mean anything — the record is always
 * shown, the derived percentage only when it is earned. Low numbers are not a
 * judgement; the operator reads the context.
 */

/**
 * Minimum number of MEASURABLE completed jobs (target + completion date both
 * present) before an on-time PERCENTAGE is shown. Below it, one late job swings
 * the rate by tens of points and the figure misleads more than it informs — the
 * same reasoning as the utilisation coverage floor.
 */
export const MIN_ONTIME_SAMPLE = 3;

/** Job statuses that count as "done" (lib/jobs/schema.ts JOB_STATUSES). */
const COMPLETED_STATUS = "completed";

/** NCR statuses that are NOT open (non_conformance_reports.status vocabulary). */
const NCR_TERMINAL = new Set(["completed", "closed", "cancelled"]);

// ── Input row shapes (exactly as the read layer selects them) ────────────────

export interface PerformanceJobRow {
  id: string;
  status: string | null;
  /** Booking day the work was scheduled to start. */
  scheduled_date: string | null;
  /** Booking day the work was scheduled to finish (preferred target). */
  scheduled_end_date: string | null;
  /** The recorded date work actually reached practical completion. */
  practical_completion_date: string | null;
}

export interface PerformanceNcrRow {
  status: string | null;
}

// ── Output ───────────────────────────────────────────────────────────────────

export interface StaffJobPerformance {
  /** Jobs where `assigned_to` is this person. */
  assigned: number;
  /** Of those, jobs with a completed status. */
  completed: number;
  /** Completed jobs that had both a target date and a completion date. */
  measurable: number;
  /** Of the measurable, those completed on or before the target date. */
  onTime: number;
  /** Of the measurable, those completed after the target date. */
  late: number;
  /** Completed jobs missing a target and/or completion date — not judged. */
  notMeasurable: number;
  /** onTime / measurable as a whole %, or null below MIN_ONTIME_SAMPLE. */
  onTimeRate: number | null;
  /** Whether the sample cleared the floor (so the rate is meaningful). */
  onTimeRated: boolean;
}

export interface StaffQualityPerformance {
  /** NCRs where this person is the responsible party. */
  responsibleTotal: number;
  /** Of those, still open (not completed / closed / cancelled). */
  responsibleOpen: number;
}

export interface StaffPerformance {
  jobs: StaffJobPerformance;
  quality: StaffQualityPerformance;
  utilisation: {
    windowDays: number;
    coverage: HoursRatio;
  };
}

/**
 * Compute one member's performance metrics. Pure and deterministic.
 *
 * `jobs` and `ncrs` are already filtered to this person by the caller (the read
 * layer pins `assigned_to` / `responsible_user_id` AND `org_id`). `recordedHours`
 * / `rosteredHours` are the trailing-window totals the service derived with the
 * shared time arithmetic; `windowDays` is stated so the surface can label them.
 */
export function computeStaffPerformance(input: {
  jobs: readonly PerformanceJobRow[];
  ncrs: readonly PerformanceNcrRow[];
  recordedHours: number;
  rosteredHours: number;
  windowDays: number;
}): StaffPerformance {
  let completed = 0;
  let measurable = 0;
  let onTime = 0;
  let late = 0;
  let notMeasurable = 0;

  for (const j of input.jobs) {
    if ((j.status ?? "") !== COMPLETED_STATUS) continue;
    completed += 1;
    const target = firstNonEmpty(j.scheduled_end_date, j.scheduled_date);
    const done = firstNonEmpty(j.practical_completion_date);
    if (target == null || done == null) {
      notMeasurable += 1;
      continue;
    }
    measurable += 1;
    // ISO YYYY-MM-DD compares lexicographically; a completion on the target day
    // counts as on time.
    if (done <= target) onTime += 1;
    else late += 1;
  }

  const rated = measurable >= MIN_ONTIME_SAMPLE;

  let responsibleOpen = 0;
  for (const n of input.ncrs) {
    if (!NCR_TERMINAL.has((n.status ?? "").trim())) responsibleOpen += 1;
  }

  return {
    jobs: {
      assigned: input.jobs.length,
      completed,
      measurable,
      onTime,
      late,
      notMeasurable,
      onTimeRate: rated && measurable > 0 ? Math.round((onTime / measurable) * 100) : null,
      onTimeRated: rated,
    },
    quality: {
      responsibleTotal: input.ncrs.length,
      responsibleOpen,
    },
    utilisation: {
      windowDays: input.windowDays,
      coverage: hoursRatio(round2(input.recordedHours), round2(input.rosteredHours)),
    },
  };
}

/** First present, non-blank value, or null. */
function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}
