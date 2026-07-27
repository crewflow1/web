import { test, expect } from "@playwright/test";

/**
 * Asset integration E2E — the cross-domain surfaces (holdings, job-linked
 * assets, unified history) added by the integration slice sit behind the auth
 * wall like every asset surface. Deterministic anonymous-visitor boundary; the
 * cross-domain data legs are proven at the integration tier.
 */

test.describe("asset integration — new surfaces sit behind the auth wall", () => {
  test("a logged-out visitor to /assets/holdings is sent to /login, nothing painted", async ({
    page,
  }) => {
    await page.goto("/assets/holdings");
    await expect(page).toHaveURL(/\/login\?next=%2Fassets%2Fholdings/);
    await expect(page.getByText(/Staff-held|On jobs/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });
});
