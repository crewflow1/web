import { test, expect } from "@playwright/test";

/**
 * Smoke E2E — gate 6 of the mandatory pipeline (Directive #004).
 *
 * Runs against the REAL production build (`next start`) on the REAL Supabase
 * local stack. These are the cross-cutting invariants every request hits;
 * feature-flow specs join them as Phase 0+ surfaces land.
 *
 * Selectors are pinned to verified markup (so a green here means the real
 * thing rendered, and a red means a real regression — never a guess):
 *   - app/page.tsx            → metadata.title contains "CrewFlow"
 *   - app/(auth)/login        → <h1>Sign in</h1> + <input type="email">
 *   - app/(app)/dashboard     → protected; middleware redirects logged-out → /login
 *   - next.config.ts          → baseline security headers on every route
 *
 * The redirect is deterministic here precisely because the real Supabase
 * stack is up: GoTrue answers, so a logged-out visit is a clean "no user"
 * (not the fail-safe pass-through that a genuinely-unreachable auth would
 * trigger), and the middleware redirect fires exactly as in production.
 */

test.describe("smoke — public + auth surfaces render", () => {
  test("the marketing home page loads and is titled CrewFlow", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/CrewFlow/i);
  });

  test("the login page shows the magic-link sign-in form", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: /sign in/i }),
    ).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });
});

test.describe("smoke — the auth redirect contract holds end-to-end", () => {
  test("a logged-out visitor to a protected route is sent to /login with the destination preserved", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    // One assertion proves both halves: the redirect to /login AND that the
    // intended destination is round-tripped so post-login can resume.
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
  });
});

test.describe("smoke — baseline security headers ship on every response", () => {
  test("the always-on hardening headers are present and no enforcing CSP is set", async ({
    page,
  }) => {
    const res = await page.goto("/");
    // If navigation returned nothing, headers() below is {} and the first
    // assertion fails loudly with a clear message — no silent pass.
    const h = res?.headers() ?? {};
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"]).toContain("geolocation=()");
    // Guard against an accidental flip from Report-Only to an ENFORCING CSP
    // before the policy has been validated in production (see headers.ts).
    expect(h["content-security-policy"]).toBeUndefined();
  });
});
