/**
 * Visual-regression MECHANISM — example (one spec, by design).
 *
 * The static `/login` page is the most stable public surface (no auth, no seeded
 * data, no animation), so its baseline has minimal churn — the right place to
 * prove the mechanism. See `playwright.visual.config.ts` for how baselines are
 * generated/asserted and why this is not in the main CI gate.
 *
 * To extend visual coverage later, add more `*.visual.ts` specs the same way —
 * prefer stable, deterministic surfaces and generate baselines per environment.
 */
import { test, expect } from "@playwright/test";

test("login page matches its visual baseline", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/login");
  // Settle before capture: the sign-in form present + web fonts loaded.
  await page.locator("form").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("login.png", { fullPage: false });
});
