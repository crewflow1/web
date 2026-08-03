/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * Warehouse M1 — Journey: receiving a PART delivery, then the rest.
 *
 * The journey worth driving in a real browser is the one that spans the whole
 * stack in a single user action: yard form → Server Action → the
 * post_goods_received_note RPC → a note, its lines and the ORDER'S DERIVED
 * STATUS in one transaction → the page that re-derives all of it. Nothing
 * below is mocked, and nothing asserts on an intermediate: it asserts on the
 * numbers a builder standing at the lorry would read.
 *
 *   100 blocks ordered, 40 arrive  → "Part received", 60 outstanding
 *   the other 60 arrive            → "Received", 0 outstanding
 *   both delivery notes remain     → the history is intact
 *
 * WHY THE NAVIGATION IS RELIABLE HERE (unlike e2e/fleet.spec.ts, which had to
 * assert on the action response because the client router did not follow
 * `x-action-redirect` under `next start`): this form does not depend on the
 * client router at all. It returns FormState with `redirectTo` and the client
 * component calls `window.location.assign`, a full document navigation the
 * browser always performs. That was chosen for the yard — a dropped navigation
 * would leave the operator on a page that looks like nothing happened, and
 * they would post the delivery twice — and it makes this spec deterministic as
 * a side effect.
 *
 * Scope: the DB invariants behind this (over-receipt blocking, the transition
 * trigger, immutability, the void path, concurrency, tenant isolation) are
 * proven against real Postgres in
 * __tests__/integration/rls/goods-received-notes.test.ts; the arithmetic is
 * proven in __tests__/purchase-orders/receiving.test.ts. This spec proves the
 * journey joins them up.
 */

const SLUG = "e2e-harness-org";
function svc() {
  return createClient(
    assertLocalE2eTarget("po-receiving.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
const TAG = `R-${Date.now()}`;

test.describe("purchase orders — receiving a delivery", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  let poId = "";
  let mobilePoId = "";

  /** A SENT order with one 100-unit line — the state a delivery arrives against. */
  async function seedSentPo(db: { from: (t: string) => any }, orgId: string, suffix: string) {
    const po = (
      await db
        .from("purchase_orders")
        .insert({
          org_id: orgId,
          number: `PO-${TAG}${suffix}`,
          status: "sent",
          subtotal: 500,
          vat_total: 100,
        })
        .select("id")
        .single()
    ).data;
    await db.from("purchase_order_line_items").insert({
      org_id: orgId,
      purchase_order_id: po.id,
      description: `Dense blocks ${TAG}${suffix}`,
      qty: 100,
      unit: "ea",
      unit_price: 5,
      vat_rate: 20,
      line_total: 500,
      sort_order: 0,
    });
    return po.id as string;
  }

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data
      ?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    poId = await seedSentPo(db, orgId, "");
    // Its own order: the journey test receives the first one in FULL, which
    // (correctly) removes the receive affordance from it.
    mobilePoId = await seedSentPo(db, orgId, "-M");
  });

  test("a logged-out visitor cannot see the receiving flow", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto(`/purchase-orders/${poId}`);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: /receive delivery/i })).toHaveCount(0);
  });

  test("40 of 100 arrive, then the other 60 — and the order tells the truth throughout", async ({
    page,
  }) => {
    // Two independent renderings of the same truth: the order's own status
    // pill (from purchase_orders.status, derived in the database) and the
    // Deliveries panel's receipt pill (from the posted notes, derived in the
    // app). Asserting on BOTH is the point — if the trigger and
    // computeReceiving ever disagreed, the page would say two different things
    // and only a paired assertion catches it.
    const deliveries = page.getByRole("region", { name: "Deliveries" });
    const orderStatus = page.locator("header span").last();
    const outstanding = deliveries.locator("dt", { hasText: "Outstanding" }).locator("+ dd");

    // ── nothing received yet ────────────────────────────────────────────────
    await page.goto(`/purchase-orders/${poId}`);
    await expect(page.getByRole("heading", { name: `PO-${TAG}` })).toBeVisible();
    await expect(orderStatus).toHaveText("Sent");
    await expect(deliveries.getByText("Not received")).toBeVisible();
    await expect(outstanding).toHaveText("100");

    // ── receive 40 ──────────────────────────────────────────────────────────
    await deliveries.getByRole("button", { name: /^receive delivery$/i }).click();
    // Real hydration, not a sleep: the entered quantity lives in client state,
    // so a fill that lands before React attaches is silently discarded and the
    // submit posts an empty delivery.
    await page.waitForFunction(() => {
      const el = document.querySelector("form");
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
    });
    await expect(page.getByText(/100 ea ordered/)).toBeVisible();

    await page
      .getByLabel(`Quantity received for Dense blocks ${TAG}`)
      .fill("40");
    await page.getByLabel(/delivery note no/i).fill(`DN-${TAG}-1`);
    // The live preview does the arithmetic before the round trip.
    await expect(page.getByText(/→ 40 of 100 · 60 still to come/)).toBeVisible();

    await page.getByRole("button", { name: /confirm delivery/i }).click();

    // window.location.assign lands on the order with the new note highlighted.
    await page.waitForURL(new RegExp(`/purchase-orders/${poId}\\?received=`));
    await expect(page.getByText(/Delivery recorded/i)).toBeVisible();

    // THE assertion: the order re-derived its own state from the receipt, and
    // both renderings agree.
    await expect(orderStatus).toHaveText("Part received");
    await expect(deliveries.getByText("Part received")).toBeVisible();
    await expect(deliveries.getByText(`DN-${TAG}-1`, { exact: false }).first()).toBeVisible();
    await expect(deliveries.getByText("GRN-", { exact: false }).first()).toBeVisible();

    // Outstanding is 60 — the number the next delivery is judged against.
    await expect(outstanding).toHaveText("60");

    // ── receive the remaining 60 ────────────────────────────────────────────
    await deliveries.getByRole("button", { name: /^receive delivery$/i }).click();
    await page.waitForFunction(() => {
      const el = document.querySelector("form");
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
    });
    // The line now remembers what already arrived.
    await expect(page.getByText(/40 received so far/)).toBeVisible();

    // One tap for the common case: everything still outstanding turned up.
    await page.getByRole("button", { name: /^all arrived$/i }).click();
    await expect(page.getByText(/→ 100 of 100 · complete/)).toBeVisible();
    await page.getByLabel(/delivery note no/i).fill(`DN-${TAG}-2`);
    await page.getByRole("button", { name: /confirm delivery/i }).click();

    await page.waitForURL(new RegExp(`/purchase-orders/${poId}\\?received=`));

    // ── fully received, with the history intact ─────────────────────────────
    await expect(orderStatus).toHaveText("Received");
    await expect(outstanding).toHaveText("0");

    // BOTH delivery notes survive — the second did not replace the first.
    await expect(deliveries.getByText(`DN-${TAG}-1`, { exact: false }).first()).toBeVisible();
    await expect(deliveries.getByText(`DN-${TAG}-2`, { exact: false }).first()).toBeVisible();

    // The order can no longer take a delivery, and says so rather than
    // offering a button the database would refuse.
    await expect(deliveries.getByText(/Everything on this order has been received/i)).toBeVisible();
    await expect(deliveries.getByRole("button", { name: /^receive delivery$/i })).toHaveCount(0);

    // ── and the register carries the receipt badge ──────────────────────────
    await page.goto("/purchase-orders");
    const row = page.getByRole("row", { name: new RegExp(`PO-${TAG}`) });
    await expect(row.getByText("Received", { exact: true })).toBeVisible();
    await expect(row.getByText("2 received", { exact: true })).toBeVisible();
  });

  test("the receiving flow fits a phone held in one hand at 375px", async ({ page }) => {
    // The whole design brief for this form is "a phone, one hand, a lorry
    // waiting". A page that scrolls sideways fails that on the first tap, so
    // assert it structurally rather than trusting the classes.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/purchase-orders/${mobilePoId}`);
    const deliveries = page.getByRole("region", { name: "Deliveries" });
    await deliveries.getByRole("button", { name: /^receive delivery$/i }).click();
    await page.waitForFunction(() => {
      const el = document.querySelector("form");
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
    });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the receiving form scrolls horizontally at 375px").toBeLessThanOrEqual(0);

    // The quantity field opens a numeric keypad and is large enough that iOS
    // will not zoom the viewport on focus (16px text).
    const qty = page.getByLabel(/^Quantity received for/).first();
    await expect(qty).toHaveAttribute("inputmode", "decimal");
    const fontPx = await qty.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontPx).toBeGreaterThanOrEqual(16);
  });

  test("the register LIST fits a phone at 375px — the Total is not clipped", async ({ page }) => {
    // The bug this guards: the list wrapped a six-column w-full table in
    // `overflow-hidden` and rendered every column at every width, so at 375px
    // the right-aligned Total (an unbreakable "£10,000.00") was pushed past the
    // viewport edge and CLIPPED with no scroll to reach it. The fix is the
    // jobs/quotes/invoices idiom: `hidden md:block` table + a `md:hidden` card
    // list. Asserting structurally (mobile cards visible, Total reachable, no
    // body overflow) rather than trusting the classes.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/purchase-orders");
    await expect(page.getByRole("heading", { name: /purchase orders/i })).toBeVisible();

    // The seeded order (with its £600 total) reaches the list as a mobile card,
    // and its Total is on screen — never clipped past the right edge.
    const card = page.getByRole("link", { name: new RegExp(`PO-${TAG}(?!-M)`) }).first();
    await expect(card).toBeVisible();
    const total = card.getByText("£600.00", { exact: false }).first();
    await expect(total).toBeVisible();

    // The desktop table is hidden at this width — only the card list shows.
    await expect(page.getByRole("table")).toHaveCount(0);

    // Settle before measuring: reading scrollWidth before web fonts land uses
    // fallback glyph metrics (narrower) and can mask a real overflow. Retries
    // are 0 in this repo, so measure only after hydration + fonts.ready.
    await settleForAxe(page);
    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(
      overflow.scrollWidth - overflow.clientWidth,
      `the register scrolls horizontally at 375px (${overflow.scrollWidth} > ${overflow.clientWidth})`,
    ).toBeLessThanOrEqual(0);

    // The Total is also fully inside the viewport box — the actual clip failure
    // mode is an element that renders but sits past the right edge.
    const box = await total.boundingBox();
    expect(box, "the Total should have a box").not.toBeNull();
    expect(box!.x + box!.width, "the Total is clipped past the 375px viewport").toBeLessThanOrEqual(375);
  });
});
