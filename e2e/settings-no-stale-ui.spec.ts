/* eslint-disable @typescript-eslint/no-explicit-any -- service-role client, loose rows */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";

/**
 * Saving the company's trading name updates every place it is shown — without a reload.
 *
 * The settings saves no longer revalidate /settings and /dashboard on the server (that caused a
 * ten-second confirmation stall). What keeps the UI fresh instead is the form's router.refresh()
 * on success, which also clears the client router cache (staleTimes.dynamic is 30 s here). This
 * proves no stale copy survives: the dashboard is visited FIRST (so a cached copy exists), the
 * user moves to Settings by an in-app link, saves, and moves back by an in-app link — the header
 * and the dashboard must both show the new name, with no hard reload anywhere.
 */
const SLUG = "e2e-harness-org";
const NEW_NAME = `Renamed Co ${Date.now().toString(36)}`;

function svc() {
  return createClient(assertLocalE2eTarget("settings-no-stale-ui.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as any;
}

test.describe("settings · no stale company name after save (browser)", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  const db = svc();
  let org = "", original = "";

  test.beforeAll(async () => {
    const o = (await db.from("organizations").select("id, name").eq("slug", SLUG).maybeSingle()).data;
    if (!o) throw new Error("harness org not found — did globalSetup run?");
    org = o.id; original = o.name;
  });
  test.afterAll(async () => {
    await db.from("organizations").update({ name: original }).eq("id", org);
  });

  test("dashboard (cached) → Settings → save name → back to dashboard: header and dashboard show the new name", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText(new RegExp(`${original} — overview`))).toBeVisible();

    // in-app navigation keeps the router cache (no hard reload from here on)
    const toSettings = page.locator('a[href="/settings"]:visible').first();
    await waitForHydrated(toSettings);
    await toSettings.click();
    await expect(page).toHaveURL(/\/settings$/);

    const form = page.locator("form", { has: page.getByRole("button", { name: "Save organisation" }) });
    const save = form.getByRole("button", { name: "Save organisation" });
    await waitForHydrated(save);
    await form.locator('input[name="name"]').fill(NEW_NAME);
    await save.click();
    await expect(page.getByText("Organisation saved.")).toBeVisible({ timeout: 3_000 });
    expect((await db.from("organizations").select("name").eq("id", org).single()).data.name).toBe(NEW_NAME);

    // the header (company switcher) already shows it, on the same page
    await expect(page.getByText(NEW_NAME).first()).toBeVisible({ timeout: 5_000 });

    // back to the dashboard by an in-app link: no stale cached copy
    const toHome = page.locator('a[href="/dashboard"]:visible').first();
    await waitForHydrated(toHome);
    await toHome.click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText(new RegExp(`${NEW_NAME} — overview`))).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(new RegExp(`${original} — overview`))).toHaveCount(0);

    // and the settings form shows it when reopened by link
    await page.locator('a[href="/settings"]:visible').first().click();
    await expect(page.locator("form", { has: page.getByRole("button", { name: "Save organisation" }) }).locator('input[name="name"]')).toHaveValue(NEW_NAME);
  });
});
