/**
 * Site Reports — the report lifecycle state machine.
 *
 * Pure module (no I/O), unit-tested directly. The server actions are the ONLY
 * writers and they call `assertTransition` before every status change, so an
 * invalid transition can never reach the database. The DB additionally freezes
 * an issued report's snapshot + content (trigger tg_site_reports_immutable).
 */

export const SITE_REPORT_STATUSES = [
  "draft",
  "ready_for_review",
  "approved",
  "issued",
  "superseded",
  "archived",
] as const;
export type SiteReportStatus = (typeof SITE_REPORT_STATUSES)[number];

export const SITE_REPORT_STATUS_LABELS: Record<SiteReportStatus, string> = {
  draft: "Draft",
  ready_for_review: "Ready for review",
  approved: "Approved",
  issued: "Issued",
  superseded: "Superseded",
  archived: "Archived",
};

/**
 * Allowed forward transitions. Anything not listed is rejected server-side.
 *   draft            → submit for review, or archive
 *   ready_for_review → send back to draft, approve, or archive
 *   approved         → send back to draft (re-edit), issue, or archive
 *   issued           → supersede (new revision) or archive
 *   superseded       → archive
 *   archived         → terminal
 */
const TRANSITIONS: Record<SiteReportStatus, readonly SiteReportStatus[]> = {
  draft: ["ready_for_review", "archived"],
  ready_for_review: ["draft", "approved", "archived"],
  approved: ["draft", "issued", "archived"],
  issued: ["superseded", "archived"],
  superseded: ["archived"],
  archived: [],
};

export function canTransition(
  from: SiteReportStatus,
  to: SiteReportStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws a stable, catchable error if the transition is not allowed. */
export function assertTransition(
  from: SiteReportStatus,
  to: SiteReportStatus,
): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid_transition:${from}->${to}`);
  }
}

/** Content is editable only while a report is still being drafted. */
export function isEditable(status: SiteReportStatus): boolean {
  return status === "draft" || status === "ready_for_review";
}

/** An issued report is a live, customer-visible, frozen deliverable. */
export function isIssued(status: SiteReportStatus): boolean {
  return status === "issued";
}

/** Superseded/archived reports are closed history. */
export function isTerminal(status: SiteReportStatus): boolean {
  return status === "superseded" || status === "archived";
}

/** Only a draft may be hard-deleted; everything else is contractual evidence. */
export function isDeletable(status: SiteReportStatus): boolean {
  return status === "draft";
}
