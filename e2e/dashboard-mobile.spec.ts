/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * Dashboard KPI tiles — 7-figure money on a phone.
 *
 * The owner reads this page on a 375px phone, and a large business can carry
 * 7-figure GBP tiles (£6,234,567.00). The Kpi money tiles used a fixed
 * `text-2xl` value line with no `min-w-0` on the tile, so a 7-figure value
 * pushed the 2-up grid wider than the viewport and the whole page scrolled
 * sideways. The value line is now `truncate tabular-nums` inside a `min-w-0`
 * tile (the idiom the fixed tiles on /stock and /cash already use), so a wide
 * figure is clipped to its cell instead of stretching the grid.
 *
 * Reads only in the browser — the VAT composition itself is proved in the tax
 * unit tier (__tests__/tax/compute.test.ts); this spec guards the layout.
 *
 * Seeding is idempotent against the PERSISTENT local database: a fixed-numbered
 * invoice is deleted and reseeded in beforeAll, so a local run does not drift
 * the scanned DOM. The invoice is `paid` this quarter with a 7-figure total, so
 * both "Invoiced this month" and "VAT this quarter" carry 7-figure values.
 */

const SLUG = "e2e-harness-org";
const INV_NUMBER = "DASH-E2E-BIGMONEY";
const CUST_NAME = "Dashboard Mobile E2E Customer";

function svc() {
  return createClient(
    assertLocalE2eTarget("dashboard-mobile.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

test.describe("dashboard KPIs — 7-figure money tiles at 375px do not overflow", () => {
  test.use({ storageState: "e2e/.auth/owner.json", viewport: { width: 375, height: 812 } });

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    // Reset this spec's own row (fixed number, never Date.now()).
    await db.from("invoices").delete().eq("org_id", orgId).eq("number", INV_NUMBER);

    let custId = (
      await db.from("customers").select("id").eq("org_id", orgId).eq("name", CUST_NAME).maybeSingle()
    ).data?.id;
    if (!custId) {
      custId = (
        await db.from("customers").insert({ org_id: orgId, name: CUST_NAME }).select("id").single()
      ).data?.id;
    }

    // A PAID 7-figure invoice, paid now (current quarter) and created now
    // (current month): £5,000,000 net + £1,234,567 VAT = £6,234,567 gross. This
    // makes "Invoiced this month" (created_at) and "VAT this quarter" (paid_at)
    // both 7-figure — the values that used to blow out the grid at 375px.
    const nowIso = new Date().toISOString();
    await db.from("invoices").insert({
      org_id: orgId,
      customer_id: custId,
      number: INV_NUMBER,
      amount: 5_000_000,
      vat_total: 1_234_567,
      total: 6_234_567,
      status: "paid",
      paid_at: nowIso,
      due_date: nowIso.slice(0, 10),
    });
  });

  test("renders the KPI tiles with no horizontal scroll at 375px", async ({ page }) => {
    await page.goto("/dashboard");

    // The money tiles reached the page with their 7-figure values.
    await expect(page.getByText("Invoiced this month").first()).toBeVisible();
    await expect(page.getByText("VAT this quarter").first()).toBeVisible();

    // Settle first: reading scrollWidth before web fonts land measures fallback
    // glyph metrics (narrower), which can mask a real overflow.
    await settleForAxe(page);
    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(
      overflow.scrollWidth - overflow.clientWidth,
      `page overflows horizontally at 375px (${overflow.scrollWidth} > ${overflow.clientWidth})`,
    ).toBeLessThanOrEqual(1);
  });
});
