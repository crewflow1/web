import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Membership mapping + provisioning — the DENY-BY-DEFAULT core shared by SAML,
 * OIDC and SCIM.
 *
 * THE ONE RULE: a validated federated subject is only ever mapped to an
 * EXISTING org membership, matched by VERIFIED email. There is NO
 * auto-create-user path. An unmatched subject is DENIED. All provisioning is
 * membership-scoped to a single org (never touches the user account or other
 * orgs).
 *
 * All writes go through the SERVICE ROLE scoped explicitly to one org_id.
 */

export type MatchedMember = {
  userId: string;
  membershipId: string;
  role: string;
  email: string;
};

type AnyRow = Record<string, unknown>;

/** Canonical email form for matching — trimmed + lowercased. (users.email is
 *  citext, so DB compare is case-insensitive too; we normalise defensively.) */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return e.length > 0 && e.includes("@") ? e : null;
}

/**
 * Find the EXISTING membership in `orgId` for the account with `email`.
 * Returns null when no user has that email OR the user is not a member of the
 * org — the caller must then DENY (never create). Never crosses org boundaries:
 * the membership lookup is pinned to orgId.
 */
export async function findActiveMembershipByEmail(
  orgId: string,
  email: string | null | undefined,
): Promise<MatchedMember | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const admin = createAdminClient();

  // 1) Resolve the user by email (citext, case-insensitive).
  const { data: userRow, error: userErr } = await (admin
    .from("users" as never)
    .select("id, email")
    .eq("email", normalized)
    .maybeSingle() as unknown as Promise<{ data: AnyRow | null; error: unknown }>);
  if (userErr || !userRow) return null;
  const userId = String(userRow.id);

  // 2) That user MUST already be a member of THIS org.
  const { data: memRow, error: memErr } = await (admin
    .from("memberships" as never)
    .select("id, role, user_id, org_id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle() as unknown as Promise<{ data: AnyRow | null; error: unknown }>);
  if (memErr || !memRow) return null;

  return {
    userId,
    membershipId: String(memRow.id),
    role: String(memRow.role),
    email: String(userRow.email ?? normalized),
  };
}

/**
 * SCIM deprovision: remove the user's membership in `orgId` (revokes org
 * access). Membership-scoped ONLY — the user account and any memberships in
 * OTHER orgs are untouched. Idempotent: returns false if there was nothing to
 * remove. Never deletes the auth user.
 */
export async function deactivateMembership(
  orgId: string,
  email: string | null | undefined,
): Promise<{ removed: boolean; userId: string | null }> {
  const match = await findActiveMembershipByEmail(orgId, email);
  if (!match) return { removed: false, userId: null };
  const admin = createAdminClient();
  const { error } = await (admin
    .from("memberships" as never)
    .delete()
    .eq("org_id", orgId)
    .eq("id", match.membershipId) as unknown as Promise<{ error: unknown }>);
  if (error) return { removed: false, userId: match.userId };
  return { removed: true, userId: match.userId };
}

/** Append an SSO/SCIM decision to the audit trail. Best-effort: never throws
 *  into the auth path (a failed audit write must not turn a deny into an allow
 *  or vice-versa). NEVER pass secrets/signatures/tokens in `detail`. */
export async function recordSsoAudit(input: {
  orgId: string;
  protocol: "saml" | "oidc" | "scim";
  event: string;
  outcome: "allow" | "deny";
  subject?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    await (admin.from("sso_provisioning_audit" as never).insert({
      org_id: input.orgId,
      protocol: input.protocol,
      event: input.event,
      outcome: input.outcome,
      subject: input.subject ?? null,
      detail: input.detail ?? {},
    } as never) as unknown as Promise<unknown>);
  } catch {
    // swallow — audit is best-effort, never gates the decision
  }
}
