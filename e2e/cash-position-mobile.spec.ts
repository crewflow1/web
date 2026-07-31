/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * H2-CASH M4 — /cash money-OUT + net position, on a phone.
 *
 * The owner who needs this number is standing on a site holding a 375px phone,
 * so the two things that must not regress are: the page renders at 375px with
 * NO horizontal scroll, and the money-out breakdown stays legible — every row
 * keeps its certainty word, its estimate flag and its figure without the label
 * and the amount colliding.
 *
 * It also proves the composition reaches the real page: the seeded £1,200 bill,
 * the part-billed purchase order's £1,800 remainder, and the draft payroll run
 * all appear, and the position's three tiles stack rather than squash.
 *
 * Seeding is idempotent against a PERSISTENT local database (the hub-spec
 * pattern): every row this spec creates is deletable — unpaid bills carry no
 * settlement, so neither the CIS bill-value freeze (20261053000000) nor the
 * settlement floor (20261054000000) applies; the PO has no receipts; the
 * payroll run is a draft. beforeAll deletes this spec's own signature rows and
 * reseeds fixed ones, so a local run does not accumulate residue and drift the
 * scanned DOM away from fresh-volume CI's.
 *
 * Reads only in the browser — every write path is proved in the unit,
 * integration and security tiers.
 */

const SLUG = "e2e-harness-org";
const REF_BILL = "CASHOUT-E2E-BILL";
const REF_PO_BILL = "CASHOUT-E2E-POBILL";
const PO_NUMBER = "CASHOUT-E2E-PO";

function svc() {
  return createClient(
    assertLocalE2eTarget("cash-position-mobile.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

test.describe("cash position on a phone — money out and the net position at 375px", () => {
  test.use({ storageState: "e2e/.auth/owner.json", viewport: { width: 375, height: 812 } });

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    // ── Reset this spec's own rows (fixed refs, never Date.now()) ───────────
    await db.from("finances").delete().eq("org_id", orgId).in("reference", [REF_BILL, REF_PO_BILL]);
    await db.from("payroll_runs").delete().eq("org_id", orgId).eq("period_start", "2020-01-06");
    await db.from("purchase_orders").delete().eq("org_id", orgId).eq("number", PO_NUMBER);

    let supplierId = (
      await db.from("suppliers").select("id").eq("org_id", orgId).eq("name", "Cash-Out E2E Merchant").maybeSingle()
    ).data?.id;
    if (!supplierId) {
      supplierId = (
        await db.from("suppliers").insert({ org_id: orgId, name: "Cash-Out E2E Merchant" }).select("id").single()
      ).data?.id;
    }

    // An unpaid supplier bill: £1,000 net + 20% VAT = £1,200 gross.
    await db.from("finances").insert({
      org_id: orgId,
      supplier_id: supplierId,
      amount: 1000,
      vat_rate: 20,
      category: "materials",
      reference: REF_BILL,
    });

    // A £2,400 purchase order, PART billed by £600 — the precedence case. The
    // page must show £1,800 committed (2,400 ordered − 600 invoiced), never
    // £2,400, and the £600 must appear once, in unpaid bills.
    const poId = (
      await db
        .from("purchase_orders")
        .insert({ org_id: orgId, supplier_id: supplierId, number: PO_NUMBER, status: "sent", subtotal: 2000, vat_total: 400 })
        .select("id")
        .single()
    ).data?.id;
    await db.from("finances").insert({
      org_id: orgId,
      supplier_id: supplierId,
      purchase_order_id: poId,
      amount: 500,
      vat_rate: 20,
      category: "materials",
      reference: REF_PO_BILL,
    });

    // A DRAFT payroll run — the estimated outflow component.
    const runId = (
      await db
        .from("payroll_runs")
        .insert({ org_id: orgId, cycle: "weekly", period_start: "2020-01-06", period_end: "2020-01-12", status: "draft" })
        .select("id")
        .single()
    ).data?.id;
    const ownerId = (
      await db.from("memberships").select("user_id").eq("org_id", orgId).eq("role", "owner").limit(1).maybeSingle()
    ).data?.user_id;
    if (runId && ownerId) {
      await db.from("payroll_lines").insert({
        org_id: orgId,
        payroll_run_id: runId,
        user_id: ownerId,
        hours: 40,
        hourly_pay: 25,
        gross_pay: 1000,
        paye_estimate: 150,
        ni_estimate: 50,
        net_pay: 800,
      });
    }
  });

  test("renders the position and the money-out breakdown with no horizontal scroll", async ({ page }) => {
    await page.goto("/cash");
    await expect(page.getByRole("heading", { name: /cash position/i }).first()).toBeVisible();

    // ── The net position ───────────────────────────────────────────────────
    const position = page.locator('section[aria-labelledby="position-heading"]');
    await expect(position).toBeVisible();
    // Each tile is a <dt> in the position's definition list. Scoped to `dt`
    // because the section's own <h2> is also called "Net position" — a bare
    // getByText matches the heading AND the tile. Naming the term keeps the
    // assertion on the FIGURE's label, which is what must not regress.
    const tile = (label: RegExp) => position.locator("dt").filter({ hasText: label });
    await expect(tile(/Collectable now/i)).toBeVisible();
    await expect(tile(/Owed out now/i)).toBeVisible();
    await expect(tile(/Net position/i)).toBeVisible();
    // The honesty line is not optional furniture.
    await expect(position.getByText(/not your cash at bank/i)).toBeVisible();

    // ── The money-out breakdown ────────────────────────────────────────────
    const outflow = page.locator('section[aria-labelledby="outflow-heading"]');
    await expect(outflow).toBeVisible();
    // Each component is a tappable row ("Tap a row for the records behind it"),
    // so assert the ROW, not loose text: the section's footer prose also reads
    // "…VAT + draft payroll", which a bare getByText(/Draft payroll/i) matches
    // as well as the row. Naming the link proves the row exists AND is a real
    // link through to its records.
    const row = (label: RegExp) => outflow.getByRole("link", { name: label });
    await expect(row(/Unpaid supplier bills/i)).toBeVisible();
    await expect(row(/Ordered, not yet invoiced/i)).toBeVisible();
    await expect(row(/Draft payroll/i)).toBeVisible();
    // An estimate says so, in words, on the row itself.
    await expect(outflow.getByText("Estimate", { exact: true }).first()).toBeVisible();
    // Committed spend is visibly OUTSIDE the position.
    await expect(outflow.getByText(/not in the position/i).first()).toBeVisible();

    // This seed's distinctive figures (other specs seed into the same org, so
    // assert on OUR rows, never on an org aggregate): the part-billed PO leaves
    // £1,800 committed, and the seeded bill is £1,200.
    await expect(page.getByText(/£1,800\.00/).first()).toBeVisible();
    await expect(page.getByText(/£1,200\.00/).first()).toBeVisible();

    // ── The payables queue links through to where a bill is settled ─────────
    const bills = page.locator('section[aria-labelledby="q-bills"]');
    await expect(bills).toBeVisible();
    await expect(bills.getByText(/Cash-Out E2E Merchant/).first()).toBeVisible();
    await expect(bills.locator('a[href*="/payments"]').first()).toBeVisible();

    // ── 375px: the page body must not scroll sideways ───────────────────────
    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(
      overflow.scrollWidth,
      `page overflows horizontally at 375px (${overflow.scrollWidth} > ${overflow.clientWidth})`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);

    // And neither new section overflows its own box.
    for (const sel of [
      'section[aria-labelledby="position-heading"]',
      'section[aria-labelledby="outflow-heading"]',
      'section[aria-labelledby="q-bills"]',
    ]) {
      const box = await page.locator(sel).boundingBox();
      expect(box, `${sel} should have a box`).not.toBeNull();
      expect(box!.width, `${sel} wider than the 375px viewport`).toBeLessThanOrEqual(375);
    }

    // A row's label and its amount must not overlap — the failure mode when
    // badges wrap badly is the figure sliding under the text.
    const label = await outflow.getByText(/Unpaid supplier bills/i).boundingBox();
    const rowAmounts = outflow.locator("span.tabular-nums");
    const amount = await rowAmounts.first().boundingBox();
    expect(label).not.toBeNull();
    expect(amount).not.toBeNull();
    const disjoint =
      amount!.x >= label!.x + label!.width - 1 || amount!.y >= label!.y + label!.height - 1;
    expect(disjoint, "the money-out label and its figure overlap at 375px").toBe(true);
  });
});
