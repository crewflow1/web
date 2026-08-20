import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import type { MemberForScim } from "./scim";

/**
 * SCIM read helpers over org memberships (service-role, org-scoped).
 *
 * SCIM Users are a PROJECTION of memberships: a User's SCIM id is the
 * membership's user_id, and `active` is simply "is a member of this org". There
 * is no separate active flag — deprovision REMOVES the membership (see
 * provisioning.deactivateMembership), so a user that is not a member is not
 * represented (active is always true for a returned member).
 */

type AnyRow = Record<string, unknown>;

/** List the org's members as SCIM projections, optionally filtered by email. */
export async function listOrgMembersForScim(
  orgId: string,
  emailFilter?: string | null,
): Promise<MemberForScim[]> {
  const admin = createAdminClient();
  // Page the membership set (memberships is a high-value / cross-tenant table —
  // a bare read would silently clamp at the PostgREST 1000-row cap and a large
  // directory sync would miss members).
  const { data: mems, error } = await fetchAllRows<AnyRow>((from, to) =>
    admin
      .from("memberships" as never)
      .select("user_id")
      .eq("org_id", orgId)
      .range(from, to) as unknown as PromiseLike<{ data: AnyRow[] | null; error: unknown }>,
  );
  if (error || mems.length === 0) return [];

  const userIds = mems.map((m) => String(m.user_id));
  // Page the users read too (an org with >1000 members would otherwise clamp).
  const { data: users, error: uErr } = await fetchAllRows<AnyRow>((from, to) => {
    let q = admin.from("users" as never).select("id, email, full_name").in("id", userIds);
    if (emailFilter) {
      q = (q as unknown as { eq: (c: string, v: string) => typeof q }).eq("email", emailFilter);
    }
    return (q as unknown as { range: (a: number, b: number) => PromiseLike<{ data: AnyRow[] | null; error: unknown }> }).range(
      from,
      to,
    );
  });
  if (uErr || users.length === 0) return [];

  return users.map((u) => ({
    userId: String(u.id),
    email: String(u.email),
    fullName: (u.full_name as string | null) ?? null,
    active: true,
  }));
}

/** Fetch a single member (by user_id) of the org as a SCIM projection, or null. */
export async function getOrgMemberForScim(
  orgId: string,
  userId: string,
): Promise<MemberForScim | null> {
  const admin = createAdminClient();
  const { data: mem, error } = await (admin
    .from("memberships" as never)
    .select("user_id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle() as unknown as Promise<{ data: AnyRow | null; error: unknown }>);
  if (error || !mem) return null;

  const { data: user, error: uErr } = await (admin
    .from("users" as never)
    .select("id, email, full_name")
    .eq("id", userId)
    .maybeSingle() as unknown as Promise<{ data: AnyRow | null; error: unknown }>);
  if (uErr || !user) return null;

  return {
    userId: String(user.id),
    email: String(user.email),
    fullName: (user.full_name as string | null) ?? null,
    active: true,
  };
}
