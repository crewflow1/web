/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * 7-figure money tiles at 375px — the CUSTOMER PORTAL payments summary.
 *
 * The money-tile-overflow guard's "cannot be evaded" contract used to be false by
 * DIRECTORY SCOPE: it walked only `app/(app)`, so `app/customer-portal` slipped
 * through. The invoices portal opens a base `grid grid-cols-2 gap-3 sm:grid-cols-3`
 * and renders Paid to date / Due now / Overdue as `text-xl font-bold` money
 * figures. A comma-grouped GBP token (`£1,234,567.00`) has NO soft-wrap
 * opportunity, so at 375px its min-content width (~130px) exceeds a `grid-cols-2`
 * track (~155px minus the tile padding); with nothing to clip it the tile pushes
 * its grid parent past the viewport and the WHOLE document scrolls sideways — the
 * same mechanism the /cash, /dashboard and jobs/invoices fixes addressed. The fix
 * is `truncate` on each money value line + `min-w-0` on each grid item (a grid
 * track's default min-width is min-content, so `truncate` alone is inert until the
 * track can shrink).
 *
 * The portal is TOKEN-scoped — the `portal_token` IS the credential, there is no
 * owner login — so this spec uses NO storageState; it seeds a customer, reads that
 * customer's `portal_token`, and navigates the public portal URL directly (the
 * seed idiom from portal-customer.spec.ts, the pixel assertion from
 * money-tile-mobile.spec.ts).
 *
 * The 7-figure `Due now` is JOB/CUSTOMER-scoped to THIS spec's freshly-created
 * customer, so the exact `£6,234,567.00` token appears rather than blending into
 * an org-wide aggregate.
 */

const SLUG = "e2e-harness-org";
const TAG = `PMT-${Date.now()}`;
const INV_NUMBER = `PORTAL-MONEYTILE-${TAG}`;
// A 7-figure receivable. `£6,234,567.00` is comma-grouped and non-wrapping —
// exactly the token that overflowed the grid-cols-2 tracks before the fix.
const BIG_AMOUNT = 6_234_567;
const BIG_TOKEN = "£6,234,567.00";

function svc() {
  return createClient(
    assertLocalE2eTarget("portal-money-tile-mobile.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

async function pageHasNoHorizontalScroll(page: import("@playwright/test").Page, where: string) {
  // Settle first: reading scrollWidth before web fonts land measures fallback
  // glyph metrics (narrower), which can mask a real overflow.
  await settleForAxe(page);
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(
    overflow.scrollWidth - overflow.clientWidth,
    `${where} overflows horizontally at 375px (${overflow.scrollWidth} > ${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(1);
}

test.describe("7-figure portal money tiles at 375px do not scroll the page sideways", () => {
  // Token-scoped route: NO owner auth. Just the phone viewport.
  test.use({ viewport: { width: 375, height: 812 } });

  let token = "";

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    const cust = (
      await db
        .from("customers")
        .insert({ org_id: orgId, name: `Portal Money Tile ${TAG}` })
        .select("id, portal_token")
        .single()
    ).data;
    token = String(cust.portal_token);

    // A 7-figure invoice anchored to THIS customer (org_id + customer_id is the
    // portal invoice scope). `sent` (non-draft) with a future due date → it is a
    // 7-figure `Due now` in computePortalPayments. vat_total 0 → total = amount
    // (generated) = £6,234,567.00. No invoice_payments → freely deletable, and
    // `Paid to date` stays 0 so the exact token lands in the Due-now tile.
    const inv = await db.from("invoices").insert({
      org_id: orgId,
      customer_id: cust.id,
      number: INV_NUMBER,
      amount: BIG_AMOUNT,
      vat_total: 0,
      status: "sent",
      due_date: "2027-01-01",
    });
    if (inv.error) throw new Error(`portal-money-tile seed (invoice): ${inv.error.message}`);
  });

  test("portal invoices — the payments summary tiles clip the 7-figure figure", async ({ page }) => {
    await page.goto(`/customer-portal/${token}/invoices`);

    // Valid token (not the invalid-link page), and the 7-figure Due-now tile shows.
    await expect(page.getByText(/expired or invalid/i)).toHaveCount(0);
    const payments = page.locator("section").filter({ hasText: "Due now" });
    await expect(payments.getByText(BIG_TOKEN).first()).toBeVisible();

    await pageHasNoHorizontalScroll(page, "/customer-portal/[token]/invoices");
  });
});
