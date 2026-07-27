import { test, expect } from "@playwright/test";

/**
 * Asset maintenance E2E — gate 6 for the M5 platform (cases → schedules → RTS
 * loop). Real production build + real Supabase stack; the deterministic
 * anonymous-visitor boundary (house pattern): the asset register and an asset
 * detail URL (which now carries maintenance cases, costs drawers and service
 * schedules) never paint for a caller without a session. The full repair →
 * re-inspection → return-to-service lifecycle is proven at the integration
 * tier (M5a 8 cases + M5b 5 generator cases + the M4d clearing suite).
 */

const FAKE_ASSET = "00000000-0000-0000-0000-00000000cccc";

test.describe("asset maintenance — the M5 surfaces sit behind the auth wall", () => {
  test("a logged-out visitor to /assets is sent to /login, register never paints", async ({
    page,
  }) => {
    await page.goto("/assets");
    await expect(page).toHaveURL(/\/login\?next=%2Fassets/);
    await expect(page.getByRole("link", { name: /add asset/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });

  test("a logged-out visit to an asset detail URL never paints maintenance/costs", async ({
    page,
  }) => {
    await page.goto(`/assets/${FAKE_ASSET}`);
    await expect(page).toHaveURL(/\/login\?next=/);
    await expect(page.getByText(/Maintenance/)).toHaveCount(0);
    await expect(page.getByText(/Costs \(admin only\)/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });
});
