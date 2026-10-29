import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Org-side permission / ownership audit trail (Role & Permissions policy R2).
 *
 * Append-only history of who changed whose access, written via the admin client
 * from the owner-gated grant / admin-management / ownership actions (R3). Distinct
 * from the HQ-side admin_activity_log. Best-effort: an audit write must never be
 * the reason a legitimate authorization change fails, but it is always attempted.
 */

export type PermissionEvent =
  | "grant_added"
  | "grant_removed"
  | "grants_replaced"
  | "admin_appointed"
  | "admin_removed"
  | "role_changed"
  | "ownership_transfer_requested"
  | "ownership_transfer_completed"
  | "ownership_transfer_cancelled";

export async function recordPermissionEvent(e: {
  orgId: string;
  actorUserId: string | null;
  event: PermissionEvent;
  targetMembershipId?: string | null;
  module?: string | null;
  action?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const admin = createAdminClient();
  // permission_audit is not in the generated Database types until the R2
  // migration is applied + types regenerated (post-merge); access via a minimal
  // typed cast.
  type AuditWriter = {
    from: (t: string) => {
      insert: (row: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
  const { error } = await (admin as unknown as AuditWriter).from("permission_audit").insert({
    org_id: e.orgId,
    actor_user_id: e.actorUserId,
    target_membership_id: e.targetMembershipId ?? null,
    event: e.event,
    module: e.module ?? null,
    action: e.action ?? null,
    detail: e.detail ?? {},
  });
  if (error) {
    // Never block the authorization change on an audit-write failure, but make
    // the gap loud in logs rather than silent.
    console.error("[permission-audit] write failed", e.event, error.message);
  }
}
