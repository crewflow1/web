import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import {
  memberEligibleForNotification,
  type NotificationAudienceScope,
} from "./eligibility";
import type { NotificationRow } from "./types";

/**
 * CrewFlow — delivery-side recipient eligibility context (staff privacy).
 *
 * The in-app read path is gated by RLS (the authoritative boundary). The OTHER
 * channels — web push, SMS, email digest — fan a notification out to members
 * using the SERVICE-ROLE client, which bypasses RLS. So they must apply the
 * same staff-privacy rule themselves. This module loads the small amount of
 * context the rule needs (who is an org admin; which jobs each member is
 * assigned to) in bulk, and exposes the shared pure decision keyed to it.
 *
 * Mirrors the RLS helpers: an "admin" is an owner/admin membership; an assigned
 * job is the union of `job_assignments` and the legacy `jobs.assigned_to` —
 * exactly what `is_org_admin()` / `my_assigned_job_ids()` resolve in SQL.
 */

export type NotificationEligibilityContext = {
  /** org_id → set of owner/admin user ids. */
  adminsByOrg: ReadonlyMap<string, ReadonlySet<string>>;
  /** user_id → set of assigned job ids (union of both assignment sources). */
  assignedJobsByUser: ReadonlyMap<string, ReadonlySet<string>>;
};

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Load the eligibility context for a set of orgs. Only reads the assignment map
 * when `needAssignments` is true (i.e. the batch actually contains an org-wide
 * row scoped 'assigned') — current traffic has none, so this stays a single
 * memberships read in the common case.
 *
 * Best-effort: a read failure returns an empty map, which — because the pure
 * rule treats "not an admin, not assigned" as NOT eligible — fails CLOSED
 * (fewer recipients), never leaking an org-wide row to staff.
 */
export async function loadNotificationEligibilityContext(
  orgIds: string[],
  opts: { needAssignments: boolean },
): Promise<NotificationEligibilityContext> {
  const adminsByOrg = new Map<string, Set<string>>();
  const assignedJobsByUser = new Map<string, Set<string>>();
  if (orgIds.length === 0) return { adminsByOrg, assignedJobsByUser };

  const c = createAdminClient();

  const { data: memberRows, error: memberErr } = await fetchAllRows<
    Record<string, unknown>
  >(
    (from, to) =>
      c
        .from("memberships" as never)
        .select("org_id, user_id, role" as never)
        .in("org_id" as never, orgIds as never)
        .in("role" as never, ["owner", "admin"] as never)
        .order("org_id" as never, { ascending: true })
        .order("user_id" as never, { ascending: true })
        .range(from, to) as unknown as PromiseLike<
        PageResult<Record<string, unknown>>
      >,
  );
  if (memberErr) {
    console.error(
      "[notifications] eligibility: admin membership read failed — failing closed",
      memberErr,
    );
    return { adminsByOrg, assignedJobsByUser };
  }
  for (const m of memberRows ?? []) {
    const org = m.org_id as string;
    const user = m.user_id as string;
    if (!adminsByOrg.has(org)) adminsByOrg.set(org, new Set());
    adminsByOrg.get(org)!.add(user);
  }

  if (!opts.needAssignments) return { adminsByOrg, assignedJobsByUser };

  const add = (user: string, job: string): void => {
    if (!assignedJobsByUser.has(user)) assignedJobsByUser.set(user, new Set());
    assignedJobsByUser.get(user)!.add(job);
  };

  // Phase-1 multi-worker assignments.
  const { data: jaRows, error: jaErr } = await fetchAllRows<
    Record<string, unknown>
  >(
    (from, to) =>
      c
        .from("job_assignments" as never)
        .select("user_id, job_id, org_id" as never)
        .in("org_id" as never, orgIds as never)
        .order("org_id" as never, { ascending: true })
        .order("job_id" as never, { ascending: true })
        .range(from, to) as unknown as PromiseLike<
        PageResult<Record<string, unknown>>
      >,
  );
  if (jaErr) {
    console.error(
      "[notifications] eligibility: job_assignments read failed — failing closed on assigned scope",
      jaErr,
    );
  } else {
    for (const r of jaRows ?? []) add(r.user_id as string, r.job_id as string);
  }

  // Legacy single-assignee column.
  const { data: jobRows, error: jobErr } = await fetchAllRows<
    Record<string, unknown>
  >(
    (from, to) =>
      c
        .from("jobs" as never)
        .select("id, assigned_to, org_id" as never)
        .in("org_id" as never, orgIds as never)
        .not("assigned_to" as never, "is", null as never)
        .order("org_id" as never, { ascending: true })
        .order("id" as never, { ascending: true })
        .range(from, to) as unknown as PromiseLike<
        PageResult<Record<string, unknown>>
      >,
  );
  if (jobErr) {
    console.error(
      "[notifications] eligibility: jobs.assigned_to read failed — failing closed on assigned scope",
      jobErr,
    );
  } else {
    for (const r of jobRows ?? []) {
      const assignee = r.assigned_to as string | null;
      if (assignee) add(assignee, r.id as string);
    }
  }

  return { adminsByOrg, assignedJobsByUser };
}

/** True when the batch has at least one org-wide row scoped 'assigned'. */
export function batchNeedsAssignments(
  rows: ReadonlyArray<Pick<NotificationRow, "user_id" | "audience_scope">>,
): boolean {
  return rows.some((r) => r.user_id == null && r.audience_scope === "assigned");
}

/**
 * Bound decision: may `userId` (a member of `row.org_id`) receive `row`? Applies
 * the shared pure rule with the loaded context.
 */
export function isMemberEligible(
  row: Pick<
    NotificationRow,
    "user_id" | "org_id" | "category" | "audience_scope" | "source_module" | "source_id"
  >,
  userId: string,
  ctx: NotificationEligibilityContext,
): boolean {
  return memberEligibleForNotification({
    row: {
      user_id: row.user_id,
      category: row.category,
      audience_scope: row.audience_scope as NotificationAudienceScope,
      source_module: row.source_module,
      source_id: row.source_id,
    },
    userId,
    isAdmin: ctx.adminsByOrg.get(row.org_id)?.has(userId) ?? false,
    assignedJobIds: ctx.assignedJobsByUser.get(userId) ?? EMPTY_SET,
  });
}
