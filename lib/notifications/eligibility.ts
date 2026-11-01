/**
 * CrewFlow — Notification recipient eligibility (staff privacy boundary).
 *
 * Pure, server/client-safe. No I/O, no Supabase imports — fully unit-testable
 * and shared by EVERY delivery channel so the rule is written once.
 *
 * THE RULE (why this file exists)
 * --------------------------------
 * A non-admin STAFF member must receive ONLY notifications about work that
 * directly concerns them. The notifications table carries two kinds of row:
 *
 *   * TARGETED  (`user_id` set)   → belongs to exactly that user. Always theirs.
 *   * ORG-WIDE  (`user_id` null)  → routed by `org_id` alone, so RLS/fan-out
 *                                   historically resolved it to EVERY member of
 *                                   the org — staff included. That is the leak:
 *                                   org-wide rows carry billing / stripe /
 *                                   onboarding / migration / support content
 *                                   (company money + the CrewFlow relationship),
 *                                   none of which a non-admin should see.
 *
 * Eligibility for an ORG-WIDE row:
 *   * owner / admin                → everything (preserves their capabilities).
 *   * non-admin staff              → only when BOTH hold:
 *       (a) the category is not in {@link ADMIN_ONLY_NOTIFICATION_CATEGORIES}
 *           — a HARD gate that cannot be overridden by `audience_scope`, so a
 *           mis-marked financial row can never leak; AND
 *       (b) `audience_scope` admits them:
 *             - 'all'      → every member (reserved for genuine staff-wide news)
 *             - 'assigned' → only members assigned to the referenced job
 *                            (revocation is automatic: drop the assignment and
 *                            the row stops being eligible)
 *             - 'admins'   → nobody but admins (the safe default)
 *
 * This mirrors, byte-for-byte in intent, the SQL predicate in
 * 20261263000000_notifications_staff_privacy.sql — the DB RLS is the
 * authoritative read boundary; this module is the SAME rule applied to the
 * service-role delivery fan-outs (push / SMS / email digest) which bypass RLS.
 */

import type { NotificationCategory } from "./types";

export const NOTIFICATION_AUDIENCE_SCOPES = ["all", "admins", "assigned"] as const;
export type NotificationAudienceScope = (typeof NOTIFICATION_AUDIENCE_SCOPES)[number];

/** The safe default: an un-marked org-wide row is admin-only (deny-by-default). */
export const DEFAULT_AUDIENCE_SCOPE: NotificationAudienceScope = "admins";

/**
 * Categories that must NEVER reach a non-admin staff member on an org-wide row,
 * whatever the `audience_scope` says. These are company money, the CrewFlow
 * subscription relationship, and owner/admin operational signals.
 *
 * Every category that currently has an org-wide customer emitter is here; the
 * only ones deliberately absent are `other` (no org-wide emitter; still denied
 * to staff by the deny-by-default scope) — so the hard gate never silently
 * permits a sensitive row.
 */
export const ADMIN_ONLY_NOTIFICATION_CATEGORIES: ReadonlySet<NotificationCategory> =
  new Set<NotificationCategory>([
    "support",
    "billing",
    "stripe",
    "onboarding",
    "migration",
    "demo",
    "signup",
    "health",
    "alert",
    "system",
  ]);

/** Narrow an arbitrary stored value to a known scope, defaulting safely. */
export function coerceAudienceScope(v: unknown): NotificationAudienceScope {
  return v === "all" || v === "assigned" || v === "admins"
    ? v
    : DEFAULT_AUDIENCE_SCOPE;
}

/**
 * Is a NON-ADMIN staff member eligible to receive this ORG-WIDE row? Admins are
 * handled by the caller (they always qualify) — this is the staff-only gate.
 */
export function staffEligibleForOrgWideNotification(args: {
  category: NotificationCategory;
  audienceScope: NotificationAudienceScope;
  sourceModule: string | null;
  sourceId: string | null;
  assignedJobIds: ReadonlySet<string>;
}): boolean {
  // (a) HARD category gate — sensitive content never reaches staff.
  if (ADMIN_ONLY_NOTIFICATION_CATEGORIES.has(args.category)) return false;
  // (b) scope gate.
  switch (args.audienceScope) {
    case "all":
      return true;
    case "assigned":
      return (
        args.sourceModule === "jobs" &&
        args.sourceId != null &&
        args.assignedJobIds.has(args.sourceId)
      );
    case "admins":
    default:
      return false;
  }
}

/**
 * The single per-(row, member) eligibility decision used by every service-role
 * delivery fan-out. Targeted rows belong to their user; org-wide rows apply the
 * admin short-circuit then the staff gate above.
 */
export function memberEligibleForNotification(args: {
  row: {
    user_id: string | null;
    category: NotificationCategory;
    audience_scope: NotificationAudienceScope;
    source_module: string | null;
    source_id: string | null;
  };
  userId: string;
  isAdmin: boolean;
  assignedJobIds: ReadonlySet<string>;
}): boolean {
  const { row, userId, isAdmin, assignedJobIds } = args;
  if (row.user_id != null) return row.user_id === userId; // targeted → theirs only
  if (isAdmin) return true; // org-wide + admin → everything
  return staffEligibleForOrgWideNotification({
    category: row.category,
    audienceScope: row.audience_scope,
    sourceModule: row.source_module,
    sourceId: row.source_id,
    assignedJobIds,
  });
}
