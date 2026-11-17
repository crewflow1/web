import { test, expect } from "@playwright/test";

/**
 * Regression: the Assets register must not scroll sideways on a phone.
 *
 * Found by the UI page sweep (docs/programme/ui-coverage/): the header's seven
 * action links sat in a non-wrapping flex row, so at 390px the document was
 * 722px wide and "Calibration" / "Scan" / "Import" / "+ Add asset" were cut off
 * the right edge. /assets is a field surface (plant custody, QR scan).
 */
test.describe("assets register at 390px", () => {
  test.use({ storageState: "e2e/.auth/owner.json", viewport: { width: 390, height: 844 } });

  test("no horizontal overflow and every header action is inside the viewport", async ({ page }) => {
    await page.goto("/assets");
    await expect(page.getByRole("heading", { level: 1, name: "Assets" })).toBeVisible();
    const { scrollW, clientW } = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    expect(scrollW, `document is ${scrollW}px wide in a ${clientW}px viewport`).toBeLessThanOrEqual(clientW + 1);
    for (const name of ["Holdings", "Inspections", "Templates", "Calibration", "Scan"]) {
      const box = await page.getByRole("main").getByRole("link", { name, exact: true }).first().boundingBox();
      expect(box, `${name} link rendered`).not.toBeNull();
      expect(box!.x + box!.width, `${name} link is clipped`).toBeLessThanOrEqual(clientW + 1);
    }
  });
});
