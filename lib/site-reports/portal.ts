/**
 * Site Reports — customer-portal visibility rules (pure).
 *
 * The single source of truth for "may a portal customer see this report?". Used
 * by the portal read path (server) AND unit-tested directly. Keeping the
 * predicate pure means the security rule is one testable function, not scattered
 * query fragments.
 *
 * The portal has NO customer JWT — the URL token is the credential, resolved to
 * a customer by loadCustomerByPortalToken. So the visibility gate is enforced in
 * code (this predicate + a customer_id/org_id filter on the admin client),
 * mirroring how quotes/invoices are shown in the portal today.
 */

export type PortalReportGate = {
  status: string;
  portal_published_at: string | null;
  portal_withdrawn_at: string | null;
};

/**
 * Visible in the portal iff it is an issued (current) or superseded (historical)
 * report that has been published and not since withdrawn. Draft /
 * ready_for_review / approved / archived, and any unpublished or withdrawn
 * report, are never visible.
 */
export function isPortalVisible(r: PortalReportGate): boolean {
  return (
    (r.status === "issued" || r.status === "superseded") &&
    r.portal_published_at != null &&
    r.portal_withdrawn_at == null
  );
}

/** The current, live report (vs. a superseded historical one). */
export function isCurrentReport(r: { status: string }): boolean {
  return r.status === "issued";
}

/**
 * A safe download filename for a report PDF: never leak internal ids or allow
 * path/header injection. Keeps only filename-safe characters and always ends
 * `.pdf`.
 */
export function safeReportFilename(
  reportNumber: string | null,
  title?: string | null,
): string {
  const base =
    (reportNumber && reportNumber.trim()) ||
    (title && title.trim()) ||
    "site-report";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${cleaned || "site-report"}.pdf`;
}
