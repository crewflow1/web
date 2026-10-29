import "server-only";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext, type OrgContext } from "@/server/auth/session";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  canWith,
  OWNER_WILDCARD,
  type CapAction,
  type Grant,
} from "@/lib/auth/capability-rules";

/**
 * Admin capability model — Role & Permissions policy R2 (server I/O layer).
 *
 * The pure decision logic (grantAllows / canWith / the taxonomy) lives in
 * `lib/auth/capability-rules.ts`; this module adds the server-only reads and the
 * page/API guards.
 *
 * The founder's model: OWNER has full access; ADMIN has ONLY the module×action
 * permissions the owner granted (default-deny); STAFF never holds a management
 * capability.
 *
 * ADDITIVE / DARK in R2: these helpers exist and are tested but are NOT yet
 * wired into any gate — every surface still uses requireManagementRole until R4
 * adopts can() incrementally. So landing this changes no one's access.
 *
 * Grants live in `membership_permissions` (service-role-only; read via the admin
 * client — a client never queries its own grants through the Data API). The
 * owner is never stored; they are resolved to a full wildcard at read time.
 */

export {
  CAP_ACTIONS,
  CAP_MODULES,
  grantAllows,
  canWith,
  OWNER_WILDCARD,
  type CapAction,
  type CapModule,
  type Grant,
} from "@/lib/auth/capability-rules";

/**
 * Load a member's capability grants via the admin client (server-only).
 * Owner → the wildcard (not stored). Admin → their rows. Anyone else → none.
 */
export async function loadCapabilities(
  orgId: string,
  userId: string,
): Promise<Grant[]> {
  const admin = createAdminClient();
  const { data: mem, error: memErr } = await admin
    .from("memberships")
    .select("id, role")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memErr) throw readFailure("capabilities: membership", memErr);
  if (!mem) return [];
  const row = mem as { id: string; role: string };
  if (row.role === "owner") return [OWNER_WILDCARD];
  if (row.role !== "admin") return [];

  // membership_permissions is not in the generated Database types until the R2
  // migration is applied + types regenerated (post-merge), so access it through
  // a minimal typed cast rather than the schema-typed client.
  type GrantRows = PromiseLike<{
    data: Array<{ module: string; action: string }> | null;
    error: { message: string } | null;
  }>;
  type GrantReader = {
    from: (t: string) => {
      select: (cols: string) => {
        eq: (k: string, v: string) => { limit: (n: number) => GrantRows };
      };
    };
  };
  // Bounded read (F-1): one membership can hold at most |modules|×(|actions|+1)
  // distinct grants (~264 at today's taxonomy) by the unique constraint, so 512
  // can never truncate a valid grant set while keeping the read honestly bounded.
  const { data, error } = await (admin as unknown as GrantReader)
    .from("membership_permissions")
    .select("module, action")
    .eq("membership_id", row.id)
    .limit(512);
  if (error) throw readFailure("capabilities: grants", error);
  return (data ?? []).map((g) => ({ module: g.module, action: g.action }));
}

/**
 * Resolve org context AND the caller's capability for (module, action).
 * Returns the context plus a `can()` bound to the loaded grants, so a caller
 * can make several checks without re-reading. R4 adopts this at call sites.
 */
export async function resolveCapabilityContext(): Promise<{
  user: User;
  ctx: OrgContext;
  grants: Grant[];
  can: (module: string, action: CapAction) => boolean;
}> {
  const { user, ctx } = await requireOrgContext();
  const grants = await loadCapabilities(ctx.org.id, user.id);
  return {
    user,
    ctx,
    grants,
    can: (module, action) => canWith(ctx.membership.role, grants, module, action),
  };
}

/**
 * PAGE / server-action guard: require (module, action) or redirect a denied
 * caller to their dashboard (same UX as requireManagementRole). R4 wires this in.
 */
export async function requireCapability(
  module: string,
  action: CapAction,
): Promise<{ user: User; ctx: OrgContext; grants: Grant[] }> {
  const { user, ctx, grants, can } = await resolveCapabilityContext();
  if (!can(module, action)) redirect("/dashboard?error=forbidden");
  return { user, ctx, grants };
}

/**
 * API / route-handler guard: the context for a permitted caller, or a
 * ready-to-return 403 JSON Response for a denied one.
 */
export async function requireCapabilityApi(
  module: string,
  action: CapAction,
): Promise<{ user: User; ctx: OrgContext; grants: Grant[] } | Response> {
  const { user, ctx, grants, can } = await resolveCapabilityContext();
  if (!can(module, action)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return { user, ctx, grants };
}
