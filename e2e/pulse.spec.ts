import { test, expect } from "@playwright/test";

/**
 * The Pulse E2E — gate 6 for Module 1 / PR5 (CEO Directive #005).
 *
 * Runs against the REAL production build (`next start`) on the REAL Supabase
 * local stack. The Pulse is an HQ-only surface (Super Admin allowlist). These
 * specs prove its FRONT DOOR for the one identity an unauthenticated E2E can
 * assert deterministically — the anonymous visitor — i.e. that the projection
 * is never served to a caller without a session:
 *
 *   - the page (/admin/pulse) is caught by middleware and 307-redirected to
 *     /login with the destination preserved, so "The Pulse" never paints;
 *   - both feed endpoints (/api/hq/pulse and /api/hq/pulse/:id) are likewise
 *     bounced to the auth wall — the read-model JSON is never returned to an
 *     anonymous caller.
 *
 * The 404-not-403 NON-DISCLOSURE contract (for an AUTHENTICATED but
 * non-allowlisted caller, who reaches requireHqApi/requireHqPage rather than
 * the middleware's logged-out redirect) is pinned in the security tier against
 * source text — it needs a real superadmin-vs-not session that this anonymous
 * E2E deliberately does not build, so the gate here stays deterministic.
 *
 * Determinism (Ch.18 flake policy): the real GoTrue is up in CI, so a logged-out
 * visit is a clean "no user" (not the fail-safe pass-through of a genuinely-
 * unreachable auth), and the middleware redirect fires exactly as in production.
 */

test.describe("pulse — the HQ page sits behind the auth wall", () => {
  test("a logged-out visitor to /admin/pulse is sent to /login, destination preserved", async ({
    page,
  }) => {
    await page.goto("/admin/pulse");
    // The redirect AND the round-tripped destination, in one assertion.
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fpulse/);
    // The projection surface never paints for an anonymous caller…
    await expect(page.getByRole("heading", { name: "The Pulse" })).toHaveCount(0);
    // …they land on the sign-in page instead.
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });
});

test.describe("pulse — the feed endpoints never serve the projection anonymously", () => {
  // Both the list feed and the single-event detail endpoint. The request
  // context follows the middleware 307, so a green here means it ended at the
  // sign-in wall — the read-model body was never returned.
  for (const path of ["/api/hq/pulse", "/api/hq/pulse/1"]) {
    test(`GET ${path} is bounced to the auth wall (no read-model leak)`, async ({
      request,
    }) => {
      const res = await request.get(path);
      // The request resolved at /login — not a 200 carrying the feed payload.
      expect(res.url()).toMatch(/\/login/);
      // Belt-and-braces: the projection's page shape never appears in the body.
      expect(await res.text()).not.toContain('"items"');
    });
  }
});
