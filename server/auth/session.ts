import "server-only";
import { cookies } from "next/headers";
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

export type OrgSummary = {
  id: string;
  name: string;
  slug: string;
  role: string;
};

const ACTIVE_ORG_COOKIE = "active_org_id";

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
 * Look up the user's org context.
 *
 * Multi-org behaviour:
 *   - Reads the `active_org_id` cookie (set by setActiveOrg server action).
 *   - If the cookie names an org the user is a member of → use it.
 *   - Otherwise (no cookie OR cookie names an org they don't belong to)
 *     → fall back to the user's first membership.
 *
 * Returns null only if the user has no memberships at all.
 */
export async function getOrgForUser(userId: string): Promise<OrgContext | null> {
  const supabase = await createClient();

  const { data: memberships, error: memErr } = await supabase
    .from("memberships")
    .select("org_id, role")
    .eq("user_id", userId);

  if (memErr || !memberships || memberships.length === 0) return null;

  const cookieStore = await cookies();
  const activeOrgId = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;

  const preferred =
    (activeOrgId && memberships.find((m) => m.org_id === activeOrgId)) ||
    memberships[0];
  if (!preferred) return null;

  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("id, name, slug, onboarding_state")
    .eq("id", preferred.org_id)
    .single();

  if (orgErr || !org) return null;

  return {
    membership: preferred,
    org: org as OrgContext["org"],
  };
}

/**
 * List every org the user is a member of. Used by the header org switcher.
 * Returns [] for users with no memberships.
 */
export async function listOrgsForUser(userId: string): Promise<OrgSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("role, org:organizations ( id, name, slug )")
    .eq("user_id", userId);
  if (error || !data) return [];
  const out: OrgSummary[] = [];
  for (const m of data) {
    if (m.org) {
      out.push({ id: m.org.id, name: m.org.name, slug: m.org.slug, role: m.role });
    }
  }
  // Stable order: alphabetical by name so the dropdown isn't surprising.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
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
