import { test, expect } from "@playwright/test";

/**
 * Lead Qualification AI E2E — gate 6 for Module 3 (CEO Directive 003).
 *
 * Runs against the REAL production build (`next start`) on the REAL Supabase
 * local stack. /admin/qualification is where an operator launches the
 * deterministic qualify/disqualify decision-maker and watches it make the call:
 * it reads the fit score Research AI persisted and returns one explainable
 * verdict (qualified | disqualified | needs-review), moving the right leads
 * along the pipeline — and it is gated to the Super Admin allowlist. These specs
 * prove its FRONT DOOR for the one identity an unauthenticated E2E can assert
 * deterministically — the anonymous visitor — i.e. that the surface is never
 * served to a caller without a session:
 *
 *   - the section home (/admin/qualification) AND a live run view
 *     (/admin/qualification/<id>) are both caught by middleware and
 *     307-redirected to /login with the destination preserved, so neither page
 *     ever paints.
 *
 * Like the Research AI surface, Qualification AI is read through SSR server
 * components + server actions, all children of the single HQ-gated
 * app/admin/layout.tsx, so the page wall IS the network boundary. The two JSON
 * endpoints it does expose (run kicker + state poller) are themselves
 * Super-Admin gated and answer 404 on miss; the 404-not-403 NON-DISCLOSURE
 * contract for an AUTHENTICATED-but-non-allowlisted caller is pinned in the
 * security tier against source text — it needs a real superadmin-vs-not session
 * that this anonymous E2E deliberately does not build, so the gate here stays
 * deterministic.
 *
 * Determinism (Ch.18 flake policy): the real GoTrue is up in CI, so a logged-
 * out visit is a clean "no user" (not the fail-safe pass-through of a genuinely-
 * unreachable auth), and the middleware redirect fires exactly as in production.
 */

// pathname → its URL-encoded `next` param (middleware sets next = pathname).
// The run view uses an all-zero UUID: the redirect fires in middleware, before
// the route is ever reached, so the id only has to be well-formed.
const QUALIFICATION_PAGES: ReadonlyArray<readonly [string, string]> = [
  ["/admin/qualification", "%2Fadmin%2Fqualification"],
  [
    "/admin/qualification/00000000-0000-0000-0000-000000000000",
    "%2Fadmin%2Fqualification%2F00000000-0000-0000-0000-000000000000",
  ],
];

test.describe("qualification — the HQ Lead Qualification AI surface sits behind the auth wall", () => {
  for (const [path, next] of QUALIFICATION_PAGES) {
    test(`a logged-out visitor to ${path} is sent to /login, destination preserved`, async ({
      page,
    }) => {
      await page.goto(path);
      // The redirect AND the round-tripped destination, in one assertion.
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${next}`));
      // The Qualification AI surface never paints for an anonymous caller…
      await expect(
        page.getByRole("heading", { name: "Lead Qualification AI" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Qualify a lead" }),
      ).toHaveCount(0);
      // …they land on the sign-in page instead.
      await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
    });
  }
});
