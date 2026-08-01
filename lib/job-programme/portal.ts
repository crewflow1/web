import type { ProgrammeMilestoneRow } from "@/lib/job-programme/planned";

/**
 * Customer-safe programme milestones — PURE.
 *
 * The client's view of the plan: WHAT is planned and WHEN it is planned for.
 * Two fields, and structurally never more.
 *
 * CUSTOMER-SAFETY IS STRUCTURAL, the lib/job-progress/portal.ts pattern.
 * `PortalMilestone` has NO field a weight, a baseline note, a revision number,
 * an internal sort key or a row id could occupy. The internal row carries all
 * of those; none has anywhere to land on the way out, so no future edit to the
 * portal page can render one by accident. Proven by
 * __tests__/security/job-programme-portal-safety.test.ts, which serialises the
 * output and asserts the sensitive values are absent from the entire payload —
 * not merely unrendered.
 *
 * WHY THESE TWO FIELDS AND NOTHING ELSE:
 *   - weight     is the org's own model of how the job's effort is
 *                distributed — commercial texture a client could hold against
 *                a valuation conversation. Never theirs.
 *   - revision   says "the plan has moved N-1 times". True, but it is the
 *                contractor's story to tell with context, not a bare integer
 *                published to a token holder.
 *   - note       is the internal justification for moving the plan
 *                ("mispriced the steel"). The same class as the progress
 *                observation note; the same rule: never.
 *   - variance   ("running late against this") is a VERDICT. This module
 *                publishes dates, not judgements — the lib/job-progress/portal
 *                argument, applied to the plan.
 *
 * ONLY CUSTOMER-VISIBLE ROWS of the CURRENT revision survive. The flag
 * defaults to false at the database, so a milestone becomes visible here only
 * by a deliberate act; the current-revision cut is the caller's query
 * (superseded_at IS NULL), which this module trusts but re-states in its name.
 */

/** One milestone as the customer sees it: a title and a planned date. */
export interface PortalMilestone {
  title: string;
  /** `YYYY-MM-DD` planned end. */
  plannedEnd: string;
}

/** How many milestones the client sees. Enough for the shape of the plan. */
export const PORTAL_MILESTONE_LIMIT = 12;

/**
 * Narrow current-revision milestone rows to the customer-safe view.
 *
 * Only ever constructs the two fields declared above — a row is REBUILT as
 * `{ title, plannedEnd }`, never spread, so adding an internal column later
 * cannot silently widen what a client receives. The customer_visible filter is
 * applied HERE as well as in the caller's query (belt and braces: a staff-only
 * milestone title that crossed the wire by a future query edit still cannot
 * cross this function). Ordered by planned date, then title — a total order,
 * so the output never depends on PostgREST's row order.
 */
export function toPortalMilestones(
  rows: readonly ProgrammeMilestoneRow[],
  options: { limit?: number } = {},
): PortalMilestone[] {
  const limit = options.limit ?? PORTAL_MILESTONE_LIMIT;
  if (limit <= 0) return [];
  return rows
    .filter((r) => r.customer_visible === true)
    .filter((r) => typeof r.title === "string" && r.title.trim().length > 0)
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.planned_end ?? ""))
    .map((r) => ({ title: r.title.trim(), plannedEnd: r.planned_end }))
    .sort((a, b) =>
      a.plannedEnd !== b.plannedEnd
        ? a.plannedEnd < b.plannedEnd
          ? -1
          : 1
        : a.title < b.title
          ? -1
          : a.title > b.title
            ? 1
            : 0,
    )
    .slice(0, limit);
}
