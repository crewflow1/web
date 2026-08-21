import type { ProgressSummary, ProgressTrend } from "@/lib/job-progress/series";

/**
 * Customer-safe job progress — PURE.
 *
 * The client's view of how their job is moving: a percentage, when it was last
 * updated, which way it went, and the recent readings that show the shape.
 *
 * CUSTOMER-SAFETY IS STRUCTURAL, the lib/customers/portal-schedule.ts pattern.
 * `PortalProgress` and `PortalProgressReading` have NO field an internal note,
 * an author id, a staff name, a report id or a report reference could occupy.
 * The internal `ProgressSummary` may carry all of those; none of them has
 * anywhere to land on the way out, so no future edit to the portal page can
 * render one by accident. Proven by
 * __tests__/security/job-progress-portal-safety.test.ts, which serialises the
 * output and asserts the sensitive values are absent from the entire payload —
 * not merely unrendered.
 *
 * WHY THE WORDS ARE FACTUAL, NOT EDITORIAL. The internal badge says "Stalled"
 * and "Went backwards", which is the right register for the contractor's own
 * dashboard. Putting those words in front of a paying client would publish a
 * verdict the contractor never wrote, in a commercial relationship where it may
 * be contested. The customer labels below describe THE DATA instead ("No change
 * since the last update", "Revised down") — the same underlying trend model, so
 * there is no second, divergent notion of "stalled", but phrased as the fact it
 * is. The client can draw their own conclusion from the readings, which is why
 * the readings are included.
 */

/** One reading as the customer sees it: a date and a number. Nothing else. */
export interface PortalProgressReading {
  /** `YYYY-MM-DD` (Europe/London day). */
  day: string;
  /** 0–100. */
  percent: number;
}

export interface PortalProgress {
  /** Latest percent complete, or null when nothing has been reported. */
  percent: number | null;
  /** Day of the latest reading, or null. */
  updatedOn: string | null;
  /** Whole days since that reading, or null. */
  daysSinceUpdate: number | null;
  /** Factual movement wording — see the header. */
  movement: string;
  /** Recent readings, oldest first, so the client can see the shape. */
  readings: PortalProgressReading[];
  /** False when there is nothing to show (render nothing rather than "0%"). */
  hasProgress: boolean;
}

/**
 * Customer-facing wording per trend.
 *
 * Deliberately derived from the SAME `ProgressTrend` the staff view uses. A
 * separate customer trend rule would be a second source of truth that could
 * drift into telling the two parties different things about one job.
 */
export const PORTAL_MOVEMENT_LABELS: Record<ProgressTrend, string> = {
  none: "Not yet reported",
  first: "First update",
  progressing: "Progressing",
  stalled: "No change since the last update",
  regressed: "Revised down",
};

/** How many readings the client sees. Enough for a shape, not a full history. */
export const PORTAL_PROGRESS_READINGS = 6;

/**
 * Narrow an internal summary to the customer-safe view.
 *
 * Only ever constructs the fields declared above — the internal `note`,
 * `authorId`, `reference`, `sourceId` and `source` on each point are read past,
 * never copied. A reading is `{ day, percent }` built fresh, NOT a spread of
 * the internal point, so adding an internal field later cannot silently widen
 * what a client receives.
 */
export function toPortalProgress(
  summary: ProgressSummary,
  options: { limit?: number } = {},
): PortalProgress {
  const limit = options.limit ?? PORTAL_PROGRESS_READINGS;
  const tail = limit > 0 ? summary.points.slice(-limit) : [];

  return {
    percent: summary.percent,
    updatedOn: summary.latest ? summary.latest.day : null,
    daysSinceUpdate: summary.daysSinceUpdate,
    movement: PORTAL_MOVEMENT_LABELS[summary.trend],
    readings: tail.map((p) => ({ day: p.day, percent: p.percent })),
    hasProgress: summary.latest !== null,
  };
}
