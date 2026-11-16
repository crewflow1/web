import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Regression: every select / input on these owner surfaces has an accessible
 * name (axe `select-name` + `label`, both WCAG 2.1 A / "critical").
 *
 * Found by the UI page sweep (docs/programme/ui-coverage/): the list-page
 * filter bars rendered a visible <label> that was NOT associated with its
 * control (no htmlFor/id), and several file inputs / rule-builder selects had
 * no label at all — so a screen reader announced "combo box" / "choose file"
 * with no name. The filter labels are now wired with htmlFor/id; the
 * label-less controls carry an aria-label.
 *
 * Scoped to the two naming rules on purpose: this pins THIS defect class on
 * these routes; colour-contrast and structure are owned by the *-a11y sweeps.
 */
const ROUTES = [
  "/finances",
  "/invoices",
  "/quotes",
  "/quotes/new",
  "/leads",
  "/jobs/calendar",
  "/payments",
  "/settings",
  "/settings/automations",
];

test.describe("form controls have accessible names", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  for (const route of ROUTES) {
    test(`${route} — no unnamed select / input`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(new RegExp(`${route.replace(/\//g, "\\/")}(\\?|$)`));
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page }).withRules(["select-name", "label"]).analyze();
      // Guard against a vacuous pass: the rules must have actually evaluated controls.
      const evaluated = [...results.passes, ...results.violations].reduce((n, r) => n + r.nodes.length, 0);
      expect(evaluated, "axe evaluated no select/input on this route").toBeGreaterThan(0);
      expect(
        results.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${String(n.target[0])}`)),
      ).toEqual([]);
    });
  }
});
