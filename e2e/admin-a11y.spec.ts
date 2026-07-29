import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * HQ /admin accessibility — the admin-tier representative scans for the
 * slate-tone contrast sweep (the fixed em-dash cells, timestamps and status
 * buttons on the light admin shell).
 *
 * Auth: the DEDICATED hq user's session (e2e/.auth/hq.json, minted by
 * globalSetup with no membership row). /admin 404s unless the shell that
 * spawned `next start` exported CREWFLOW_SUPERADMIN_EMAILS=e2e-hq@crewflow.test
 * (ci.yml does) — when this process doesn't see that export the suite skips
 * rather than failing on the 404. If it skips locally, export the var and make
 * sure Playwright starts the server itself (reuseExistingServer would keep a
 * stale env alive on :3000).
 */

const SLUG = "e2e-harness-org";
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const HQ_EMAIL = "e2e-hq@crewflow.test";
const hqAllowlisted = (process.env.CREWFLOW_SUPERADMIN_EMAILS ?? "").toLowerCase().includes(HQ_EMAIL);

function svc() {
  return createClient(assertLocalE2eTarget("admin-a11y.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe("HQ admin — accessibility", () => {
  test.skip(!hqAllowlisted, `CREWFLOW_SUPERADMIN_EMAILS must include ${HQ_EMAIL} in the shell that runs Playwright (and the webServer it spawns)`);
  test.use({ storageState: "e2e/.auth/hq.json" });

  let setupId = "";

  test.beforeAll(async () => {
    const db = svc();
    const t = (n: string) => (db as unknown as { from: (n: string) => any }).from(n); // eslint-disable-line @typescript-eslint/no-explicit-any
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id as string | undefined;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");
    // One setup row per org (unique index) — upsert so reruns are idempotent.
    const up = await t("ai_receptionist_setups")
      .upsert({ org_id: orgId, status: "in_progress", business_phone: "01234 567890", trade_type: "Roofing" }, { onConflict: "org_id" })
      .select("id").single();
    if (up.error || !up.data?.id) throw new Error(`admin a11y seed: ai receptionist setup failed — ${up.error?.message}`);
    setupId = String(up.data.id);
  });

  // The worklist family (/worklist, /attention, /my-claims) is NOT scanned
  // here: those pages re-navigate/refresh themselves after load (client URL
  // normalisation + a client-loaded model), which destroys the execution
  // context mid-settle. Scanning them needs a harness that tolerates
  // navigation — their sweep fixes share the same measured tones verified on
  // the routes below.
  for (const [name, path] of [
    ["ai receptionist setup detail (status buttons)", "DETAIL"],
    ["ai receptionist deliveries", "/admin/ai-receptionist/deliveries"],
    ["ai receptionist review queue", "/admin/ai-receptionist/review"],
  ] as const) {
    test(`${name} has no WCAG 2.2 A/AA violations`, async ({ page }) => {
      const url = path === "DETAIL" ? `/admin/ai-receptionist/${setupId}` : path;
      await page.goto(url);
      await settleForAxe(page);
      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(results.violations, JSON.stringify(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), null, 2)).toEqual([]);
    });
  }
});
