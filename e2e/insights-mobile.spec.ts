/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * /insights company-health money tables — long names + 7-figure money on a phone.
 *
 * The owner reads /insights on a 375px phone. The customer-lifetime-value panel
 * and the CIS subcontractor scoreboard render hand-rolled `<table>`s: a name
 * column whose cell is a Next `<Link>` (an inline `<a>`, on which Tailwind
 * `truncate` is INERT — only `white-space:nowrap` applies) and money columns
 * whose comma-grouped GBP tokens have no soft-wrap opportunity. With no
 * `overflow-x-auto` wrapper and the two panels in a single-column grid below
 * `lg`, a long customer name plus a 7-figure realised value pushed the table
 * past the min-content width of its grid item (grid items default
 * `min-width:auto`), and the whole document scrolled sideways.
 *
 * The tables now sit in `overflow-x-auto` wrappers inside `min-w-0` grid items,
 * and the name `<Link>`s are `inline-block max-w-[…] truncate`, so a wide figure
 * or a long name is contained instead of stretching the page.
 *
 * Reads only in the browser — the LTV maths is proved in the unit tier
 * (lib/health/customer-ltv.ts); this spec guards the layout.
 *
 * Seeding is idempotent against the PERSISTENT local database: a fixed-named
 * customer and a fixed-numbered PAID 7-figure invoice attributed to it are
 * deleted and reseeded in beforeAll, so a local run does not drift the scanned
 * DOM. The customer name is deliberately long and unbroken and the invoice is
 * `paid` (so it lands in the LTV "Realised" column as a top-8 row) — together the
 * exact shape that used to blow out the grid at 375px.
 */

const SLUG = "e2e-harness-org";
// A long, unbroken customer name — the worst case for the name column.
const CUST_NAME =
  "Insights Mobile E2E — Really Very Long Construction & Groundworks Holdings Ltd";
const INV_NUMBER = "INSIGHTS-E2E-BIGMONEY";

function svc() {
  return createClient(
    assertLocalE2eTarget("insights-mobile.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

test.describe("insights company-health — long names + 7-figure money at 375px do not overflow", () => {
  test.use({ storageState: "e2e/.auth/owner.json", viewport: { width: 375, height: 812 } });

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data
      ?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    // Reset this spec's own rows (fixed identifiers, never Date.now()).
    await db.from("invoices").delete().eq("org_id", orgId).eq("number", INV_NUMBER);

    let custId = (
      await db.from("customers").select("id").eq("org_id", orgId).eq("name", CUST_NAME).maybeSingle()
    ).data?.id;
    if (!custId) {
      custId = (
        await db.from("customers").insert({ org_id: orgId, name: CUST_NAME }).select("id").single()
      ).data?.id;
    }

    // A PAID 7-figure invoice (ex-VAT amount = £5,000,000.00) attributed to the
    // long-named customer. `paid` makes it the LTV "Realised" value, so the
    // customer appears as a top-8 row with a 7-figure figure beside a long name —
    // the combination that used to stretch the table past 375px.
    const nowIso = new Date().toISOString();
    const inv = await db.from("invoices").insert({
      org_id: orgId,
      customer_id: custId,
      number: INV_NUMBER,
      amount: 5_000_000,
      vat_total: 1_000_000,
      total: 6_000_000,
      status: "paid",
      paid_at: nowIso,
      due_date: nowIso.slice(0, 10),
    });
    if (inv.error) throw new Error(`insights seed (invoice): ${inv.error.message}`);
  });

  test("renders the company-health money tables with no horizontal scroll at 375px", async ({
    page,
  }) => {
    await page.goto("/insights");

    // The LTV panel reached the page with its 7-figure realised value.
    await expect(page.getByText("Customer lifetime value").first()).toBeVisible();
    await expect(page.getByText("£5,000,000.00").first()).toBeVisible();

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
