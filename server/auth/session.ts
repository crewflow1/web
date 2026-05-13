import "server-only";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export type OrgContext = {
  membership: {
    org_id: string;
    role: string;
  };
  org: {
    id: string;
    name: string;
    slug: string;
    onboarding_state: Record<string, unknown>;
  };
};

/**
 * Best-effort user lookup. Returns null if unauthenticated.
 * Use in layouts/pages where you want to render different UI for guests.
 */
export async function getUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Require an authenticated user. Redirects to /login if absent.
 * Use as the first call in any protected layout/page.
 */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Look up the user's org context (single-org-per-user in v1).
 * Returns null if the user has no membership yet.
 */
export async function getOrgForUser(userId: string): Promise<OrgContext | null> {
  const supabase = await createClient();

  const { data: membership, error: memErr } = await supabase
    .from("memberships")
    .select("org_id, role")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (memErr || !membership) return null;

  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("id, name, slug, onboarding_state")
    .eq("id", membership.org_id)
    .single();

  if (orgErr || !org) return null;

  return {
    membership,
    org: org as OrgContext["org"],
  };
}

/**
 * Require an org-bound user. Redirects accordingly:
 *   - no user        → /login
 *   - user, no org   → /onboarding/company
 */
export async function requireOrgContext(): Promise<{
  user: User;
  ctx: OrgContext;
}> {
  const user = await requireUser();
  const ctx = await getOrgForUser(user.id);
  if (!ctx) redirect("/onboarding/company");
  return { user, ctx };
}
