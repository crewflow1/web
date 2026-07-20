import { test, expect } from "@playwright/test";

/**
 * Customer portal E2E — the token IS the credential, so the deterministic
 * anonymous assertion is that a BAD/UNKNOWN token reveals nothing on every
 * portal surface (the friendly invalid-link page, never a customer's data or a
 * 404 that confirms existence). A well-formed-but-nonexistent UUID exercises
 * the full loader path (shape-check passes → DB miss → fail closed).
 *
 * The authenticated per-customer journey (real token → own data only, approve
 * action, cross-customer denial) needs a seeded portal_token, which this tier
 * has no harness to mint yet (same passwordless-harness gap tracked for the
 * asset lifecycle E2E); those invariants are proven at the integration tier
 * (portal token-expiry + isolation suites).
 */

const FAKE_TOKEN = "00000000-0000-4000-8000-0000000000ff";

const PORTAL_PAGES = [
  ["overview", ""],
  ["quotes", "/quotes"],
  ["invoices", "/invoices"],
  ["reports", "/reports"],
] as const;

test.describe("customer portal — a bad token reveals nothing on any surface", () => {
  for (const [name, path] of PORTAL_PAGES) {
    test(`the ${name} surface with an unknown token shows the invalid-link page, no customer data`, async ({
      page,
    }) => {
      await page.goto(`/customer-portal/${FAKE_TOKEN}${path}`);
      // The portal is public (no /login bounce) — it renders the friendly
      // invalid-link page instead of any customer content or a bare 404.
      await expect(page.getByText(/Link expired or invalid/i)).toBeVisible();
      // No action centre / financial data ever paints for an unknown token.
      await expect(page.getByText(/Needs your attention/i)).toHaveCount(0);
    });
  }
});
