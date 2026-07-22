import { test, expect } from "@playwright/test";

/**
 * Blueprint Centre M2 — the interactive canvas viewer.
 *
 * Two tiers, both honest:
 *
 *  1. Auth-free + deterministic (REAL assertions that run every CI e2e pass):
 *     - the pdf.js worker asset the viewer depends on is actually served by the
 *       built app (guards scripts/copy-pdf-worker.mjs + the prebuild hook — if
 *       that pipeline ever breaks, the viewer would silently fall back to the
 *       download link in production, and this test catches it);
 *     - the viewer chrome never leaks to a logged-out visitor (the register is
 *       operator-internal, behind the auth wall).
 *
 *  2. The authenticated open → render → zoom → close journey is test.fixme.
 *     It needs a seeded job + blueprint version and a logged-in session — the
 *     authenticated-E2E harness increment. We do NOT stub a fake pass: the pure
 *     coordinate core is unit-tested (__tests__/blueprints/viewer.test.ts) and
 *     the real pdf.js canvas paint is proven in a live browser via the M2 render
 *     self-test. This spec graduates to a live test when the harness lands.
 */

const JOB = "00000000-0000-0000-0000-000000000000";

test.describe("blueprint viewer — the M2 worker asset ships with the built app", () => {
  test("the pdf.js worker is served same-origin as JavaScript", async ({ request }) => {
    const res = await request.get("/pdf.worker.min.mjs");
    expect(res.status()).toBe(200);
    // Module workers must be delivered with a JS MIME or the browser refuses them.
    expect(res.headers()["content-type"] ?? "").toMatch(/javascript/);
    // A real worker bundle (~1.3 MB), not a 404 body or an empty placeholder.
    const body = await res.body();
    expect(body.byteLength).toBeGreaterThan(100_000);
  });
});

test.describe("blueprint viewer — stays behind the auth wall", () => {
  test("a logged-out visitor never sees the viewer dialog or its trigger", async ({ page }) => {
    await page.goto(`/jobs/${JOB}/blueprints`);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("dialog", { name: /Drawing viewer/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "View" })).toHaveCount(0);
  });
});

test.describe("blueprint viewer — authenticated canvas journey", () => {
  // Real authenticated E2E via the harness (e2e/global-setup.ts seeds the org +
  // job + blueprint + PDF and mints this session). Anonymous boundary specs above
  // stay logged-out; only this describe opts into the seeded session.
  test.use({ storageState: "e2e/.auth/owner.json" });
  test(
    "open → pdf.js paints the canvas → keyboard zoom → Esc closes and restores focus",
    async ({ page }) => {
      await page.goto(`/jobs/${JOB}/blueprints`);

      const trigger = page.getByRole("button", { name: "View" }).first();
      await trigger.click();

      const dialog = page.getByRole("dialog", { name: /Drawing viewer/ });
      await expect(dialog).toBeVisible();

      // pdf.js finished painting a page (the canvas stamps data-rendered-page
      // only after RenderTask resolves).
      await expect(dialog.locator("canvas[data-rendered-page]")).toBeVisible();

      // The normalized 0..1 overlay is mounted (pins-ready for Programme B).
      await expect(dialog.locator("[data-blueprint-overlay]")).toHaveCount(1);

      // Keyboard zoom in changes the zoom control's readout.
      const zoom = dialog.getByRole("button", { name: /reset to fit/ });
      const before = (await zoom.textContent())?.trim() ?? "";
      await page.keyboard.press("+");
      await expect(zoom).not.toHaveText(before);

      // Esc closes the dialog and returns focus to the launcher (a11y contract).
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    },
  );
});
