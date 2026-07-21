import { expect, test } from "@playwright/test";

/**
 * Supplier bills live inside the authenticated PO detail. Like the other e2e
 * specs, we assert the trust boundary without a seeded session: a logged-out
 * visitor to a purchase order is sent to /login and no bill UI paints.
 */
test("a logged-out visitor to a purchase order is sent to /login", async ({ page }) => {
  await page.goto("/purchase-orders/00000000-0000-0000-0000-000000000000");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText(/Record a bill/i)).toHaveCount(0);
});
