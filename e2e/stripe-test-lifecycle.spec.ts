/* eslint-disable @typescript-eslint/no-explicit-any -- service-role client, Stripe REST JSON */
import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { rmSync } from "node:fs";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";
import { mintState, asActor } from "./_actors";

/**
 * FULL BILLING LIFECYCLE AGAINST STRIPE TEST MODE (opt-in; local only).
 *
 * Runs only when STRIPE_E2E=1 with a TEST key (sk_test_/rk_test_) and a LOCAL webhook signing
 * secret in the environment of the shell that runs Playwright (the webServer inherits them).
 * CI never sets these, so CI skips this file. Synthetic company, Stripe's published test cards.
 *
 * Everything is real except webhook DELIVERY: the restricted test key cannot open a Stripe CLI
 * session, so the genuine Stripe events are fetched from the Stripe API after each step and
 * delivered to /api/webhooks/stripe signed with the local secret in Stripe's v1 scheme — the
 * same bytes, headers and verification path Stripe's own delivery uses.
 */
const ON = process.env.STRIPE_E2E === "1";
const KEY = process.env.STRIPE_SECRET_KEY ?? "";
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const HQ_STATE = "e2e/.auth/hq.json";
const TAG = `stl${Date.now().toString(36)}`;
const OWNER_EMAIL = `owner-${TAG}@example.test`;
const PASSWORD = `Pw-${crypto.randomUUID()}`;
const OWNER_STATE = `e2e/.auth/${TAG}-owner.json`;

const db = () => createClient(assertLocalE2eTarget("stripe-test-lifecycle.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } }) as any;
const auth = () => ({ Authorization: "Basic " + Buffer.from(KEY + ":").toString("base64") });
async function stripe(method: string, path: string, form?: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers: { ...auth(), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path.split("?")[0]} → ${res.status}: ${(body?.error?.message ?? "").slice(0, 160)}`);
  return body;
}
/** Deliver every real Stripe event created since `since` to the local webhook (signed locally). */
async function relay(since: number, opts: { repeat?: number; reverse?: boolean } = {}) {
  const events: any[] = []; let after: string | null = null;
  for (;;) {
    const q = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    if (after) q.set("starting_after", after);
    const d = await stripe("GET", `events?${q}`);
    events.push(...d.data);
    if (!d.has_more) break;
    after = d.data[d.data.length - 1].id;
  }
  events.sort((a, b) => a.created - b.created);
  if (opts.reverse) events.reverse();
  const out: Array<{ id: string; type: string; status: number; body: string }> = [];
  for (const e of events) for (let i = 0; i < (opts.repeat ?? 1); i++) {
    const payload = JSON.stringify(e);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex");
    const r = await fetch("http://localhost:3000/api/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` }, body: payload });
    out.push({ id: e.id, type: e.type, status: r.status, body: (await r.text()).slice(0, 200) });
  }
  return out;
}
const now = () => Math.floor(Date.now() / 1000) - 5;
/** Stripe's events list is eventually consistent: wait until an expected event is listed. */
async function waitForEvent(since: number, type: string, status?: string) {
  await expect.poll(async () => {
    const d = await stripe("GET", `events?limit=100&created[gte]=${since}&type=${encodeURIComponent(type)}`);
    return d.data.some((e: any) => !status || e.data?.object?.status === status);
  }, { timeout: 60_000, message: `Stripe event ${type}${status ? ` (${status})` : ""} listed` }).toBe(true);
}

/** Find the frame (page or iframe) that contains `probe`. Stripe Checkout renders its payment
 *  form inside an iframe in the current version. */
async function frameWith(page: Page, probe: (f: import("@playwright/test").Frame) => import("@playwright/test").Locator, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const f of page.frames()) {
      if (await probe(f).first().isVisible().catch(() => false)) return f;
    }
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: `test-results/stripe-checkout-debug-${Date.now()}.png`, fullPage: true }).catch(() => {});
  for (const f of page.frames()) {
    const snap = await f.locator("body").ariaSnapshot({ timeout: 2_000 }).catch(() => "");
    if (snap.trim()) console.log(`[checkout-debug] frame ${f.url().slice(0, 70)}\n${snap.replace(/- option "[^"]*"\n\s*/g, "").slice(-1200)}`);
  }
  throw new Error("Stripe Checkout: expected control not found in any frame");
}
async function fillFirstVisible(f: import("@playwright/test").Frame, selectors: string[], value: string) {
  for (const sel of selectors) {
    const loc = f.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) { await loc.fill(value); return true; }
  }
  return false;
}

async function payOnStripeCheckout(page: Page, card: string, expectSuccess = true) {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
  // Wait for the payment form (it lives inside an iframe). A customer who already paid once may
  // be shown their SAVED card instead of empty card fields — then there is nothing to fill.
  const cardInput = (fr: import("@playwright/test").Frame) => fr.locator('input[name="cardNumber"], input[autocomplete="cc-number"], input[placeholder="1234 1234 1234 1234"]');
  const cardButton = (fr: import("@playwright/test").Frame) => fr.getByRole("button", { name: "Card", exact: true });
  const submitBtn = (fr: import("@playwright/test").Frame) => fr.locator('[data-testid="hosted-payment-submit-button"]');
  await frameWith(page, (fr) => cardInput(fr).or(cardButton(fr)).or(submitBtn(fr)));
  for (const fr of page.frames()) {
    if (await cardButton(fr).isVisible().catch(() => false)) { await cardButton(fr).click(); break; }
  }
  let f: import("@playwright/test").Frame | null = null;
  for (let i = 0; i < 20 && !f; i++) {
    for (const fr of page.frames()) if (await cardInput(fr).first().isVisible().catch(() => false)) { f = fr; break; }
    if (!f) await page.waitForTimeout(250);
  }
  if (f) {
    await fillFirstVisible(f, ['input[name="cardNumber"]', 'input[autocomplete="cc-number"]', 'input[placeholder="1234 1234 1234 1234"]'], card);
    await fillFirstVisible(f, ['input[name="cardExpiry"]', 'input[autocomplete="cc-exp"]', 'input[placeholder="MM / YY"]'], "12 / 34");
    await fillFirstVisible(f, ['input[name="cardCvc"]', 'input[autocomplete="cc-csc"]', 'input[placeholder="CVC"]'], "123");
    await fillFirstVisible(f, ['input[name="billingName"]', 'input[autocomplete="cc-name"]', 'input[autocomplete="name"]'], "Stripe Test Buyer");
  } else if (card !== "4242 4242 4242 4242") {
    throw new Error("Stripe Checkout showed a saved card; cannot enter a different test card");
  }
  for (const fr of page.frames()) {
    const country = fr.locator('select[name="billingCountry"], select[autocomplete="billing country"], select[autocomplete="country"]').first();
    if (await country.isVisible().catch(() => false)) { await country.selectOption("GB").catch(() => {}); }
  }
  for (const fr of page.frames()) {
    if (await fillFirstVisible(fr, ['input[name="billingPostalCode"]', 'input[autocomplete="billing postal-code"]', 'input[autocomplete="postal-code"]'], "BT1 1AA")) break;
  }
  // The submit button only — NOT "Pay with Klarna" / "Pay securely with Onelink" (wallet buttons).
  const submit = (fr: import("@playwright/test").Frame) => fr.locator('[data-testid="hosted-payment-submit-button"]').or(fr.getByRole("button", { name: /^(Pay|Subscribe|Start trial)\b(?!\s+(with|securely))/ }));
  const pay = await frameWith(page, submit);
  await submit(pay).first().click();
  if (!expectSuccess) {
    // A decline is confirmed through the Stripe API (the on-screen wording varies): the session's
    // PaymentIntent carries the decline as its last payment error, and no redirect happened.
    const cs = /\/(cs_test_[A-Za-z0-9]+)/.exec(page.url())?.[1];
    if (!cs) throw new Error("could not read the Checkout Session id from the page URL");
    await expect.poll(async () => {
      const sess = await stripe("GET", `checkout/sessions/${cs}?expand[]=payment_intent`);
      return sess.payment_intent?.last_payment_error?.code ?? null;
    }, { timeout: 45_000 }).toBe("card_declined");
  }
  if (expectSuccess) await page.waitForURL(/localhost:3000\/admin\/customers\/.*stripe=success/, { timeout: 60_000 });
}
async function declinedShown(page: Page) {
  // still on Stripe's page, not redirected to success
  await expect(page).toHaveURL(/checkout\.stripe\.com/);
}

test.describe.configure({ mode: "serial" });
test.describe("Stripe TEST MODE · full billing lifecycle (opt-in)", () => {
  test.skip(!ON, "set STRIPE_E2E=1 with a test key and a local webhook secret to run");
  test.beforeAll(() => {
    if (!ON) return;
    if (!/^(sk|rk)_test_/.test(KEY)) throw new Error("refusing to run: STRIPE_SECRET_KEY is not a TEST key");
    if (!WHSEC.startsWith("whsec_")) throw new Error("STRIPE_WEBHOOK_SECRET (local) missing");
  });

  let orgId = "", ownerId = "", customer = "", firstSub = "", t0 = 0;
  const org = async () => (await db().from("organizations").select("status, setup_fee_status, stripe_customer_id, stripe_subscription_id, cancelled_at").eq("id", orgId).single()).data;

  test.beforeAll(async () => {
    if (!ON) return;
    const o = await db().from("organizations").insert({ name: `Stripe TEST Co ${TAG}`, slug: TAG, status: "trial", setup_fee_status: "pending", billing_email: OWNER_EMAIL, onboarding_state: { completed_at: new Date().toISOString() } }).select("id").single();
    if (o.error) throw new Error(o.error.message);
    orgId = o.data.id;
    const u = await db().auth.admin.createUser({ email: OWNER_EMAIL, password: PASSWORD, email_confirm: true });
    ownerId = u.data.user!.id;
    await db().from("users").upsert({ id: ownerId, email: OWNER_EMAIL, full_name: "Stripe Test Owner" });
    await db().from("memberships").insert({ org_id: orgId, user_id: ownerId, role: "owner" });
    await mintState(OWNER_EMAIL, PASSWORD, OWNER_STATE);
  });
  test.afterAll(async () => {
    if (!ON) return;
    rmSync(OWNER_STATE, { force: true });
    const o = orgId ? await org() : null;
    if (o?.stripe_subscription_id) await stripe("DELETE", `subscriptions/${o.stripe_subscription_id}`).catch(() => {});
    if (o?.stripe_customer_id) await stripe("DELETE", `customers/${o.stripe_customer_id}`).catch(() => {});
    if (orgId) await db().from("organizations").delete().eq("id", orgId);
    if (ownerId) { await db().from("users").delete().eq("id", ownerId); await db().auth.admin.deleteUser(ownerId); }
  });

  test("1. HQ cannot open the subscription checkout before the setup fee (policy: fee first)", async ({ browser }) => {
    await asActor(browser, HQ_STATE, async (page) => {
      await page.goto(`/admin/customers/${orgId}`);
      const btn = page.getByRole("button", { name: "Open subscription checkout (£500/mo)" });
      await waitForHydrated(btn);
      await btn.click();
      await expect(page).toHaveURL(/error=setup_fee_outstanding/);
      expect((await org()).status).toBe("trial");
    });
  });

  test("2. £1,000 setup fee: a declined card is refused by Stripe, then a good card pays; the company is NOT active yet", async ({ browser }) => {
    test.setTimeout(180_000);
    t0 = now();
    await asActor(browser, HQ_STATE, async (page) => {
      await page.goto(`/admin/customers/${orgId}`);
      const btn = page.getByRole("button", { name: "Open setup-fee checkout (£1,000)" });
      await waitForHydrated(btn);
      await btn.click();
      await payOnStripeCheckout(page, "4000 0000 0000 0002", false); // generic decline
      await declinedShown(page);
      await payOnStripeCheckout(page, "4242 4242 4242 4242");
    });
    await waitForEvent(t0, "checkout.session.completed");
    const delivered = await relay(t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    const o = await org();
    expect(o).toMatchObject({ setup_fee_status: "paid", status: "trial" });
    customer = o.stripe_customer_id;
    expect(customer).toMatch(/^cus_/);
    const sessions = await stripe("GET", `checkout/sessions?customer=${customer}&limit=10`);
    const paid = sessions.data.filter((s: any) => s.metadata?.kind === "setup_fee" && s.payment_status === "paid");
    expect(paid, "exactly one paid setup-fee session").toHaveLength(1);
    expect(paid[0].amount_total).toBe(100_000);
    expect(paid[0].currency).toBe("gbp");
  });

  test("3. £500/month subscription pays; the company becomes active only now (both payments succeeded)", async ({ browser }) => {
    test.setTimeout(180_000);
    t0 = now();
    await asActor(browser, HQ_STATE, async (page) => {
      await page.goto(`/admin/customers/${orgId}`);
      const btn = page.getByRole("button", { name: "Open subscription checkout (£500/mo)" });
      await waitForHydrated(btn);
      await btn.click();
      await payOnStripeCheckout(page, "4242 4242 4242 4242");
    });
    await waitForEvent(t0, "checkout.session.completed");
    await waitForEvent(t0, "customer.subscription.updated", "active");
    const delivered = await relay(t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    const o = await org();
    expect(o.status).toBe("active");
    firstSub = o.stripe_subscription_id;
    const sub = await stripe("GET", `subscriptions/${firstSub}`);
    expect(sub.status).toBe("active");
    expect(sub.items.data[0].price.unit_amount).toBe(50_000);
    expect(sub.items.data[0].price.recurring.interval).toBe("month");
  });

  test("4. duplicate, reordered and forged webhooks change nothing", async () => {
    const before = await org();
    const dup = await relay(t0, { repeat: 2, reverse: true });
    expect(dup.every((d) => d.status === 200), JSON.stringify(dup)).toBe(true);
    expect(await org()).toEqual(before);
    const forged = await fetch("http://localhost:3000/api/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` }, body: JSON.stringify({ id: "evt_forged", type: "customer.subscription.deleted", data: { object: { id: firstSub, customer, status: "canceled" } } }) });
    expect(forged.status, "a forged signature is refused").toBe(401);
    expect((await org()).status).toBe("active");
    // every Stripe event delivered in this run is stored once and marked processed
    const ids = [...new Set(dup.map((d) => d.id))];
    const rows = await db().from("billing_events").select("event_id, processed_at, error_message").in("event_id", ids);
    expect((rows.data ?? []).length, "one row per Stripe event, however often it was delivered").toBe(ids.length);
    expect((rows.data ?? []).filter((r: any) => !r.processed_at || r.error_message), "every delivered event processed").toEqual([]);
  });

  test("5. a failed renewal-style payment suspends the company; paying with a good card recovers it", async () => {
    test.setTimeout(180_000);
    t0 = now();
    // a card that attaches but fails when charged becomes the default, and the billing cycle is
    // restarted now — Stripe raises the next monthly invoice immediately (a renewal) and fails it
    const bad = await stripe("POST", "payment_methods/pm_card_chargeCustomerFail/attach", { customer });
    await stripe("POST", `customers/${customer}`, { "invoice_settings[default_payment_method]": bad.id });
    await stripe("POST", `subscriptions/${firstSub}`, { default_payment_method: bad.id, billing_cycle_anchor: "now", proration_behavior: "none" }).catch((e) => { if (!/card|declin|payment/i.test(String(e))) throw e; });
    await expect.poll(async () => (await stripe("GET", `subscriptions/${firstSub}`)).status, { timeout: 60_000 }).toBe("past_due");
    await waitForEvent(t0, "customer.subscription.updated", "past_due");
    await waitForEvent(t0, "invoice.payment_failed");
    let delivered = await relay(t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    expect((await org()).status, "failed payment → suspended (read-only)").toBe("suspended");

    t0 = now();
    const good = await stripe("POST", "payment_methods/pm_card_visa/attach", { customer });
    await stripe("POST", `customers/${customer}`, { "invoice_settings[default_payment_method]": good.id });
    await stripe("POST", `subscriptions/${firstSub}`, { default_payment_method: good.id });
    const open = await stripe("GET", `invoices?subscription=${firstSub}&status=open&limit=5`);
    for (const inv of open.data) await stripe("POST", `invoices/${inv.id}/pay`, { payment_method: good.id });
    await expect.poll(async () => (await stripe("GET", `subscriptions/${firstSub}`)).status, { timeout: 60_000 }).toBe("active");
    await waitForEvent(t0, "customer.subscription.updated", "active");
    await waitForEvent(t0, "invoice.paid");
    delivered = await relay(t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    expect((await org()).status, "payment recovered → active again").toBe("active");
  });

  test("6. the owner cancels in the app: Stripe stops billing and the company becomes read-only (PR #1090)", async ({ browser }) => {
    test.setTimeout(120_000);
    t0 = now();
    await asActor(browser, OWNER_STATE, async (page) => {
      await page.goto("/settings/billing");
      const trigger = page.getByRole("button", { name: "Cancel subscription", exact: true });
      await waitForHydrated(trigger);
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel(/Why are you cancelling/).fill("stripe test-mode lifecycle");
      await dialog.getByRole("button", { name: "Cancel subscription now" }).click();
      await page.waitForURL(/\/account\/billing\?cancelled=1/, { timeout: 60_000 });
    });
    expect((await stripe("GET", `subscriptions/${firstSub}`)).status, "Stripe really cancelled it").toBe("canceled");
    expect((await org()).status).toBe("cancelled");
    await waitForEvent(t0, "customer.subscription.deleted");
    const delivered = await relay(t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    expect((await org()).status, "the webhook echo is a no-op").toBe("cancelled");
  });

  test("7. reactivation: the owner asks, HQ takes a NEW subscription (no second setup fee), the company is active again", async ({ browser }) => {
    test.setTimeout(180_000);
    await asActor(browser, OWNER_STATE, async (page) => {
      await page.goto("/account/billing");
      const ask = page.getByRole("button", { name: "Ask to reactivate" });
      await waitForHydrated(ask);
      await ask.click();
      await expect(page.getByText("We've got your request.")).toBeVisible();
    });
    t0 = now();
    await asActor(browser, HQ_STATE, async (page) => {
      await page.goto(`/admin/customers/${orgId}`);
      const btn = page.getByRole("button", { name: "Open subscription checkout (£500/mo)" });
      await waitForHydrated(btn);
      await btn.click();
      await payOnStripeCheckout(page, "4242 4242 4242 4242");
    });
    await waitForEvent(t0, "checkout.session.completed");
    await waitForEvent(t0, "customer.subscription.updated", "active");
    const delivered = await relay(t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    const o = await org();
    expect(o.status).toBe("active");
    expect(o.cancelled_at).toBeNull();
    expect(o.stripe_subscription_id).not.toBe(firstSub);
    // the OLD (cancelled) subscription's events replayed late cannot undo the reactivation
    await relay(t0 - 3600);
    expect((await org()).status).toBe("active");
    const fees = await stripe("GET", `checkout/sessions?customer=${customer}&limit=20`);
    expect(fees.data.filter((s: any) => s.metadata?.kind === "setup_fee" && s.payment_status === "paid"), "the setup fee was charged exactly once").toHaveLength(1);
  });

  test("8. database and Stripe agree", async () => {
    const o = await org();
    const sub = await stripe("GET", `subscriptions/${o.stripe_subscription_id}`);
    expect(sub.status).toBe("active");
    expect(sub.customer).toBe(o.stripe_customer_id);
    const ledger = await db().from("subscription_cancellations").select("stripe_subscription_id, state").eq("org_id", orgId);
    expect(ledger.data).toEqual([{ stripe_subscription_id: firstSub, state: "confirmed" }]);
    const failed = await db().from("billing_events").select("event_id").not("error_message", "is", null).is("processed_at", null).eq("org_id", orgId);
    expect(failed.data ?? []).toEqual([]);
  });
});
