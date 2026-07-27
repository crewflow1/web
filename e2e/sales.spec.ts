import { test, expect } from "@playwright/test";

/**
 * Company Intelligence Database E2E — gate 6 for Module 1 (CEO Directive #003).
 *
 * Runs against the REAL production build (`next start`) on the REAL Supabase
 * local stack. /admin/sales is the most sensitive surface in HQ — prospect
 * intelligence on real UK construction companies (names, decision-maker
 * contacts, phone numbers, AI research, pipeline value), gated to the Super
 * Admin allowlist. These specs prove its FRONT DOOR for the one identity an
 * unauthenticated E2E can assert deterministically — the anonymous visitor —
 * i.e. that the prospect database is never served to a caller without a
 * session:
 *
 *   - every /admin/sales page (the command dashboard and the company
 *     intelligence search) is caught by middleware and 307-redirected to
 *     /login with the destination preserved, so the surface never paints.
 *
 * Unlike the Pulse, the Company Intelligence surface exposes NO anonymous JSON
 * API: it is read through SSR server components + server actions, all children
 * of the single HQ-gated app/admin/layout.tsx. So the page wall IS the network
 * boundary — there is no feed endpoint to probe separately.
 *
 * The 404-not-403 NON-DISCLOSURE contract (for an AUTHENTICATED but
 * non-allowlisted caller, who reaches requireHqPage rather than the
 * middleware's logged-out redirect) is pinned in the security tier against
 * source text — it needs a real superadmin-vs-not session that this anonymous
 * E2E deliberately does not build, so the gate here stays deterministic.
 *
 * Determinism (Ch.18 flake policy): the real GoTrue is up in CI, so a logged-
 * out visit is a clean "no user" (not the fail-safe pass-through of a genuinely-
 * unreachable auth), and the middleware redirect fires exactly as in production.
 */

// pathname → its URL-encoded `next` param (middleware sets next = pathname).
const SALES_PAGES: ReadonlyArray<readonly [string, string]> = [
  ["/admin/sales", "%2Fadmin%2Fsales"],
  ["/admin/sales/companies", "%2Fadmin%2Fsales%2Fcompanies"],
];

test.describe("sales — the HQ Company Intelligence surface sits behind the auth wall", () => {
  for (const [path, next] of SALES_PAGES) {
    test(`a logged-out visitor to ${path} is sent to /login, destination preserved`, async ({
      page,
    }) => {
      await page.goto(path);
      // The redirect AND the round-tripped destination, in one assertion.
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${next}`));
      // The prospect surface never paints for an anonymous caller…
      await expect(page.getByRole("heading", { name: "Sales AI" })).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Company intelligence" }),
      ).toHaveCount(0);
      // …they land on the sign-in page instead.
      await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
    });
  }
});
