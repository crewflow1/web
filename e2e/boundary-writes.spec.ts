import { test, expect } from "@playwright/test";

/**
 * Boundary-table writes — end to end, in a real browser.
 *
 * `organizations`, `memberships` and `users` accept no client write (SELECT-only RLS,
 * no write grant), and the server actions behind these two screens used to write them
 * with the user's own client — so "Save organisation" and "Update role" could never
 * succeed for anyone. They now authorise on the server and write with the service role.
 * The integration tier proves every action and refusal against real Postgres
 * (__tests__/integration/boundary-writes); this spec proves the two founder-visible
 * flows the way an owner actually performs them: change it, reload, it is still there.
 */
test.describe("an owner's settings and staff changes persist", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test("owner saves company settings and sees them after a reload", async ({ page }) => {
    const phone = `028 90${String(Date.now()).slice(-6)}`;
    await page.goto("/settings");
    const orgForm = page.locator("form", { has: page.getByRole("button", { name: "Save organisation" }) });
    await expect(orgForm).toBeVisible();
    await orgForm.locator('input[name="phone"]').fill(phone);
    // The proof is PERSISTENCE, so wait for the server action's own response rather
    // than for a banner (see the note at the end of this test).
    const actionDone = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/settings",
    );
    await orgForm.getByRole("button", { name: "Save organisation" }).click();
    expect((await actionDone).status()).toBeLessThan(400);
    const bannerShown = await page
      .getByText("Organisation saved.")
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    test.info().annotations.push({ type: "success-banner-visible", description: String(bannerShown) });
    await expect(page.getByText(/Couldn't save organisation|don't have permission|Only admins\/owners/)).toHaveCount(0);

    await page.reload();
    const reloaded = page.locator("form", { has: page.getByRole("button", { name: "Save organisation" }) });
    await expect(reloaded.locator('input[name="phone"]')).toHaveValue(phone);
  });

  test("owner changes a staff member's role and it persists (then restores it)", async ({ page }) => {
    await page.goto("/staff");
    // "E2E Third" is a seeded `staff` member no other spec's role assertion depends on.
    const row = page.getByRole("row", { name: /E2E Third/ });
    await expect(row).toBeVisible();
    await row.getByRole("link").first().click();
    await expect(page).toHaveURL(/\/staff\/[0-9a-f-]{36}/);
    const profileUrl = page.url().split("?")[0]!;

    const roleForm = page.locator("form", { has: page.getByRole("button", { name: "Update", exact: true }) });
    const select = roleForm.locator('select[name="role"]');
    await expect(select).toHaveValue("staff");

    await select.selectOption("admin");
    await roleForm.getByRole("button", { name: "Update", exact: true }).click();
    await expect(page).toHaveURL(/saved=role/);
    await page.goto(profileUrl);
    await expect(page.locator('select[name="role"]').first()).toHaveValue("admin");

    // Restore, so the seeded org is left as the harness created it.
    const again = page.locator("form", { has: page.getByRole("button", { name: "Update", exact: true }) });
    await again.locator('select[name="role"]').selectOption("staff");
    await again.getByRole("button", { name: "Update", exact: true }).click();
    await expect(page).toHaveURL(/saved=role/);
    await page.goto(profileUrl);
    await expect(page.locator('select[name="role"]').first()).toHaveValue("staff");
  });
});
