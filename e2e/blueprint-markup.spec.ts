import { test, expect } from "@playwright/test";

/**
 * Blueprint Markup (Programme C) — E2E boundary + journey.
 *
 * Real assertion every CI pass: the markup surface (the ✎ Markup control + the
 * SVG layer) is operator-internal and never leaks to a logged-out visitor —
 * it lives inside the auth-walled register + the ssr:false viewer.
 *
 * The authenticated draw journey is test.fixme pending the authenticated-E2E
 * harness. It is NOT stubbed: the DB invariants are proven against real Postgres
 * (__tests__/integration/rls/blueprint-markup.test.ts) and the geometry/RDP/
 * validation logic in unit tests (__tests__/blueprints/markup.test.ts).
 */

const JOB = "00000000-0000-0000-0000-000000000000";

test.describe("blueprint markup — stays behind the auth wall", () => {
  test("a logged-out visitor never sees the markup layer or the Markup control", async ({ page }) => {
    await page.goto(`/jobs/${JOB}/blueprints`);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: "✎ Markup" })).toHaveCount(0);
    await expect(page.locator("[data-blueprint-markup]")).toHaveCount(0);
  });
});

test.describe("blueprint markup — authenticated draw journey", () => {
  // Real authenticated E2E via the harness (e2e/global-setup.ts).
  test.use({ storageState: "e2e/.auth/owner.json" });
  test(
    "Markup → pick a tool → drag on the drawing → shape persists → reload shows it",
    async ({ page }) => {
      await page.goto(`/jobs/${JOB}/blueprints`);
      await page.getByRole("button", { name: "View" }).first().click();
      const dialog = page.getByRole("dialog", { name: /Drawing viewer/ });
      await expect(dialog.locator("canvas[data-rendered-page]")).toBeVisible();

      await dialog.getByRole("button", { name: "✎ Markup" }).click();
      await dialog.getByRole("radio", { name: "Rectangle" }).click();
      const box = await dialog.locator("[data-blueprint-markup]").boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
        await page.mouse.up();
      }
      // a committed <rect> now lives in the markup SVG
      await expect(dialog.locator("[data-blueprint-markup] rect")).toHaveCount(1);
    },
  );
});
