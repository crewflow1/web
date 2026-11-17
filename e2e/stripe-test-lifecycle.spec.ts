/* eslint-disable @typescript-eslint/no-explicit-any -- service-role client, Stripe REST JSON */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { rmSync } from "node:fs";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";
import { mintState, asActor } from "./_actors";
import { STRIPE_E2E_ON, assertStripeTestEnv, stripe, relay, now, waitForEvent, payOnStripeCheckout, declinedShown, ukDate, periodEndOf } from "./_stripe-test";

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
const ON = STRIPE_E2E_ON;
const HQ_STATE = "e2e/.auth/hq.json";
const TAG = `stl${Date.now().toString(36)}`;
const OWNER_EMAIL = `owner-${TAG}@example.test`;
const PASSWORD = `Pw-${crypto.randomUUID()}`;
const OWNER_STATE = `e2e/.auth/${TAG}-owner.json`;

const db = () => createClient(assertLocalE2eTarget("stripe-test-lifecycle.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } }) as any;

test.describe.configure({ mode: "serial" });
test.describe("Stripe TEST MODE · full billing lifecycle (opt-in)", () => {
  test.skip(!ON, "set STRIPE_E2E=1 with a test key and a local webhook secret to run");
  test.beforeAll(() => {
    if (!ON) return;
    assertStripeTestEnv();
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

  test("6. the owner cancels: the dialog shows the exact end date; Stripe sets cancel_at_period_end; the company STAYS ACTIVE", async ({ browser }) => {
    test.setTimeout(120_000);
    const before = await stripe("GET", `subscriptions/${firstSub}`);
    const end = periodEndOf(before);
    t0 = now();
    await asActor(browser, OWNER_STATE, async (page) => {
      await page.goto("/settings/billing");
      await expect(page.getByText(`on ${ukDate(end)}`).first()).toBeVisible();
      const trigger = page.getByRole("button", { name: "Cancel subscription", exact: true });
      await waitForHydrated(trigger);
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByTestId("access-end-date")).toHaveText(ukDate(end));
      await dialog.getByLabel(/Why are you cancelling/).fill("stripe test-mode lifecycle");
      await dialog.getByRole("button", { name: `Cancel at end of period (${ukDate(end)})` }).click();
      await page.waitForURL(/\/settings\/billing\?cancellation_scheduled=1/, { timeout: 60_000 });
      await expect(page.getByTestId("cancellation-scheduled")).toContainText(`ends on ${ukDate(end)}`);
    });
    const after = await stripe("GET", `subscriptions/${firstSub}`);
    expect(after.status, "still live until the period end").toBe("active");
    expect(after.cancel_at_period_end, "Stripe will not renew").toBe(true);
    expect(periodEndOf(after)).toBe(end);
    expect((await org()).status, "full access until the period end").toBe("active");
    await waitForEvent(t0, "customer.subscription.updated");
    const delivered = await relay(t0, { repeat: 2 });
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    expect((await org()).status, "the schedule webhook keeps the company active").toBe("active");
  });

  test("6b. the owner undoes the scheduled cancellation before expiry; Stripe renews as normal", async ({ browser }) => {
    test.setTimeout(120_000);
    t0 = now();
    await asActor(browser, OWNER_STATE, async (page) => {
      await page.goto("/settings/billing");
      const keep = page.getByRole("button", { name: /Keep my subscription/ });
      await waitForHydrated(keep);
      await keep.click();
      await page.waitForURL(/\/settings\/billing\?resumed=1/, { timeout: 60_000 });
      await expect(page.getByText("Your subscription will continue.")).toBeVisible();
    });
    const sub = await stripe("GET", `subscriptions/${firstSub}`);
    expect(sub.cancel_at_period_end).toBe(false);
    expect(sub.status).toBe("active");
    const delivered = await relay(t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    expect((await org()).status).toBe("active");
  });

  test("6c. scheduled again, then the period ends (Stripe deletes the subscription): D-17 cancelled — owner read-only, data kept", async ({ browser }) => {
    test.setTimeout(150_000);
    t0 = now();
    await asActor(browser, OWNER_STATE, async (page) => {
      await page.goto("/settings/billing");
      const trigger = page.getByRole("button", { name: "Cancel subscription", exact: true });
      await waitForHydrated(trigger);
      await trigger.click();
      await page.getByRole("dialog").getByRole("button", { name: /Cancel at end of period/ }).click();
      await page.waitForURL(/cancellation_scheduled=1/, { timeout: 60_000 });
    });
    expect((await stripe("GET", `subscriptions/${firstSub}`)).cancel_at_period_end).toBe(true);
    // What Stripe does at the period end. (The real renewal boundary is exercised with a test
    // clock in test 9.)
    await stripe("DELETE", `subscriptions/${firstSub}`);
    await waitForEvent(t0, "customer.subscription.deleted");
    const delivered = await relay(t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    const o = await org();
    expect(o.status).toBe("cancelled");
    await asActor(browser, OWNER_STATE, async (page) => {
      await page.goto("/account/billing");
      await expect(page.getByRole("link", { name: "Download data export" })).toBeVisible();
    });
    const kept = await db().from("organizations").select("id").eq("id", orgId);
    expect(kept.data, "cancellation never deletes the company").toHaveLength(1);
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

  test("9. RENEWAL BOUNDARY (Stripe test clock): a dialog shown before a renewal cannot commit the old date; after scheduling, the period ends with NO renewal and the company becomes cancelled", async ({ browser }) => {
    test.setTimeout(420_000);
    const clockStart = Math.floor(Date.now() / 1000);
    const clock = await stripe("POST", "test_helpers/test_clocks", { frozen_time: String(clockStart), name: `crewflow-${TAG}` });
    const advance = async (to: number) => {
      await stripe("POST", `test_helpers/test_clocks/${clock.id}/advance`, { frozen_time: String(to) });
      await expect.poll(async () => (await stripe("GET", `test_helpers/test_clocks/${clock.id}`)).status, { timeout: 180_000, intervals: [2000] }).toBe("ready");
    };
    const price = (await stripe("GET", `subscriptions/${(await org()).stripe_subscription_id}`)).items.data[0].price.id;
    const email2 = `owner2-${TAG}@example.test`;
    const state2 = `e2e/.auth/${TAG}-owner2.json`;
    const pw2 = `Pw-${crypto.randomUUID()}`;
    let org2 = "", owner2 = "";
    try {
      const cus = await stripe("POST", "customers", { email: email2, test_clock: clock.id, payment_method: "pm_card_visa", "invoice_settings[default_payment_method]": "pm_card_visa" });
      const o2 = await db().from("organizations").insert({ name: `Stripe Clock Co ${TAG}`, slug: `${TAG}-clock`, status: "active", setup_fee_status: "paid", billing_email: email2, stripe_customer_id: cus.id, onboarding_state: { completed_at: new Date().toISOString() } }).select("id").single();
      if (o2.error) throw new Error(o2.error.message);
      org2 = o2.data.id;
      const sub = await stripe("POST", "subscriptions", { customer: cus.id, "items[0][price]": price, "metadata[org_id]": org2, "metadata[kind]": "subscription" });
      expect(sub.status).toBe("active");
      await db().from("organizations").update({ stripe_subscription_id: sub.id }).eq("id", org2);
      const u = await db().auth.admin.createUser({ email: email2, password: pw2, email_confirm: true });
      owner2 = u.data.user!.id;
      await db().from("users").upsert({ id: owner2, email: email2, full_name: "Clock Owner" });
      await db().from("memberships").insert({ org_id: org2, user_id: owner2, role: "owner" });
      await mintState(email2, pw2, state2);
      const d1 = periodEndOf(sub);

      // The owner opens the dialog showing D1 ... then the subscription renews before they click.
      await asActor(browser, state2, async (page) => {
        await page.goto("/settings/billing");
        const trigger = page.getByRole("button", { name: "Cancel subscription", exact: true });
        await waitForHydrated(trigger);
        await trigger.click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByTestId("access-end-date")).toHaveText(ukDate(d1));
        await advance(d1 + 3600);
        const renewed = await stripe("GET", `subscriptions/${sub.id}`);
        const d2 = periodEndOf(renewed);
        expect(d2, "the subscription renewed into a new period").toBeGreaterThan(d1);
        await dialog.getByRole("button", { name: /Cancel at end of period/ }).click();
        await expect(dialog.getByRole("alert")).toContainText("Your subscription has just renewed");
        expect((await stripe("GET", `subscriptions/${sub.id}`)).cancel_at_period_end, "nothing changed").toBe(false);

        // Reload: the dialog now shows D2; confirming schedules exactly D2.
        await page.goto("/settings/billing");
        const again = page.getByRole("button", { name: "Cancel subscription", exact: true });
        await waitForHydrated(again);
        await again.click();
        await expect(page.getByRole("dialog").getByTestId("access-end-date")).toHaveText(ukDate(d2));
        await page.getByRole("dialog").getByRole("button", { name: `Cancel at end of period (${ukDate(d2)})` }).click();
        await page.waitForURL(/cancellation_scheduled=1/, { timeout: 60_000 });
      });
      const scheduled = await stripe("GET", `subscriptions/${sub.id}`);
      expect(scheduled.cancel_at_period_end).toBe(true);
      const d2 = periodEndOf(scheduled);
      expect((await db().from("organizations").select("status").eq("id", org2).single()).data.status).toBe("active");

      // Past D2: Stripe ends the subscription and does NOT renew it.
      await advance(d2 + 2 * 86400);
      const ended = await stripe("GET", `subscriptions/${sub.id}`);
      expect(ended.status).toBe("canceled");
      const invoices = await stripe("GET", `invoices?subscription=${sub.id}&limit=20`);
      expect(invoices.data.filter((i: any) => i.status === "paid").length, "first payment + one renewal, no renewal after the cancellation").toBe(2);
      expect(invoices.data.filter((i: any) => (i.period_start ?? 0) >= d2), "no invoice for a period after the access end").toEqual([]);

      const delivered = await relay(clockStart - 5);
      expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
      expect((await db().from("organizations").select("status").eq("id", org2).single()).data.status).toBe("cancelled");
    } finally {
      rmSync(state2, { force: true });
      await stripe("DELETE", `test_helpers/test_clocks/${clock.id}`).catch(() => {});
      if (org2) await db().from("organizations").delete().eq("id", org2);
      if (owner2) { await db().from("users").delete().eq("id", owner2); await db().auth.admin.deleteUser(owner2); }
    }
  });
});

