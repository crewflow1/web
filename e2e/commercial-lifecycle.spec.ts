import { test, expect } from "@playwright/test";

/**
 * Commercial lifecycle (Programme D) E2E — the unified commercial view exposes a
 * job's costs, margin and cash, so it sits behind the auth wall like every
 * operator surface. Deterministic anonymous-visitor boundary; the tenant
 * isolation + cash-truth invariants are proven at the integration/unit tiers.
 */

test.describe("commercial lifecycle — the job commercial view is behind auth", () => {
  test("a logged-out visitor to a job's /commercial is sent to /login, nothing painted", async ({
    page,
  }) => {
    const path = "/jobs/00000000-0000-0000-0000-000000000000/commercial";
    await page.goto(path);
    await expect(page).toHaveURL(/\/login\?next=/);
    await expect(page.getByText(/Outstanding|Commercial timeline|Cost & profit/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });
});
