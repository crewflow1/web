import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Health & Safety accessibility + mobile regression (M6c). Runs axe-core (WCAG 2.0/2.1/2.2
 * A + AA) over the six H&S routes as the seeded owner, and verifies the RAMS detail has NO
 * horizontal overflow at a 375px phone width — the hazards render as stacked cards, not a
 * 760px-wide scrolling table. GET-navigates only (the write path is proven in
 * health-safety-write.spec.ts).
 *
 * Seeding is idempotent against a PERSISTENT local database (Ch.18: a flaky E2E is a
 * defect to fix). Issued H&S evidence is non-deletable for EVERY role — service role
 * included (tg_ra_block_delete_when_issued / tg_permit_block_delete_when_issued) — so the
 * old per-run `Date.now()` seeds could never be cleaned up and accumulated forever on a
 * local DB (24 issued "A11y RAMS <stamp>" rows by the time this was fixed), while CI's
 * fresh volume rendered none of them: the two environments drifted into scanning different
 * DOMs. Idempotency for immutable evidence is therefore REUSE, not delete-and-reseed: one
 * fixed sentinel per shape, created + issued only if absent, with draft leftovers (a crash
 * between insert and issue) healed by deletion first — drafts are the one deletable state.
 */

const SLUG = "e2e-harness-org";
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/** Fixed sentinel identities — looked up and reused across runs (see beforeAll). */
const RA_TITLE = "A11y RAMS E2E";
const PERMIT_TITLE = "A11y permit E2E";

function svc() {
  return createClient(assertLocalE2eTarget("health-safety-a11y.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe("health & safety — accessibility + mobile", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  let raId = "";
  let permitId = "";

  test.beforeAll(async () => {
    const db = svc();
    const t = (n: string) => (db as unknown as { from: (n: string) => any }).from(n); // eslint-disable-line @typescript-eslint/no-explicit-any
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id as string | undefined;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    // Heal deletable leftovers from any earlier scheme or crashed run: draft is the only
    // state the block-delete triggers permit. The `A11y RAMS %` pattern covers both the
    // legacy stamped titles and a partially-created sentinel.
    const healRa = await t("risk_assessments").delete().eq("org_id", orgId).eq("status", "draft").like("title", "A11y RAMS %");
    if (healRa.error) throw new Error(`a11y seed: draft RAMS cleanup failed (${healRa.error.message})`);

    // Issued sentinel RAMS with a hazard (so the hazards view + sign-off panel render).
    // Reused when present; the hazard is guaranteed on reuse because the create path only
    // issues AFTER inserting it (a crash before issue leaves a draft, healed above).
    const foundRa = await t("risk_assessments").select("id").eq("org_id", orgId).eq("title", RA_TITLE).eq("status", "issued").limit(1).maybeSingle();
    if (foundRa.error) throw new Error(`a11y seed: RAMS lookup failed (${foundRa.error.message})`);
    if (foundRa.data?.id) {
      raId = String(foundRa.data.id);
    } else {
      raId = String((await t("risk_assessments").insert({ org_id: orgId, title: RA_TITLE, activity: "Roofing" }).select("id").single()).data?.id);
      await t("risk_assessment_hazards").insert({ org_id: orgId, risk_assessment_id: raId, hazard: "Fall from height", likelihood: 4, severity: 5, control_measures: "Edge protection + harness" });
      const issuedRa = await t("risk_assessments").update({ status: "issued", reference: "RA-A11Y-E2E", issued_at: new Date().toISOString() }).eq("id", raId).select("status").single();
      if (issuedRa.error || issuedRa.data?.status !== "issued") {
        throw new Error(`a11y seed: RAMS did not issue (${issuedRa.error?.message ?? `status=${issuedRa.data?.status}`})`);
      }
    }

    // Issued sentinel permit. valid_until is FAR future on purpose: expiry is DERIVED at
    // read (valid_until < now) and the window is frozen once issued, so a realistic short
    // window would flip the reused sentinel's detail page to expired-state DOM on the next
    // day's run — the scan must keep auditing the issued state this test is named for.
    const healPermit = await t("permits_to_work").delete().eq("org_id", orgId).eq("status", "draft").like("title", "A11y permit %");
    if (healPermit.error) throw new Error(`a11y seed: draft permit cleanup failed (${healPermit.error.message})`);
    const foundPermit = await t("permits_to_work").select("id").eq("org_id", orgId).eq("title", PERMIT_TITLE).eq("status", "issued").limit(1).maybeSingle();
    if (foundPermit.error) throw new Error(`a11y seed: permit lookup failed (${foundPermit.error.message})`);
    if (foundPermit.data?.id) {
      permitId = String(foundPermit.data.id);
    } else {
      permitId = String((await t("permits_to_work").insert({ org_id: orgId, permit_type: "hot_works", title: PERMIT_TITLE, scope: "Welding", valid_from: "2026-01-01T00:00:00.000Z", valid_until: "2036-01-01T00:00:00.000Z" }).select("id").single()).data?.id);
      const issuedPermit = await t("permits_to_work").update({ status: "issued", reference: "PTW-A11Y-E2E", issued_at: new Date().toISOString() }).eq("id", permitId).select("status").single();
      if (issuedPermit.error || issuedPermit.data?.status !== "issued") {
        throw new Error(`a11y seed: permit did not issue (${issuedPermit.error?.message ?? `status=${issuedPermit.data?.status}`})`);
      }
    }
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
    await expect(page.getByRole("heading", { name: RA_TITLE })).toBeVisible();
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
