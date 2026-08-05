import "server-only";
import { cookies, headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSuperAdminEmail } from "@/server/auth/superadmin";

/**
 * CrewFlow — Impersonation service (HQ-10).
 *
 * Cookie carries only the session id; every load re-validates
 * against impersonation_sessions + the super-admin allowlist.
 * Tampering with the cookie can never grant access — the row is
 * the truth.
 *
 * Hard cap: 24h. If the session is older than that we treat it as
 * ended (the cookie is removed on the next response cycle so we
 * fail closed).
 */

export const IMPERSONATION_COOKIE = "cf_impersonation_session";
export const IMPERSONATION_MAX_HOURS = 24;

export type ActiveImpersonation = {
  session_id: string;
  admin_user_id: string | null;
  admin_email: string;
  target_org_id: string;
  target_org_name?: string | null;
  target_user_id: string | null;
  started_at: string;
  reason: string | null;
};

// ---------------------------------------------------------------------
// Active session lookup — used by the layout banner + getOrgForUser.
// ---------------------------------------------------------------------

/**
 * Returns the active impersonation session for the current user, or
 * null. SAFE to call for any user — non-super-admins always get null
 * even if they somehow set the cookie.
 *
 * `currentEmail` is what the route's session resolver already knows
 * (avoids a round-trip on every layout render).
 */
export async function getActiveImpersonation(
  currentEmail: string | null | undefined,
): Promise<ActiveImpersonation | null> {
  if (!currentEmail || !isSuperAdminEmail(currentEmail)) return null;
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(IMPERSONATION_COOKIE)?.value;
  if (!sessionId) return null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("impersonation_sessions" as never)
    .select(
      "id, admin_user_id, admin_email, target_org_id, target_user_id, started_at, ended_at, reason, target:organizations!impersonation_sessions_target_org_id_fkey ( name )" as never,
    )
    .eq("id" as never, sessionId)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as unknown as {
    id: string;
    admin_user_id: string | null;
    admin_email: string;
    target_org_id: string;
    target_user_id: string | null;
    started_at: string;
    ended_at: string | null;
    reason: string | null;
    target?: { name?: string | null } | null;
  };

  if (row.ended_at) return null;
  // Match the cookie holder against the row's admin_email. If the
  // current user is a super-admin BUT not the one who started the
  // session, we refuse — sharing impersonation cookies across HQ
  // users is a security smell.
  if (row.admin_email.toLowerCase() !== currentEmail.toLowerCase()) {
    return null;
  }
  // Hard 24h cap.
  const ageMs = Date.now() - new Date(row.started_at).getTime();
  if (ageMs > IMPERSONATION_MAX_HOURS * 3600_000) return null;

  return {
    session_id: row.id,
    admin_user_id: row.admin_user_id,
    admin_email: row.admin_email,
    target_org_id: row.target_org_id,
    target_org_name: row.target?.name ?? null,
    target_user_id: row.target_user_id,
    started_at: row.started_at,
    reason: row.reason,
  };
}

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------

export async function startImpersonationSession(input: {
  admin_user_id: string;
  admin_email: string;
  target_org_id: string;
  target_user_id?: string | null;
  reason?: string | null;
}): Promise<{ session_id: string } | { error: string }> {
  if (!isSuperAdminEmail(input.admin_email)) {
    return { error: "not_super_admin" };
  }

  // Best-effort: capture client metadata.
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = h.get("user-agent") ?? null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("impersonation_sessions" as never)
    .insert({
      admin_user_id: input.admin_user_id,
      admin_email: input.admin_email,
      target_org_id: input.target_org_id,
      target_user_id: input.target_user_id ?? null,
      reason: input.reason ?? null,
      ip_address: ip,
      user_agent: userAgent,
    } as never)
    .select("id")
    .single();
  if (error || !data) {
    console.error("[impersonation] insert failed", error?.message);
    return { error: "db_insert_failed" };
  }
  const row = data as unknown as { id: string };
  return { session_id: row.id };
}

// ---------------------------------------------------------------------
// End
// ---------------------------------------------------------------------

export async function endImpersonationSession(
  session_id: string,
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("impersonation_sessions" as never)
    .update({ ended_at: new Date().toISOString() } as never)
    .eq("id" as never, session_id);
}

// ---------------------------------------------------------------------
// List (HQ audit feed)
// ---------------------------------------------------------------------

export type ImpersonationLogRow = {
  id: string;
  admin_user_id: string | null;
  admin_email: string;
  target_org_id: string;
  target_org_name?: string | null;
  target_user_id: string | null;
  reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
  started_at: string;
  ended_at: string | null;
};

export async function listImpersonationSessions(
  limit = 100,
): Promise<ImpersonationLogRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("impersonation_sessions" as never)
    .select(
      "id, admin_user_id, admin_email, target_org_id, target_user_id, reason, ip_address, user_agent, started_at, ended_at, target:organizations!impersonation_sessions_target_org_id_fkey ( name )" as never,
    )
    .order("started_at" as never, { ascending: false })
    .limit(Math.min(limit, 1000)); // F-1: provable cap; PostgREST clamps to 1000
  if (error) {
    console.error("[impersonation] list failed", error.message);
    return [];
  }
  type Row = ImpersonationLogRow & {
    target?: { name?: string | null } | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    ...r,
    target_org_name: r.target?.name ?? null,
  }));
}

/** Count of active sessions — drives the HQ nav badge. */
export async function countActiveImpersonationSessions(): Promise<number> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("impersonation_sessions" as never)
    .select("id" as never, { count: "exact", head: true })
    .is("ended_at" as never, null);
  if (error) return 0;
  return count ?? 0;
}
