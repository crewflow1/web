"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { isOwner } from "@/server/auth/capabilities";
import { CAP_ACTIONS, CAP_MODULES } from "@/lib/auth/capability-rules";
import { recordPermissionEvent } from "@/server/services/permission-audit";
import { readFailure } from "@/lib/supabase/read-failure";

/**
 * Owner-controlled admin permission management (Role & Permissions R3).
 *
 * ONLY the owner may set an admin's capability grants. Admins cannot reach these
 * actions (they re-check `isOwner` server-side), so an admin can never grant
 * itself a permission or escalate — the single hard rule of the model. Grants
 * are written via the admin (service-role) client; `membership_permissions` is
 * never client-writable (RLS + revoked grants, proven in integration tests).
 *
 * Revocation is immediate: `can()` reads live grants per request, so removing a
 * grant denies the admin on their very next action — no stale-token window.
 */

const uuid = z.string().uuid();
const MODULES = new Set<string>(CAP_MODULES);
const ACTIONS = new Set<string>(CAP_ACTIONS);

export type SetPermissionsResult = { ok: true } | { ok: false; error: string };

/**
 * Replace the full grant set for an ADMIN member (the owner UI's save). Grants
 * outside the known taxonomy are dropped; the owner cannot target themselves or
 * another owner, and only an `admin` membership carries grants (owner is full,
 * staff hold none).
 */
export async function setAdminPermissions(
  targetUserId: string,
  grants: ReadonlyArray<{ module: string; action: string }>,
): Promise<SetPermissionsResult> {
  const { ctx, user } = await requireOrgContext();
  // HARD RULE: owner-only. An admin can never manage permissions (incl. its own).
  if (!isOwner(ctx)) return { ok: false, error: "forbidden" };
  if (!uuid.safeParse(targetUserId).success) return { ok: false, error: "invalid_target" };
  if (targetUserId === user.id) return { ok: false, error: "cannot_edit_self" };

  const admin = createAdminClient();
  const { data: target, error: tErr } = await admin
    .from("memberships")
    .select("id, role")
    .eq("org_id", ctx.org.id)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (tErr) throw readFailure("permissions: resolve target", tErr);
  if (!target) return { ok: false, error: "not_found" };
  // Only admins carry grants. Owner is implicitly full; staff hold none; so a
  // grant set is meaningless (and refused) for a non-admin target.
  if (target.role !== "admin") return { ok: false, error: "not_an_admin" };

  // Validate + dedupe against the known taxonomy; never persist '*' from the UI
  // (the wildcard is backfill-only), and never a module/action outside the set.
  const seen = new Set<string>();
  const rows: Array<{
    org_id: string;
    membership_id: string;
    module: string;
    action: string;
    granted_by: string;
  }> = [];
  for (const g of grants) {
    if (!MODULES.has(g.module) || !ACTIONS.has(g.action)) continue;
    const key = `${g.module}:${g.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      org_id: ctx.org.id,
      membership_id: target.id,
      module: g.module,
      action: g.action,
      granted_by: user.id,
    });
  }

  // Replace-all. The brief window between delete and insert leaves the admin
  // with NO grants — i.e. default-deny — which is fail-closed and safe.
  const del = await admin.from("membership_permissions").delete().eq("membership_id", target.id);
  if (del.error) {
    console.error("[permissions] clear failed", del.error.message);
    return { ok: false, error: "write_failed" };
  }
  if (rows.length > 0) {
    const ins = await admin.from("membership_permissions").insert(rows);
    if (ins.error) {
      console.error("[permissions] insert failed", ins.error.message);
      return { ok: false, error: "write_failed" };
    }
  }

  await recordPermissionEvent({
    orgId: ctx.org.id,
    actorUserId: user.id,
    targetMembershipId: target.id,
    event: "grants_replaced",
    detail: { granted: rows.length },
  });

  revalidatePath(`/staff/${targetUserId}`);
  return { ok: true };
}
