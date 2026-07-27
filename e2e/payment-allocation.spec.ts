import { test, expect } from "@playwright/test";

/**
 * Payment allocation E2E — the record-payment surface sits behind the auth
 * wall like every money surface. Deterministic anonymous-visitor boundary;
 * the allocation invariants (over-allocation guard, cross-org rejection,
 * concurrency safety) are proven at the integration tier against real Postgres.
 */

test.describe("payment allocation — the record-payment surface is behind auth", () => {
  test("a logged-out visitor to /payments/new is sent to /login, nothing painted", async ({
    page,
  }) => {
    await page.goto("/payments/new");
    await expect(page).toHaveURL(/\/login\?next=%2Fpayments%2Fnew/);
    await expect(page.getByText(/Allocate to invoices|Record a payment/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });
});
