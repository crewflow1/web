/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * 7-figure money tiles at 375px — the grid-cols-2/3 tiles on a job, its
 * commercial page, and an invoice.
 *
 * The owner reads these three pages on a 375px phone. A construction job
 * legitimately carries a 7-figure ex-VAT value (£6,234,567.00). A comma-grouped
 * GBP token has NO soft-wrap opportunity, so at `text-lg font-semibold` its
 * min-content width (~120px) exceeds a `grid-cols-3` track (~90px at 375px);
 * with nothing to clip it the tile pushes its grid parent past the viewport and
 * the WHOLE document scrolls sideways — the same mechanism the /cash and
 * /dashboard fixes addressed. The fix is `truncate` on each money value line +
 * `min-w-0` on each grid item (a grid track's default min-width is min-content,
 * so `truncate` alone is inert until the track can shrink).
 *
 * Three surfaces, each with its own 7-figure tile:
 *   - /jobs/[id]            — Profitability (grid-cols-3) Revenue/Costs/Gross
 *                             profit, and Job value (grid-cols-2) Original/Total.
 *   - /jobs/[id]/commercial — the shared `Tile` (grid-cols-2) Contract value /
 *                             Billed.
 *   - /invoices/[id]        — the payments panel (grid-cols-3) Invoice total /
 *                             Paid / Outstanding.
 *
 * Value assertions are scoped to a specific labelled tile/section, never to an
 * org-wide aggregate: every figure here is JOB- or INVOICE-scoped (this spec's
 * uniquely-named invoice and accepted quote), so the exact £6,234,567.00 token
 * appears rather than blending into a total (the pitfall the /cash spec hit).
 *
 * Reads only in the browser — the summary maths is proved in the unit tier
 * (lib/profitability, lib/commercial); this spec guards the layout.
 *
 * Seeding is idempotent against the PERSISTENT local database: a fixed-id job, a
 * fixed-named customer, and this spec's uniquely-numbered invoice and accepted
 * quote are deleted and reseeded in beforeAll, so a local run does not drift the
 * scanned DOM. The invoice is unpaid (no `invoice_payments`), so it carries no
 * settlement freeze and is freely deletable.
 */

const SLUG = "e2e-harness-org";
// Fixed, namespaced ids so beforeAll is idempotent and never collides with the
// globalSetup sentinel job or another spec's seeds.
const JOB = "c2222222-2222-2222-2222-222222222222";
const CUST_NAME = "Money Tile Mobile E2E Customer";
const INV_NUMBER = "MONEYTILE-E2E-INV";
const QUOTE_NUMBER = "MONEYTILE-E2E-Q";
// A 7-figure ex-VAT value. `£6,234,567.00` is comma-grouped and non-wrapping —
// exactly the token that overflowed the grid-cols-3 tracks before the fix.
const BIG_AMOUNT = 6_234_567;
const BIG_TOKEN = "£6,234,567.00";

function svc() {
  return createClient(
    assertLocalE2eTarget("money-tile-mobile.spec.ts"),
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

test.describe("7-figure money tiles at 375px do not scroll the page sideways", () => {
  test.use({ storageState: "e2e/.auth/owner.json", viewport: { width: 375, height: 812 } });

  let invoiceId: string;

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    let custId = (
      await db.from("customers").select("id").eq("org_id", orgId).eq("name", CUST_NAME).maybeSingle()
    ).data?.id;
    if (!custId) {
      custId = (
        await db.from("customers").insert({ org_id: orgId, name: CUST_NAME }).select("id").single()
      ).data?.id;
    }

    // Fixed-id job (upsert) so this spec owns a stable target with a customer set.
    const job = await db
      .from("jobs")
      .upsert({ id: JOB, org_id: orgId, customer_id: custId, status: "in-progress" });
    if (job.error) throw new Error(`money-tile seed (job): ${job.error.message}`);

    // ── Reset this spec's own rows (fixed refs, never Date.now()) ─────────────
    await db.from("invoices").delete().eq("org_id", orgId).eq("number", INV_NUMBER);
    await db.from("quotes").delete().eq("org_id", orgId).eq("number", QUOTE_NUMBER);

    // An accepted BASE quote (variation_number null) → the commercial "Contract
    // value" (revised) tile is 7-figure. Gross = net here (vat_total 0) so the
    // exact token matches on both the ex-VAT and gross surfaces.
    const quote = await db.from("quotes").insert({
      org_id: orgId,
      customer_id: custId,
      job_id: JOB,
      number: QUOTE_NUMBER,
      status: "accepted",
      subtotal: BIG_AMOUNT,
      vat_total: 0,
      total: BIG_AMOUNT,
    });
    if (quote.error) throw new Error(`money-tile seed (quote): ${quote.error.message}`);

    // A 7-figure invoice linked to the job, NOT linked to a quote → it counts as
    // ORIGINAL revenue on /jobs/[id] and drives the commercial "Billed" tile and
    // its own /invoices/[id] "Invoice total" tile. `sent` (non-draft) so it is
    // billed. vat_total 0 → total = amount (generated) = £6,234,567.00.
    const inv = await db
      .from("invoices")
      .insert({
        org_id: orgId,
        customer_id: custId,
        job_id: JOB,
        number: INV_NUMBER,
        amount: BIG_AMOUNT,
        vat_total: 0,
        status: "sent",
        due_date: "2027-01-01",
      })
      .select("id")
      .single();
    if (inv.error) throw new Error(`money-tile seed (invoice): ${inv.error.message}`);
    invoiceId = inv.data!.id as string;
  });

  test("job page — Profitability + Job value tiles clip the 7-figure figure", async ({ page }) => {
    await page.goto(`/jobs/${JOB}`);

    // The Profitability (grid-cols-3) Revenue tile carries the 7-figure figure.
    const profitability = page.locator("section").filter({ hasText: "Profitability" });
    await expect(profitability.getByText("Revenue").first()).toBeVisible();
    await expect(profitability.getByText(BIG_TOKEN).first()).toBeVisible();

    // The Job value (grid-cols-2) breakdown shows it as Original + Total.
    const jobValue = page.locator("section").filter({ hasText: "Job value" });
    await expect(jobValue.getByText(BIG_TOKEN).first()).toBeVisible();

    await pageHasNoHorizontalScroll(page, "/jobs/[id]");
  });

  test("job commercial page — the shared Tile clips the 7-figure figure", async ({ page }) => {
    await page.goto(`/jobs/${JOB}/commercial`);

    // The "Contract value" (strong) Tile — the shared primitive — is 7-figure.
    await expect(page.getByText("Contract value").first()).toBeVisible();
    await expect(page.getByText(BIG_TOKEN).first()).toBeVisible();

    await pageHasNoHorizontalScroll(page, "/jobs/[id]/commercial");
  });

  test("invoice page — the payments panel tiles clip the 7-figure figure", async ({ page }) => {
    await page.goto(`/invoices/${invoiceId}`);

    // The payments panel (grid-cols-3) "Invoice total" tile is 7-figure.
    const payments = page.locator("section").filter({ hasText: "Payments" });
    await expect(payments.getByText("Invoice total").first()).toBeVisible();
    await expect(payments.getByText(BIG_TOKEN).first()).toBeVisible();

    await pageHasNoHorizontalScroll(page, "/invoices/[id]");
  });
});
