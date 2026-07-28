import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Toolbox Talks accessibility + mobile regression (M7). Runs axe-core (WCAG 2.0/2.1/2.2
 * A + AA) over the toolbox routes as the seeded owner, and verifies the delivered-talk
 * detail has NO horizontal overflow at a 375px phone width — the record renders as
 * stacked cards + a sign-off panel, never a wide scrolling table. Seeds a draft + a
 * delivered (issued) talk via service-role, then GET-navigates only (the write path is
 * proven in the toolbox integration + action suites).
 */

const SLUG = "e2e-harness-org";
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

function svc() {
  return createClient(assertLocalE2eTarget("toolbox-a11y.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe("toolbox talks — accessibility + mobile", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  let draftId = "";
  let issuedId = "";
  const stamp = Date.now();

  test.beforeAll(async () => {
    const db = svc();
    const t = (n: string) => (db as unknown as { from: (n: string) => any }).from(n); // eslint-disable-line @typescript-eslint/no-explicit-any
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id as string | undefined;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    draftId = String((await t("toolbox_talks").insert({ org_id: orgId, topic: `A11y draft ${stamp}`, key_points: "Edge protection briefed" }).select("id").single()).data?.id);

    issuedId = String((await t("toolbox_talks").insert({ org_id: orgId, topic: `A11y delivered ${stamp}`, key_points: "Harness clipped on above 2m; exclusion zone below" }).select("id").single()).data?.id);
    const ref = `TBT-A11Y-${stamp}`;
    const snapshot = {
      talk_reference: ref, revision: 1, talk_date: new Date().toISOString().slice(0, 10),
      location: "Plot 4", site_label: "1 High St", delivered_by: "Site Manager",
      topic: `A11y delivered ${stamp}`, key_points: "Harness clipped on above 2m; exclusion zone below",
      ppe: ["Hard hat", "Harness"], rams_reference: null, rams_revision: null,
      permit_reference: null, permit_status_at_issue: null, external_attendees: [],
      issued_by_name: "Site Manager", issued_on: new Date().toISOString().slice(0, 10),
    };
    const iss = await t("toolbox_talks")
      .update({ status: "issued", reference: ref, issued_at: new Date().toISOString(), snapshot })
      .eq("id", issuedId).select("status").single();
    // Fail loudly if the delivered-talk seed didn't actually issue — otherwise the
    // "delivered" case would silently test a draft (which still shows the Deliver panel).
    if (iss.error || iss.data?.status !== "issued") {
      throw new Error(`a11y seed: delivered talk did not issue (${iss.error?.message ?? `status=${iss.data?.status}`})`);
    }
  });

  for (const [name, path] of [
    ["toolbox register", "/toolbox"],
    ["toolbox new", "/toolbox/new"],
    ["toolbox detail (draft)", "DETAIL_DRAFT"],
    ["toolbox detail (delivered)", "DETAIL_ISSUED"],
    ["toolbox edit (draft)", "EDIT_DRAFT"],
  ] as const) {
    test(`${name} has no WCAG 2.2 A/AA violations`, async ({ page }) => {
      const url =
        path === "DETAIL_DRAFT" ? `/toolbox/${draftId}`
        : path === "DETAIL_ISSUED" ? `/toolbox/${issuedId}`
        : path === "EDIT_DRAFT" ? `/toolbox/${draftId}/edit`
        : path;
      await page.goto(url);
      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(results.violations, JSON.stringify(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([]);
    });
  }

  test("the delivered-talk detail has no horizontal overflow at 375px (cards, not a wide table)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/toolbox/${issuedId}`);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal scroll at phone width").toBeLessThanOrEqual(1);
  });
});
