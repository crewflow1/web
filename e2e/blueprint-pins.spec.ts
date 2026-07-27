import { test, expect } from "@playwright/test";

/**
 * Blueprint Pins (Programme B) — E2E boundary + journey.
 *
 * Real assertion every CI pass: the pin surface (and its "Add pin" control) is
 * operator-internal and never leaks to a logged-out visitor — it lives inside
 * the auth-walled register + the ssr:false viewer.
 *
 * The authenticated place → marker → open-snag journey is test.fixme pending the
 * authenticated-E2E harness (a seeded job + blueprint version + logged-in
 * storageState). It is NOT stubbed green: the DB invariants are proven against
 * real Postgres (__tests__/integration/rls/blueprint-pins.test.ts) and the pure
 * coordinate/derivation logic in unit tests (__tests__/blueprints/pins.test.ts).
 */

const JOB = "00000000-0000-0000-0000-000000000000";

test.describe("blueprint pins — stay behind the auth wall", () => {
  test("a logged-out visitor never sees the pin layer or the Add-pin control", async ({ page }) => {
    await page.goto(`/jobs/${JOB}/blueprints`);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: "+ Add pin" })).toHaveCount(0);
    await expect(page.locator("[data-pin-marker]")).toHaveCount(0);
  });
});

test.describe("blueprint pins — authenticated place-a-snag journey", () => {
  // Real authenticated E2E via the harness (e2e/global-setup.ts).
  test.use({ storageState: "e2e/.auth/owner.json" });
  test(
    "Add pin → tap drawing → create snag → marker appears → open snag deep-links",
    async ({ page }) => {
      await page.goto(`/jobs/${JOB}/blueprints`);
      await page.getByRole("button", { name: "View" }).first().click();
      const dialog = page.getByRole("dialog", { name: /Drawing viewer/ });
      await expect(dialog.locator("canvas[data-rendered-page]")).toBeVisible();

      await dialog.getByRole("button", { name: "+ Add pin" }).click();
      // tap the centre of the page box
      const box = await dialog.locator("[data-blueprint-overlay]").boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

      const sheet = page.getByRole("dialog", { name: "Add a pin" });
      await expect(sheet).toBeVisible();
      await sheet.getByLabel("Snag title").fill("Cracked render at RC junction");
      await sheet.getByRole("button", { name: "Create snag" }).click();

      // a marker now exists, and activating it deep-links to the snag
      const marker = dialog.locator("[data-pin-marker]").first();
      await expect(marker).toBeVisible();
      await marker.click();
      await expect(page.getByRole("link", { name: /Open snag/ })).toBeVisible();
    },
  );
});
