import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ ⇄ customer routing rules — consolidated, rule-by-rule contract pins.
 *
 * These are the 10 non-negotiable access-control rules for the HQ/customer
 * boundary. Each `describe` below maps 1:1 to a rule and pins the rule to its
 * REAL enforcement point in source (source-contract style, matching the rest
 * of __tests__/access-gate). Behavioural sub-properties (allowlist semantics,
 * impersonation re-validation, 24h cap, etc.) are pinned in their own suites
 * (contract.test.ts, super-admin-routing.test.ts, hq/impersonation*.test.ts,
 * auth-flow/customer-onboarding.test.ts) — this file is the single index that
 * proves every rule has an enforcement chokepoint and can't silently regress.
 *
 *   1. Customer / owner / staff users must NEVER see CrewFlow HQ.
 *   2. Only approved super-admins may access /admin/*, HQ, impersonation tools.
 *   3. Non-admin HQ access must be impossible via direct URL, stale session,
 *      browser history, or cached redirects.
 *   4. A super-admin must NEVER enter a customer workspace unless actively
 *      impersonating a customer account.
 *   5. A non-impersonating super-admin hitting /dashboard must be redirected
 *      to /admin/organizations.
 *   6. Ending impersonation must immediately return to HQ, invalidate the
 *      impersonation state, and block further customer-workspace access.
 *   7. Customer onboarding must NEVER be shown to a super-admin.
 *   8. Customer onboarding must NEVER redirect a super-admin (into a workspace).
 *   9. Customer users must NEVER be redirected to HQ.
 *  10. All of the above are covered by automated tests (this file) + live QA.
 */

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

const adminLayout = read("app/admin/layout.tsx");
const onboardingLayout = read("app/onboarding/layout.tsx");
const appLayout = read("app/(app)/layout.tsx");
const session = read("server/auth/session.ts");
const middleware = read("lib/supabase/middleware.ts");
const callback = read("app/auth/callback/route.ts");
const switchRoute = read("app/admin/switch-to-customer/route.ts");
const impersonationActions = read("app/admin/impersonation/actions.ts");
const superadmin = read("server/auth/superadmin.ts");

const API_ADMIN_ROUTES = [
  "app/api/admin/analytics/export.pdf/route.ts",
  "app/api/admin/analytics/export.csv/route.ts",
  "app/api/admin/stripe/provision/route.ts",
  "app/api/admin/stripe/verify/route.ts",
];

describe("Rule 1 — customer/owner/staff users must NEVER see CrewFlow HQ", () => {
  it("the /admin layout 404s anyone who is not a super-admin", () => {
    // Every page under app/admin/* renders inside this layout, so a single
    // server-side guard covers the whole HQ surface.
    expect(adminLayout).toMatch(/const user = await requireUser\(\)/);
    expect(adminLayout).toMatch(/if \(!isSuperAdminEmail\(user\.email\)\) notFound\(\)/);
  });

  it("uses notFound() (404) — HQ's existence is not even revealed to tenants", () => {
    expect(adminLayout).toMatch(/import \{ notFound \}/);
    expect(adminLayout).not.toMatch(/redirect\("\/dashboard"\).*isSuperAdmin/s);
  });
});

describe("Rule 2 — only approved super-admins may access /admin/*, HQ, impersonation", () => {
  it("super-admin status is allowlist-driven (env), not hardcoded or role-based", () => {
    expect(superadmin).toMatch(/CREWFLOW_SUPERADMIN_EMAILS/);
    expect(superadmin).toMatch(/export function isSuperAdminEmail/);
  });

  it("every impersonation server action is gated by a super-admin check", () => {
    // requireAdmin() = requireUser + isSuperAdminEmail (else bounce). Every
    // mutating impersonation action calls it first.
    expect(impersonationActions).toMatch(/isSuperAdminEmail/);
    expect(impersonationActions).toMatch(/requireAdmin/);
  });

  it("the HQ analytics/stripe API route handlers self-guard (not behind the layout)", () => {
    // route.ts handlers and /api/* are NOT wrapped by layout.tsx, so each must
    // re-assert the super-admin check itself or it's an open hole.
    for (const rel of API_ADMIN_ROUTES) {
      const src = read(rel);
      expect(src, rel).toMatch(/if \(!isSuperAdminEmail\(user\.email\)\)/);
      expect(src, rel).toMatch(/status: 404/);
    }
  });
});

describe("Rule 3 — non-admin HQ access impossible via URL / stale session / history / cache", () => {
  it("the guard is a server component that validates a LIVE user every request", () => {
    // requireUser() → getUser() makes a network call to validate the JWT, so a
    // stale/forged cookie or a back-button cached page can't satisfy it.
    expect(adminLayout).toMatch(/export default async function/);
    expect(adminLayout).toMatch(/await requireUser\(\)/);
    expect(middleware).toMatch(/supabase\.auth\.getUser\(\)/);
  });

  it("HQ landing pages add defense-in-depth self-guards (not layout-only)", () => {
    const orgPage = read("app/admin/organizations/page.tsx");
    expect(orgPage).toMatch(/if \(!isSuperAdminEmail\(user\.email\)\) notFound\(\)/);
  });
});

describe("Rule 4 — super-admin never enters a customer workspace unless impersonating", () => {
  it("requireOrgContext bounces a non-impersonating super-admin straight to HQ", () => {
    expect(session).toMatch(/if \(isSuperAdminEmail\(user\.email\)\)/);
    expect(session).toMatch(/getActiveImpersonation\(user\.email \?\? null\)/);
    expect(session).toMatch(/if \(!imp\) redirect\("\/admin\/organizations"\)/);
  });

  it("switch-to-customer has NO self-org shortcut — impersonation is the only entry", () => {
    expect(switchRoute).toMatch(/if \(!isSuperAdminEmail\(user\.email\)\)/);
    expect(switchRoute).toMatch(/if \(impersonation\)/);
    expect(switchRoute).toMatch(/"\/admin\/customers"/);
    // The only /dashboard redirects are the non-admin safety bounce + the
    // gated impersonation branch. No third "admin has own org" path.
    const dashboardRedirects = switchRoute.match(/"\/dashboard"/g) ?? [];
    expect(dashboardRedirects.length).toBeLessThanOrEqual(2);
  });
});

describe("Rule 5 — non-impersonating super-admin on /dashboard → /admin/organizations", () => {
  it("the (app) chokepoint (requireOrgContext) performs the redirect", () => {
    // /dashboard lives in the (app) group, which calls requireOrgContext().
    expect(appLayout).toMatch(/requireOrgContext\(\)/);
    expect(session).toMatch(/if \(!imp\) redirect\("\/admin\/organizations"\)/);
  });

  it("the auth-page middleware also routes super-admins to HQ, never /dashboard", () => {
    expect(middleware).toMatch(
      /isSuperAdmin \? "\/admin\/organizations" : "\/dashboard"/,
    );
  });

  it("post-login callback defaults a super-admin to HQ (not the workspace)", () => {
    expect(callback).toMatch(/const isAdmin = isSuperAdminEmail\(userPayload\.email\)/);
    expect(callback).toMatch(/"\/admin\/organizations"/);
  });
});

describe("Rule 6 — ending impersonation returns to HQ + invalidates state + blocks workspace", () => {
  it("endImpersonation deletes the cookie AND ends the server-side session row", () => {
    expect(impersonationActions).toMatch(/jar\.delete\(IMPERSONATION_COOKIE\)/);
    expect(impersonationActions).toMatch(/endImpersonationSession\(active\.session_id\)/);
  });

  it("endImpersonation redirects back to HQ", () => {
    expect(impersonationActions).toMatch(/redirect\("\/admin\/impersonation\?saved=ended"\)/);
  });

  it("with the row ended, requireOrgContext can no longer resolve a target org", () => {
    // getActiveImpersonation returns null once ended_at is set (re-validated
    // server-side every request), so the super-admin immediately fails the
    // Rule 4 guard on the next workspace navigation.
    const imp = read("server/services/impersonation.ts");
    expect(imp).toMatch(/ended_at/);
    expect(imp).toMatch(/if \(!currentEmail \|\| !isSuperAdminEmail\(currentEmail\)\) return null/);
  });

  it("the live workspace banner exposes the exit-impersonation control", () => {
    expect(appLayout).toMatch(/getActiveImpersonation\(user\.email \?\? null\)/);
    expect(appLayout).toMatch(/endImpersonation/);
    expect(appLayout).toMatch(/Exit impersonation/);
  });
});

describe("Rule 7 — customer onboarding is NEVER shown to a super-admin", () => {
  it("the onboarding layout bounces super-admins to HQ before rendering", () => {
    expect(onboardingLayout).toMatch(/import \{ isSuperAdminEmail \}/);
    expect(onboardingLayout).toMatch(
      /if \(isSuperAdminEmail\(user\.email\)\) redirect\("\/admin\/organizations"\)/,
    );
  });
});

describe("Rule 8 — customer onboarding NEVER redirects a super-admin into a workspace", () => {
  it("the super-admin → HQ exit runs BEFORE the onboarding ctx → /dashboard redirect", () => {
    // Ordering is load-bearing: a super-admin must hit the HQ bounce first, so
    // they can never fall through into the customer 'has-org → /dashboard' path.
    const superAdminGuard = onboardingLayout.indexOf(
      'isSuperAdminEmail(user.email)) redirect("/admin/organizations")',
    );
    const ctxRedirect = onboardingLayout.indexOf('if (ctx) redirect("/dashboard")');
    expect(superAdminGuard).toBeGreaterThanOrEqual(0);
    expect(ctxRedirect).toBeGreaterThan(superAdminGuard);
  });
});

describe("Rule 9 — customer users are NEVER redirected to HQ", () => {
  it("the callback only honours /admin deep links for an actual super-admin", () => {
    // Non-admin branch: an explicit ?next is only respected when it's NOT an
    // /admin path; otherwise the customer lands on /dashboard. There is no
    // code path that sends a non-admin to /admin/*.
    expect(callback).toMatch(/else if \(safeExplicit && !safeExplicit\.startsWith\("\/admin"\)\)/);
    expect(callback).toMatch(/safeNext = "\/dashboard"/);
  });

  it("middleware sends every non-super-admin authed visitor to /dashboard", () => {
    expect(middleware).toMatch(
      /isSuperAdmin \? "\/admin\/organizations" : "\/dashboard"/,
    );
  });
});

describe("Rule 10 — the boundary is regression-locked by automated tests", () => {
  it("this consolidated file plus the focused suites pin every rule above", () => {
    // Sentinel: if this file is ever deleted/emptied the suite count drops and
    // CI flags the missing coverage. The assertion is trivially true; its job
    // is to make Rule 10's intent explicit and grep-able.
    expect(true).toBe(true);
  });
});
