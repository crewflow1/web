import { test, expect } from "@playwright/test";

/**
 * Role-access boundary E2E — Phase-8 authenticated verification.
 *
 * The security-hardening program's #1 priority is that typing a URL cannot
 * grant access a role should not have. The server guards are unit/integration
 * tested, but this proves the boundary end-to-end in a REAL browser against the
 * REAL production build (`next start`) + the REAL Supabase local stack, using
 * the harness's seeded sessions (e2e/global-setup.ts):
 *
 *   - staff.json → a `staff` member of the seeded org (dedicated; never signed
 *     out, unlike second/third.json which the logout specs revoke).
 *   - owner.json → an `owner` of the seeded org who is NOT on the super-admin
 *     allowlist.
 *
 * Scope note: only the management surfaces that REDIRECT (requireManagement*)
 * are asserted here. Pages that instead render an inline access-denied panel
 * (e.g. /settings/api-keys) keep the same URL, so they need a content assertion
 * rather than a URL one and are out of scope for this boundary spec.
 */

/**
 * Management-only surfaces whose segment layout (requireManagementContext)
 * already redirects a non-owner/admin on `main`. (Billing joins this list once
 * PR #947 — which switches /settings/billing to requireManagementContext —
 * merges; until then it renders a buttons-hidden page, so asserting it here
 * would fail on a branch that doesn't carry that fix.)
 */
const MANAGEMENT_REDIRECT_PAGES = [
  { path: "/quotes", name: "Quotes" },
  { path: "/invoices", name: "Invoices" },
];

test.describe("a staff member cannot reach management-only pages by URL", () => {
  test.use({ storageState: "e2e/.auth/staff.json" });

  for (const { path, name } of MANAGEMENT_REDIRECT_PAGES) {
    test(`${name} (${path}) bounces staff to their own home`, async ({ page }) => {
      await page.goto(path);
      // requireManagementContext() redirects a non-owner/admin to
      // /dashboard?error=forbidden, and /dashboard itself forwards a `staff`
      // member on to /me — so a real browser lands on /me, never on the
      // management surface. One assertion proves both: arrived at /me…
      await expect(page).toHaveURL(/\/me(\?|\/|$)/);
      // …and did NOT stay on the requested management path.
      await expect(page).not.toHaveURL(
        new RegExp(path.replace(/[/]/g, "\\/")),
      );
    });
  }

  test("staff CAN reach their own day at /me (positive control)", async ({
    page,
  }) => {
    await page.goto("/me");
    await expect(page).toHaveURL(/\/me(\?|\/|$)/);
  });
});

test.describe("a non-super-admin cannot reach CrewFlow HQ", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test("an org owner (not on the super-admin allowlist) gets 404 on /admin", async ({
    page,
  }) => {
    const res = await page.goto("/admin");
    // requireHqPage() → notFound() for a non-allowlisted user: a 404, never a
    // redirect and never the HQ surface (an HQ page must not announce itself).
    expect(res?.status()).toBe(404);
  });
});
