import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Super-admin routing contract — CEO directive 2026-05-22.
 *
 * "I (CEO) use hello@crewflow.uk and clicked a demo notification email.
 *  Expected: Email → login (if needed) → CrewFlow HQ admin dashboard.
 *  Actual:   Email → 'Access pending approval'.
 *  This is a critical bug."
 *
 * Root cause was twofold:
 *   1. Demo notification email pointed at /leads/<lead_id> — a customer-
 *      side CRM route in some randomly-picked workspace, not the HQ
 *      panel. If the super-admin's active-org cookie pointed at a
 *      stale row, requireOrgContext bounced them to /access-pending or
 *      /onboarding/company.
 *   2. Auth flow + lock screen had no notion of "super-admin always
 *      wins" — they got treated like any other customer.
 *
 * The fix routes super-admins to /admin/organizations everywhere the
 * default landing was /dashboard, and bounces them OUT of /access-pending
 * immediately. This file pins those four call sites at the source level
 * so a future refactor can't quietly reintroduce the bug.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const DEMO_ROUTE = read("app/api/demo/route.ts");
const ACCESS_PENDING = read("app/access-pending/page.tsx");
const AUTH_CALLBACK = read("app/auth/callback/route.ts");
const MIDDLEWARE = read("lib/supabase/middleware.ts");

describe("demo notification email — links to /admin/organizations, not /leads/<id>", () => {
  it("has a primary CTA button to /admin/organizations in the HTML body", () => {
    expect(DEMO_ROUTE).toMatch(
      /href="\$\{appUrl\}\/admin\/organizations"/,
    );
    expect(DEMO_ROUTE).toMatch(/Review &amp; approve in CrewFlow HQ/);
  });

  it("does NOT make /leads/<id> the primary CTA of the email", () => {
    // It's still permitted to appear in a secondary "internal CRM lead"
    // line, but it must not be the primary button. Pattern match: there
    // must be no <a href="…/leads/…" that's styled as a primary button
    // (background:#0f172a). The CSS-styled CTA button must be the
    // /admin/organizations URL.
    const primaryButton = DEMO_ROUTE.match(
      /background:#0f172a[^"]*"[^>]*>\s*Review &amp; approve in CrewFlow HQ/,
    );
    expect(primaryButton).toBeTruthy();
  });

  it("plain-text version also surfaces the HQ link", () => {
    expect(DEMO_ROUTE).toMatch(/Review & approve: \$\{appUrl\}\/admin\/organizations/);
  });
});

describe("/access-pending bounces super-admins to /admin/organizations", () => {
  it("imports isSuperAdminEmail", () => {
    expect(ACCESS_PENDING).toMatch(/import \{ isSuperAdminEmail \} from "@\/server\/auth\/superadmin"/);
  });

  it("redirects super-admins BEFORE the org-status check", () => {
    // The redirect must fire before getOrgForUser, otherwise a stale
    // active-org cookie could still pull the CEO into /onboarding.
    const supAdminIdx = ACCESS_PENDING.indexOf("isSuperAdminEmail(user.email)");
    const orgFetchIdx = ACCESS_PENDING.indexOf("getOrgForUser(user.id)");
    expect(supAdminIdx).toBeGreaterThan(0);
    expect(orgFetchIdx).toBeGreaterThan(supAdminIdx);
  });

  it("the redirect target is /admin/organizations", () => {
    expect(ACCESS_PENDING).toMatch(/redirect\("\/admin\/organizations"\)/);
  });
});

describe("/auth/callback defaults super-admins to /admin/organizations", () => {
  it("imports isSuperAdminEmail", () => {
    expect(AUTH_CALLBACK).toMatch(/import \{ isSuperAdminEmail \} from "@\/server\/auth\/superadmin"/);
  });

  it("default landing is conditional on super-admin status", () => {
    expect(AUTH_CALLBACK).toMatch(
      /isSuperAdminEmail\(data\.user\.email \?\? null\)/,
    );
    expect(AUTH_CALLBACK).toMatch(/"\/admin\/organizations"/);
    expect(AUTH_CALLBACK).toMatch(/"\/dashboard"/);
  });

  it("explicit `?next=` still wins for deep links", () => {
    // The handler must honour explicitNext when same-origin, otherwise
    // post-magic-link deep links break.
    expect(AUTH_CALLBACK).toMatch(/explicitNext/);
    expect(AUTH_CALLBACK).toMatch(/candidate\.startsWith\("\/"\)/);
  });
});

describe("middleware sends signed-in super-admins on auth pages to /admin/organizations", () => {
  it("reads CREWFLOW_SUPERADMIN_EMAILS directly to avoid server-only imports", () => {
    expect(MIDDLEWARE).toMatch(/process\.env\.CREWFLOW_SUPERADMIN_EMAILS/);
  });

  it("super-admins land on /admin/organizations, customers on /dashboard", () => {
    expect(MIDDLEWARE).toMatch(/isSuperAdmin \? "\/admin\/organizations" : "\/dashboard"/);
  });

  it("matching is case-insensitive on both the user email and the allowlist entries", () => {
    expect(MIDDLEWARE).toMatch(/\.toLowerCase\(\)/);
    expect(MIDDLEWARE).toMatch(/user\.email\.trim\(\)\.toLowerCase\(\)/);
  });
});
