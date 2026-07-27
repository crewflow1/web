import { test, expect } from "@playwright/test";

/**
 * Retention release scheduling (Programme C extension) E2E — the "due back"
 * figures (job release schedule + dashboard rollup) are staff-internal cash
 * intelligence and sit behind the auth wall. Deterministic anonymous-visitor
 * boundary; the derivation + DB CHECKs + admin-only writes are proven at the
 * unit/integration tiers, and portal non-exposure at the security tier.
 */
test.describe("retention scheduling — due-back figures are behind auth", () => {
  test("a logged-out visitor to the dashboard is sent to /login, no retention figure painted", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
    await expect(page.getByText(/Retention due back|Release schedule/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });
});
