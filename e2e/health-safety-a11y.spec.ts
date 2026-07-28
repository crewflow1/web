import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Health & Safety accessibility + mobile regression (M6c). Runs axe-core (WCAG 2.0/2.1/2.2
 * A + AA) over the six H&S routes as the seeded owner, and verifies the RAMS detail has NO
 * horizontal overflow at a 375px phone width — the hazards render as stacked cards, not a
 * 760px-wide scrolling table. Seeds a draft + issued RAMS (with a hazard) and a permit via
 * service-role, then GET-navigates only (the write path is proven in health-safety-write.spec.ts).
 */

const SLUG = "e2e-harness-org";
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

function svc() {
  return createClient(assertLocalE2eTarget("health-safety-a11y.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe("health & safety — accessibility + mobile", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  let raId = "";
  let permitId = "";
  const stamp = Date.now();

  test.beforeAll(async () => {
    const db = svc();
    const t = (n: string) => (db as unknown as { from: (n: string) => any }).from(n); // eslint-disable-line @typescript-eslint/no-explicit-any
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id as string | undefined;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");
    // Issued RAMS with a hazard (so the hazards view + sign-off panel render).
    raId = String((await t("risk_assessments").insert({ org_id: orgId, title: `A11y RAMS ${stamp}`, activity: "Roofing" }).select("id").single()).data?.id);
    await t("risk_assessment_hazards").insert({ org_id: orgId, risk_assessment_id: raId, hazard: "Fall from height", likelihood: 4, severity: 5, control_measures: "Edge protection + harness" });
    await t("risk_assessments").update({ status: "issued", reference: `RA-A11Y-${stamp}`, issued_at: new Date().toISOString() }).eq("id", raId);
    // Issued permit.
    permitId = String((await t("permits_to_work").insert({ org_id: orgId, permit_type: "hot_works", title: `A11y permit ${stamp}`, scope: "Welding", valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 3.6e6).toISOString() }).select("id").single()).data?.id);
    await t("permits_to_work").update({ status: "issued", reference: `PTW-A11Y-${stamp}`, issued_at: new Date().toISOString() }).eq("id", permitId);
  });

  for (const [name, path] of [
    ["RAMS register", "/health-safety"],
    ["RAMS new", "/health-safety/new"],
    ["RAMS detail (issued)", "DETAIL_RA"],
    ["permits register", "/health-safety/permits"],
    ["permit new", "/health-safety/permits/new"],
    ["permit detail (issued)", "DETAIL_PERMIT"],
  ] as const) {
    test(`${name} has no WCAG 2.2 A/AA violations`, async ({ page }) => {
      const url = path === "DETAIL_RA" ? `/health-safety/${raId}` : path === "DETAIL_PERMIT" ? `/health-safety/permits/${permitId}` : path;
      await page.goto(url);
      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(results.violations, JSON.stringify(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([]);
    });
  }

  test("the RAMS detail has no horizontal overflow at 375px (hazards are cards, not a wide table)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/health-safety/${raId}`);
    await expect(page.getByRole("heading", { name: `A11y RAMS ${stamp}` })).toBeVisible();
    // The desktop hazards table is display:none at 375px; assert the MOBILE card (an <li>)
    // shows the hazard — so Controls/Residual are readable one-handed, not scrolled off-screen.
    await expect(page.getByRole("listitem").filter({ hasText: "Fall from height" }).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "page must not scroll horizontally on a phone").toBeLessThanOrEqual(1);
  });

  test("the permit detail has no horizontal overflow at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/health-safety/permits/${permitId}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "page must not scroll horizontally on a phone").toBeLessThanOrEqual(1);
  });
});
