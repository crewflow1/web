/* eslint-disable @typescript-eslint/no-explicit-any -- service-role client, loose rows */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";

/**
 * Saving settings confirms promptly.
 *
 * The profile and organisation saves wrote the row at once but could leave the page with no
 * confirmation for about ten seconds: the action revalidated the route it was submitted from,
 * which strands its result in the router until something else re-renders the page (an unrelated
 * 10-second timer in the app shell). It surfaced as an intermittent failure of the
 * owner-management spec — and once on main.
 *
 * Timing made it intermittent; passing this page's requests through an interceptor (no delay,
 * no change — just the extra hop) makes it happen every time, which is what these tests do. With
 * the defect present the confirmation arrives after ~9.7 s and these fail; fixed, it is ~0.1 s.
 */
const SLUG = "e2e-harness-org";

function svc() {
  return createClient(assertLocalE2eTarget("settings-save-confirms-promptly.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as any;
}

test.describe.configure({ mode: "serial" });
test.describe("settings saves confirm promptly (browser)", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  const db = svc();
  let before: { phone: string | null } = { phone: null };
  let org = "";

  test.beforeAll(async () => {
    const o = (await db.from("organizations").select("id, phone").eq("slug", SLUG).maybeSingle()).data;
    if (!o) throw new Error("harness org not found — did globalSetup run?");
    org = o.id; before = { phone: o.phone };
  });
  test.afterAll(async () => {
    await db.from("organizations").update({ phone: before.phone }).eq("id", org);
  });

  for (const [label, button, field, value, message] of [
    ["profile", "Save profile", "phone", "07700 900345", "Profile saved."],
    ["organisation", "Save organisation", "phone", "028 9000 1234", "Organisation saved."],
  ] as const) {
    test(`${label}: the confirmation appears within 3 seconds and the value is stored`, async ({ page }) => {
      await page.route("**/settings", (route) => route.continue());
      await page.goto("/settings");
      const form = page.locator("form", { has: page.getByRole("button", { name: button }) });
      const save = form.getByRole("button", { name: button });
      await waitForHydrated(save);
      await form.locator(`input[name="${field}"]`).fill(value);
      await save.click();
      await expect(page.getByText(message)).toBeVisible({ timeout: 3_000 });
      if (label === "organisation") {
        expect((await db.from("organizations").select("phone").eq("id", org).single()).data.phone).toBe(value);
      }
      // and the page shows the stored value after a reload
      await page.reload();
      await expect(page.locator("form", { has: page.getByRole("button", { name: button }) }).locator(`input[name="${field}"]`)).toHaveValue(value);
    });
  }
});
