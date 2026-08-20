import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { readFailure, reportReadFailure } from "@/lib/supabase/read-failure";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { PATHNAME_HEADER } from "@/lib/supabase/middleware";
import {
  mfaGateDecision,
  mfaEnforcementBuildEnabled,
  type AalPair,
} from "@/lib/auth/mfa-policy";
import { normalizeOrgI18n, type OrgI18n } from "@/lib/i18n/config";

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
    /** Per-org MFA enforcement flag (migration 20261170000000). Default false.
     * When true AND the FEATURE_MFA_ENFORCEMENT build gate is on, owner/admin
     * members are gated to aal2 in requireOrgContext. */
    require_mfa: boolean;
    /**
     * Internationalisation config (migration 20261210000000) — country, locale,
     * currency, timezone, tax_jurisdiction, phone_region. Normalised so a
     * pre-migration / backfill-miss row resolves to the UK defaults (the pre-wave
     * behaviour). Drives per-org money/date/phone formatting + tax jurisdiction.
     */
    i18n: OrgI18n;
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
export async function getOrgForUser(
  userId: string,
  options: { currentEmail?: string | null } = {},
): Promise<OrgContext | null> {
  const supabase = await createClient();

  // HQ-10: impersonation override. If the current user is a
  // super-admin AND has an active impersonation session, return
  // the TARGET org's context regardless of their actual
  // memberships. Validated server-side every call — cookie alone
  // never grants access.
  if (options.currentEmail) {
    const { getActiveImpersonation } = await import(
      "@/server/services/impersonation"
    );
    const imp = await getActiveImpersonation(options.currentEmail);
    if (imp) {
      const impCtx = await loadOrgContextForImpersonation(imp.target_org_id);
      if (impCtx) return impCtx;
    }
  }

  // Deterministic order: the fallback below picks memberships[0] when there's
  // no (valid) active_org_id cookie. Without an explicit ORDER BY, Postgres row
  // order is undefined, so a multi-org user could resolve to a *different* org
  // between requests. Order by created_at (earliest-joined = their default org)
  // with id as a stable tiebreaker.
  const { data: memberships, error: memErr } = await supabase
    .from("memberships")
    .select("org_id, role")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

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
      "id, name, slug, onboarding_state, status, plan, trial_ends_at, created_at, require_mfa, country, locale, currency, timezone, tax_jurisdiction, phone_region" as never,
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
    require_mfa: boolean | null;
    country: string | null;
    locale: string | null;
    currency: string | null;
    timezone: string | null;
    tax_jurisdiction: string | null;
    phone_region: string | null;
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
      // Default OFF — a null (pre-migration / backfill miss) must never turn
      // enforcement ON and lock out an org that never opted in.
      require_mfa: row.require_mfa ?? false,
      // Normalise the six i18n dimensions; a null/absent column degrades to the
      // UK default (en-GB / GBP / Europe/London / UK / GB), the pre-wave value.
      i18n: normalizeOrgI18n({
        country: row.country,
        locale: row.locale,
        currency: row.currency,
        timezone: row.timezone,
        tax_jurisdiction: row.tax_jurisdiction,
        phone_region: row.phone_region,
      }),
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

  // HQ super-admins must NEVER be dropped into a customer workspace — or the
  // customer onboarding flow — UNLESS they're actively impersonating a tenant.
  // requireOrgContext() gates every (app) surface, so this is the single
  // chokepoint that keeps HQ staff out of tenant UI even if they somehow hold
  // a stray membership row. getActiveImpersonation re-validates server-side
  // (super-admin check + admin_email match + 24h cap) so the impersonation
  // cookie alone can never grant the bypass.
  if (isSuperAdminEmail(user.email)) {
    const { getActiveImpersonation } = await import(
      "@/server/services/impersonation"
    );
    const imp = await getActiveImpersonation(user.email ?? null);
    if (!imp) redirect("/admin/organizations");
  }

  const ctx = await getOrgForUser(user.id, { currentEmail: user.email ?? null });
  if (!ctx) redirect("/onboarding/company");
  if (!orgHasActiveAccess(ctx.org.status)) {
    redirect("/access-pending");
  }

  // ── Enforceable per-org MFA (BUILT, default OFF) ─────────────────────────
  // DOUBLY gated: enforcement engages only when BOTH the deployment build gate
  // (FEATURE_MFA_ENFORCEMENT) AND the org's opt-in flag (require_mfa) are on —
  // otherwise enforceMfaPolicy returns immediately and this path is inert (no
  // AAL read, no aal2 requirement). When both are on we gate the org's
  // PRIVILEGED members (owner/admin) to an aal2 session. This is the single
  // chokepoint every (app) surface funnels through, so it is the correct place
  // to enforce (see the enforcement note in
  // app/(app)/settings/security/actions.ts). The decision is pure + fail-closed
  // (lib/auth/mfa-policy.ts): if we cannot positively confirm aal2 for a
  // privileged member, we never let them in.
  //
  // Super-admins are exempt: they are bounced to /admin above unless actively
  // impersonating, and forcing a TENANT org's MFA policy onto HQ staff (who
  // hold a synthetic owner context during impersonation) is not the intent.
  await enforceMfaPolicy(user, ctx);

  return { user, ctx };
}

/**
 * The enrol/challenge destinations MUST stay reachable at aal1, or a gated
 * privileged member could never satisfy the policy — an enforcement loop. The
 * challenge page (/login/mfa) lives in the (auth) group and is not gated by
 * requireOrgContext; the enrol surface (/settings/security) IS under (app), so
 * it is allow-listed here explicitly.
 */
const MFA_GATE_ALLOWED_PREFIXES = ["/settings/security", "/login/mfa"] as const;

async function enforceMfaPolicy(user: User, ctx: OrgContext): Promise<void> {
  // BUILD/FEATURE GATE (default OFF, env FEATURE_MFA_ENFORCEMENT). This is the
  // FIRST guard: while it is off — the default for every deployment — the whole
  // enforcement layer is inert, so the default session path performs no AAL read
  // and imposes no aal2 requirement. Enforcement needs BOTH this deployment gate
  // AND a given org's require_mfa flag before it can engage.
  if (!mfaEnforcementBuildEnabled()) return;
  if (!ctx.org.require_mfa) return; // per-org opt-in — default-off fast path
  if (isSuperAdminEmail(user.email)) return; // HQ staff exempt (see caller)

  // Resolve AAL. Fail-closed: any error → treat as unknown (→ enrol), never
  // as a pass. The error is BOUND and REPORTED (not discarded): a privileged
  // member being bounced to enrolment because the AAL read genuinely errored
  // (vs. having no factor) is an operational signal we must not swallow — but we
  // still degrade to fail-closed rather than throw, so the member lands on the
  // enrol surface instead of a generic error boundary.
  let aal: AalPair | null = null;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) {
      reportReadFailure("session: MFA assurance level", error);
      aal = null;
    } else {
      aal = data
        ? { currentLevel: data.currentLevel, nextLevel: data.nextLevel }
        : null;
    }
  } catch {
    aal = null;
  }

  const decision = mfaGateDecision({
    requireMfa: ctx.org.require_mfa,
    role: ctx.membership.role,
    aal,
  });
  if (decision === "allow") return;

  // Don't redirect a request that is already ON an allow-listed destination —
  // that is exactly where we want a not-yet-satisfied user to be.
  let pathname = "";
  try {
    pathname = (await headers()).get(PATHNAME_HEADER) ?? "";
  } catch {
    pathname = "";
  }
  const onAllowedSurface = MFA_GATE_ALLOWED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (onAllowedSurface) return;

  if (decision === "challenge") redirect("/login/mfa");
  redirect("/settings/security?mfa=required");
}

/**
 * Build an OrgContext for an impersonation target. Used when an
 * HQ super-admin is actively impersonating a customer org — the
 * normal membership query is bypassed and we hand back the target
 * org's row directly (the super-admin doesn't need a membership
 * row in the target org).
 *
 * Status gate is intentionally relaxed: HQ may want to inspect
 * suspended / cancelled orgs during a recovery call. The banner
 * makes the impersonation state obvious so this isn't a stealth
 * privilege escalation.
 */
async function loadOrgContextForImpersonation(
  orgId: string,
): Promise<OrgContext | null> {
  const supabase = await createClient();
  const { data: org, error } = await supabase
    .from("organizations")
    .select(
      "id, name, slug, onboarding_state, status, plan, trial_ends_at, created_at, require_mfa, country, locale, currency, timezone, tax_jurisdiction, phone_region" as never,
    )
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw readFailure("session: impersonation org context", error);
  if (!org) return null;
  const row = org as unknown as {
    id: string;
    name: string;
    slug: string;
    onboarding_state: Record<string, unknown>;
    status: OrgStatus | null;
    plan: string | null;
    trial_ends_at: string | null;
    created_at: string;
    require_mfa: boolean | null;
    country: string | null;
    locale: string | null;
    currency: string | null;
    timezone: string | null;
    tax_jurisdiction: string | null;
    phone_region: string | null;
  };
  return {
    // The HQ user is rendered with role='owner' so the workspace
    // shows them the full surface (sidebar + sensitive screens).
    // Their actual permissions inside the target tenant are still
    // bounded by RLS — they don't have a membership row there, so
    // INSERT/UPDATE/DELETE that policy on memberships will refuse.
    // Read access works because we're on the user-JWT client and
    // their session user_id has no membership in this org — RLS
    // rejects most tenant reads, which is why HQ-side use of
    // impersonation is read-only-ish from the DB's perspective.
    membership: { org_id: row.id, role: "owner" },
    org: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      onboarding_state: row.onboarding_state,
      status: (row.status ?? "active") as OrgStatus,
      plan: row.plan ?? "trial",
      trial_ends_at: row.trial_ends_at,
      created_at: row.created_at,
      require_mfa: row.require_mfa ?? false,
      i18n: normalizeOrgI18n({
        country: row.country,
        locale: row.locale,
        currency: row.currency,
        timezone: row.timezone,
        tax_jurisdiction: row.tax_jurisdiction,
        phone_region: row.phone_region,
      }),
    },
  };
}
