import { test, expect } from "@playwright/test";

/**
 * Blueprint Revision Comparison (Programme D) — boundary + real authenticated
 * journey via the #409 harness (two seeded revisions Rev A / Rev B). No fixme.
 */

const JOB = "00000000-0000-0000-0000-000000000000";

test.describe("blueprint compare — stays behind the auth wall", () => {
  test("a logged-out visitor never sees the Compare control or a comparison", async ({ page }) => {
    await page.goto(`/jobs/${JOB}/blueprints`);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: "Compare revisions" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: /Compare revisions/ })).toHaveCount(0);
  });
});

test.describe("blueprint compare — authenticated revision-comparison journey", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  test(
    "open → both revisions render side-by-side → overlay + opacity → swap → close",
    async ({ page }) => {
      // §21: the rendering-heavy compare journey must produce zero page errors.
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

      await page.goto(`/jobs/${JOB}/blueprints`);

      await page.getByRole("button", { name: "Compare revisions" }).first().click();
      const dialog = page.getByRole("dialog", { name: /Compare revisions/ });
      await expect(dialog).toBeVisible();

      // side-by-side: two independent render surfaces, both painted by pdf.js
      const surfaces = dialog.locator("[data-drawing-surface]");
      await expect(surfaces).toHaveCount(2);
      await expect(dialog.locator("[data-drawing-surface] canvas[data-rendered-page]").first()).toBeVisible();
      await expect(dialog.locator("[data-drawing-surface] canvas[data-rendered-page]").nth(1)).toBeVisible();

      // default pair = current (B) vs previous (A) — both revision badges shown
      // (exact match → the surface badge, not the "Rev A · date" picker options)
      await expect(dialog.getByText("Rev A", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Rev B", { exact: true })).toBeVisible();

      // switch to overlay → the opacity slider appears and is operable
      await dialog.getByRole("radio", { name: "Overlay" }).click();
      const opacity = dialog.getByRole("slider", { name: "Revision B opacity" });
      await expect(opacity).toBeVisible();
      await opacity.fill("0.3");

      // swap A/B, then exit cleanly
      await dialog.getByRole("button", { name: "Swap revisions A and B" }).click();
      await dialog.getByRole("button", { name: "Close comparison" }).click();
      await expect(dialog).toHaveCount(0);

      expect(errors, `console/page errors during compare: ${errors.join(" | ")}`).toEqual([]);
    },
  );
});
