import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export type OrgStatus =
  | "pending"
  | "active"
  | "trial"
  | "suspended"
  | "rejected"
  | "cancelled";

export type OrgContext = {
  membership: {
    org_id: string;
    role: string;
  };
  org: {
    id: string;
    name: string;
    slug: string;
    status: OrgStatus;
    plan: string;
    trial_ends_at: string | null;
    created_at: string;
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

  // status / plan / trial_ends_at were added in migration 20260602000000
  // (access gate). They aren't in the generated Supabase types yet — we
  // pull them via a cast.
  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select(
      "id, name, slug, onboarding_state, status, plan, trial_ends_at, created_at" as never,
    )
    .eq("id", preferred.org_id)
    .single();

  if (orgErr || !org) return null;

  const row = org as unknown as {
    id: string;
    name: string;
    slug: string;
    onboarding_state: Record<string, unknown>;
    status: OrgStatus | null;
    plan: string | null;
    trial_ends_at: string | null;
    created_at: string;
  };

  return {
    membership: preferred,
    org: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      onboarding_state: row.onboarding_state,
      // Pre-migration rows (or any backfill miss) fall through as
      // "active" so we don't accidentally lock out existing customers
      // if the column isn't yet present.
      status: (row.status ?? "active") as OrgStatus,
      plan: row.plan ?? "trial",
      trial_ends_at: row.trial_ends_at,
      created_at: row.created_at,
    },
  };
}

/**
 * Does this org status grant active product access?
 *
 *   active   → yes
 *   trial    → yes (UI may surface days-remaining banner)
 *   pending  → no (awaiting CrewFlow approval)
 *   suspended → no (billing/abuse hold)
 *   rejected → no (admin rejected the signup)
 */
export function orgHasActiveAccess(status: OrgStatus): boolean {
  return status === "active" || status === "trial";
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
 * Require an org-bound user that ALSO has active product access.
 *
 * Redirects accordingly:
 *   - no user                                → /login
 *   - user, no org                           → /onboarding/company
 *   - user, org not active/trial             → /access-pending
 *
 * Pages that need to render content for non-active orgs (the
 * /access-pending page itself, the super-admin panel, billing) should
 * use `requireUser()` + `getOrgForUser()` directly so they don't trip
 * the access-gate redirect loop.
 */
export async function requireOrgContext(): Promise<{
  user: User;
  ctx: OrgContext;
}> {
  const user = await requireUser();
  const ctx = await getOrgForUser(user.id);
  if (!ctx) redirect("/onboarding/company");
  if (!orgHasActiveAccess(ctx.org.status)) {
    redirect("/access-pending");
  }
  return { user, ctx };
}
