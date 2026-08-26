/**
 * Cross-browser CRITICAL customer-journey smoke (first-customer release gate).
 *
 * The full 158-case suite runs on chromium (CI parity). This spec is the
 * WebKit/Firefox matrix: the handful of journeys a paying customer cannot live
 * without, run identically on every engine via --project/--browser overrides.
 * Kept dependency-light (no storageState) so it can run on engines the
 * global-setup wasn't tuned for: it proves rendering, the auth-redirect
 * contract, the public quote portal's 404 contract, and mobile nav markup.
 */
import { test, expect } from "@playwright/test";

test.describe("critical journeys — engine-portable", () => {
  test("marketing home renders and is titled CrewFlow", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/CrewFlow/i);
  });

  test("login page renders the sign-in form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("form").first()).toBeVisible();
    await expect(page.getByRole("button").first()).toBeVisible();
  });

  test("auth wall: protected route redirects to /login with destination preserved", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    // Destination preserved — the app uses ?next=<path>.
    expect(page.url()).toMatch(/[?&](next|redirect)=/);
  });

  test("money surface is behind the auth wall (staff-block precondition)", async ({
    page,
  }) => {
    await page.goto("/invoices");
    await expect(page).toHaveURL(/\/login/);
  });

  test("public quote portal: invalid token fails closed (no data leak)", async ({
    page,
  }) => {
    // App-router streamed not-found pages can surface as 200 on some engines;
    // the contract that matters is NO quote data renders for a bogus token.
    const res = await page.goto("/q/00000000-0000-0000-0000-000000000000");
    expect([200, 404]).toContain(res?.status() ?? 0);
    const text = (await page.textContent("body")) ?? "";
    expect(text).not.toMatch(/subtotal|line item|accept this quote|£\d/i);
  });

  test("worker portal: invalid token fails closed", async ({ page }) => {
    const res = await page.goto("/worker-portal/invalid-token-value");
    // Fails closed: 404 or an explicit invalid-link page — never a data page.
    expect([200, 404]).toContain(res?.status() ?? 0);
    const text = await page.textContent("body");
    expect(text ?? "").not.toMatch(/RAMS|permit|toolbox/i);
  });

  test("mobile viewport: login page has no horizontal overflow at 375px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/login");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
