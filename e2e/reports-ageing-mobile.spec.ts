/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * /reports/ageing summary tiles — 7-figure money on a phone.
 *
 * The owner reads the aged-debtors report on a 375px phone, and a large business
 * can be owed a 7-figure GBP total. The summary uses the shared `StatTile`, whose
 * value line was a fixed `text-xl sm:text-2xl` with no `truncate`, so a 7-figure
 * value pushed the 2-up grid (`grid-cols-2` at this width) wider than the
 * viewport and the whole page scrolled sideways. The value line is now
 * `truncate tabular-nums` inside the tile's existing `min-w-0` card (the idiom
 * the inline dashboard KPI already uses), so a wide figure is clipped to its
 * cell instead of stretching the grid. This spec guards that layout for every
 * StatTile consumer via /reports/ageing.
 *
 * Reads only in the browser — the ageing arithmetic itself is proved in the
 * commercial unit tier (__tests__/commercial/aged-debtors-reconciliation.test.ts);
 * this spec guards the layout.
 *
 * Seeding is idempotent against the PERSISTENT local database: a fixed-numbered
 * invoice is deleted and reseeded in beforeAll, so a local run does not drift the
 * scanned DOM. The invoice is `sent`, unpaid, past its due date with a 7-figure
 * total, so both "Owed to you" and "Of that, overdue" carry 7-figure values.
 */

const SLUG = "e2e-harness-org";
const INV_NUMBER = "AGEING-E2E-BIGMONEY";
const CUST_NAME = "Ageing Mobile E2E Customer";

function svc() {
  return createClient(
    assertLocalE2eTarget("reports-ageing-mobile.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

test.describe("reports/ageing — 7-figure StatTile money at 375px does not overflow", () => {
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

    // A SENT 7-figure invoice, unpaid and past its due date: £5,000,000 net +
    // £1,234,567 VAT = £6,234,567 gross, entirely outstanding. This makes both
    // "Owed to you" (debtors total) and "Of that, overdue" (past the due date)
    // 7-figure — the values that used to blow out the grid at 375px.
    await db.from("invoices").insert({
      org_id: orgId,
      customer_id: custId,
      number: INV_NUMBER,
      amount: 5_000_000,
      vat_total: 1_234_567,
      total: 6_234_567,
      status: "sent",
      due_date: "2020-01-01",
    });
  });

  test("renders the ageing summary tiles with no horizontal scroll at 375px", async ({ page }) => {
    await page.goto("/reports/ageing");

    // The summary tiles reached the page with their 7-figure values.
    await expect(page.getByText("Owed to you").first()).toBeVisible();
    await expect(page.getByText("Of that, overdue").first()).toBeVisible();

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
