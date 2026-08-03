/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * O3 OPERATIONAL STOCK — Journey: a delivery becomes stock, and stock becomes a job.
 *
 * The journey worth driving in a real browser is the one that crosses every
 * layer in a single sequence of taps:
 *
 *   name an item          → /stock/items/new, a real Server Action
 *   a POSTED delivery     → "Put into stock" on the purchase order → the
 *                           record_stock_receipt_from_grn RPC
 *   the balance goes UP   → derived by summing the ledger, not stored
 *   issue some to a job   → record_stock_issue under the per-(item, site) lock
 *   the balance goes DOWN → and crosses the reorder level
 *   LOW STOCK appears     → on the item, and on /stock's "Needs ordering"
 *   the history is intact → both movements still there, neither editable
 *
 * DRIVEN AT 375px throughout, because that is the brief: this is used standing
 * in a container with one hand. A page that scrolls sideways fails on the first
 * tap, so it is asserted structurally rather than trusted to the classes.
 *
 * THE ACCOUNTING BOUNDARY is asserted here too, at the only place a user could
 * ever see it break: issuing 10 boards to a job must add NOTHING to that job's
 * cost, because the material was already expensed by the supplier's bill.
 *
 * Scope: the DB invariants behind this (negative-stock refusal under
 * concurrency, idempotency, append-only, the GRN void rule, tenant isolation,
 * teardown) are proven against real Postgres in
 * __tests__/integration/rls/stock-isolation.test.ts; the arithmetic is proven
 * in __tests__/stock/balance.test.ts. This spec proves the journey joins them.
 *
 * Navigation is reliable here for the same reason as e2e/po-receiving.spec.ts:
 * every stock form returns FormState with `redirectTo` and the client calls
 * `window.location.assign` — a full document navigation the browser always
 * performs. That was chosen because these routes sit four segments deep, where
 * Next 15.5 silently drops client-side navigations; determinism here is a side
 * effect of a correctness decision.
 */

const SLUG = "e2e-harness-org";
function svc() {
  return createClient(
    assertLocalE2eTarget("stock.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
const TAG = `S-${Date.now()}`;
const ITEM_NAME = `Dense blocks ${TAG}`;
const SITE_NAME = `Stock yard ${TAG}`;

/** Wait for React to attach — a fill that lands first is silently discarded. */
async function hydrated(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => {
    const el = document.querySelector("form");
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
  });
}

test.describe("operational stock — delivery to job", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  let orgId = "";
  let poId = "";
  let jobId = "";

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any; rpc: (f: string, a: any) => any };
    orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    await db.from("sites").insert({ org_id: orgId, name: SITE_NAME, kind: "yard" });

    const po = (
      await db
        .from("purchase_orders")
        .insert({
          org_id: orgId,
          number: `PO-${TAG}`,
          status: "sent",
          subtotal: 200,
          vat_total: 40,
        })
        .select("id")
        .single()
    ).data;
    poId = po.id as string;

    const line = (
      await db
        .from("purchase_order_line_items")
        .insert({
          org_id: orgId,
          purchase_order_id: poId,
          description: `Dense blocks 100mm ${TAG}`,
          qty: 100,
          unit: "ea",
          unit_price: 2,
          vat_rate: 20,
          line_total: 200,
          sort_order: 0,
        })
        .select("id")
        .single()
    ).data;

    // A POSTED delivery of 40 — the state stock is taken in from. Posted via
    // the real RPC so the note carries the same provenance a yard form gives it.
    const posted = await db.rpc("post_goods_received_note", {
      p_org_id: orgId,
      p_purchase_order_id: poId,
      p_delivery_date: "2026-07-28",
      p_delivery_note_reference: `DN-${TAG}`,
      p_delivery_location: null,
      p_notes: null,
      p_received_by: null,
      p_lines: [{ line_item_id: line.id, qty_received: 40 }],
    });
    if (posted.error) throw new Error(`seed GRN failed: ${posted.error.message}`);

    jobId = (
      await db.from("jobs").insert({ org_id: orgId, status: "in-progress" }).select("id").single()
    ).data.id as string;
  });

  test("a logged-out visitor cannot reach the stock surface", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto("/stock");
    await expect(page).toHaveURL(/\/login/);
  });

  test("delivery → stock → job, on a 375px phone, with the count telling the truth", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    // ── 1. name the item, with a reorder level of 35 ─────────────────────────
    await page.goto("/stock/items/new");
    await hydrated(page);
    await page.getByLabel("What is it?").fill(ITEM_NAME);
    await page.getByLabel("Counted in").fill("ea");
    await page.getByLabel("Reorder level").fill("35");
    await page.getByRole("button", { name: /add item/i }).click();

    await page.waitForURL(/\/stock\/items\/[0-9a-f-]{36}/);
    const itemUrl = page.url();
    await expect(page.getByRole("heading", { name: ITEM_NAME })).toBeVisible();
    // Nothing has moved yet, so it reads as out of stock — the honest answer.
    await expect(page.getByText("Out of stock").first()).toBeVisible();

    // ── 2. take the posted delivery into stock, from the order ───────────────
    await page.goto(`/purchase-orders/${poId}`);
    await page.getByRole("button", { name: /put into stock/i }).click();
    await hydrated(page);
    // The quantity is NOT asked for — it comes from the delivery evidence.
    await expect(page.getByText(/40 ea will be added/)).toBeVisible();
    await page.getByLabel("Stock item").selectOption({ label: `${ITEM_NAME} (ea)` });
    await page.getByLabel("Put it where?").selectOption({ label: SITE_NAME });
    await page.getByRole("button", { name: /add to stock/i }).click();

    await page.waitForURL(new RegExp(`/purchase-orders/${poId}\\?stocked=`));
    await expect(page.getByText(/Added to stock/i)).toBeVisible();
    // …and the line now says where it went instead of offering the form again.
    await expect(page.getByText(new RegExp(`In stock as .*${TAG}`))).toBeVisible();

    // ── 3. the balance went UP, derived from the ledger ──────────────────────
    await page.goto(itemUrl);
    const onHand = page.getByText("On hand").locator("+ p");
    await expect(onHand).toContainText("40");
    // "Where it is" names the yard and links to its own location board. Matched
    // as a LINK, not as text: the site pickers below hold hidden <option>s with
    // the same name, and a text match would pass on one of those.
    await expect(page.getByRole("heading", { name: "Where it is" })).toBeVisible();
    await expect(page.getByRole("link", { name: SITE_NAME })).toBeVisible();

    // ── 4. issue 10 to a job ────────────────────────────────────────────────
    await page.getByRole("tab", { name: /issue out/i }).click();
    await hydrated(page);
    await page.getByLabel("Out of").selectOption({ label: `${SITE_NAME} — 40 ea` });
    await page.getByLabel("How many ea?").fill("10");
    // Live arithmetic before the round trip.
    await expect(page.getByText(new RegExp(`${SITE_NAME} would be left with 30 ea`))).toBeVisible();
    await page.getByRole("button", { name: /issue 10 ea/i }).click();

    await page.waitForURL(/\/stock\/items\/[0-9a-f-]{36}\?saved=issued/);
    await expect(page.getByText("Stock issued.")).toBeVisible();

    // ── 5. the balance went DOWN and crossed the reorder level ──────────────
    await expect(onHand).toContainText("30");
    await expect(page.getByText("Low").first()).toBeVisible();

    // ── 6. the history is intact — BOTH movements, neither editable ─────────
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(page.getByText("Received in")).toBeVisible();
    await expect(page.getByText("Issued out")).toBeVisible();
    await expect(page.getByText("+40")).toBeVisible();
    await expect(page.getByText("\u221210")).toBeVisible();
    await expect(page.getByText(/Nothing here can be edited or deleted/i)).toBeVisible();

    // ── 7. low stock reaches the overview ───────────────────────────────────
    await page.goto("/stock");
    await expect(page.getByRole("heading", { name: "Needs ordering" })).toBeVisible();
    // The item is linked from several panels on this page (needs-ordering and
    // recent movements), so assert the COUNT rather than a strict single match:
    // appearing more than once is correct, appearing never is the regression.
    await expect(page.getByRole("link", { name: ITEM_NAME }).first()).toBeVisible();
    await expect(page.getByText(/30 ea/).first()).toBeVisible();
    // `.first()`: earlier runs of this spec leave their own items in the shared
    // seeded org, and several will legitimately be low. One is enough — the
    // regression is the panel being empty, not it having neighbours.
    await expect(page.getByText(/reorder at 35/).first()).toBeVisible();

    // ── 8. THE ACCOUNTING BOUNDARY, where a user could see it break ─────────
    // Issuing to a job must not have created a cost. The page says so, and the
    // database agrees.
    await expect(
      page.getByText(/Materials are costed once, when you record the supplier/i).first(),
    ).toBeVisible();
    const db = svc() as unknown as { from: (t: string) => any };
    const costs = await db.from("finances").select("id").eq("job_id", jobId);
    expect(costs.data ?? []).toHaveLength(0);
  });

  test("no stock page scrolls sideways at 375px", async ({ page }) => {
    // A page that scrolls horizontally fails the one-handed brief on the first
    // tap, so assert it structurally rather than trusting the classes.
    await page.setViewportSize({ width: 375, height: 812 });
    for (const url of ["/stock", "/stock/items", "/stock/items/new"]) {
      await page.goto(url);
      // Settle BEFORE measuring: these routes stream (Suspense skeletons swap
      // for real rows a beat after `load`) and web fonts arrive later still.
      // scrollWidth read straight after goto() measures the skeleton with
      // fallback glyph metrics — narrower than the settled page — so a genuine
      // overflow (the un-wrapped action row) reads as fitting and the test
      // flake-passes. settleForAxe waits for fonts.ready + every skeleton
      // animation to unmount, so the measurement is of the page a user sees.
      await settleForAxe(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${url} overflows by ${overflow}px at 375px`).toBeLessThanOrEqual(1);
    }
  });
});
