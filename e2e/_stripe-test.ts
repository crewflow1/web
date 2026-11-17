/* eslint-disable @typescript-eslint/no-explicit-any -- Stripe REST JSON */
import { expect, type Frame, type Locator, type Page } from "@playwright/test";
import crypto from "node:crypto";

/**
 * Shared helpers for the opt-in STRIPE TEST-MODE browser specs (stripe-test-lifecycle,
 * first-customer-rehearsal). Local only: they run when STRIPE_E2E=1 with a TEST key
 * (sk_test_/rk_test_) and a LOCAL webhook signing secret in the shell that runs Playwright.
 *
 * Webhook DELIVERY is the one bridged hop: the restricted test key cannot open a Stripe CLI
 * session, so the genuine Stripe events are fetched from the Stripe API and delivered to
 * /api/webhooks/stripe signed with the local secret in Stripe's v1 scheme — the same bytes,
 * headers and verification path Stripe's own delivery uses.
 */
export const STRIPE_E2E_ON = process.env.STRIPE_E2E === "1";
const key = () => process.env.STRIPE_SECRET_KEY ?? "";
const whsec = () => process.env.STRIPE_WEBHOOK_SECRET ?? "";

/** Throws unless the key is a TEST key and a local webhook secret is set. */
export function assertStripeTestEnv(): void {
  if (!/^(sk|rk)_test_/.test(key())) throw new Error("refusing to run: STRIPE_SECRET_KEY is not a TEST key");
  if (!whsec().startsWith("whsec_")) throw new Error("STRIPE_WEBHOOK_SECRET (local) missing");
}

const auth = () => ({ Authorization: "Basic " + Buffer.from(key() + ":").toString("base64") });
export async function stripe(method: string, path: string, form?: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers: { ...auth(), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path.split("?")[0]} → ${res.status}: ${(body?.error?.message ?? "").slice(0, 160)}`);
  return body;
}

/** Sign a payload in Stripe's v1 scheme with the local secret and POST it to the local webhook. */
export async function deliver(payload: string) {
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", whsec()).update(`${t}.${payload}`).digest("hex");
  return fetch("http://localhost:3000/api/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` }, body: payload });
}

/** Deliver every real Stripe event created since `since` to the local webhook (signed locally). */
export async function relay(since: number, opts: { repeat?: number; reverse?: boolean } = {}) {
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
    const r = await deliver(JSON.stringify(e));
    out.push({ id: e.id, type: e.type, status: r.status, body: (await r.text()).slice(0, 200) });
  }
  return out;
}
export const now = () => Math.floor(Date.now() / 1000) - 5;
/** Stripe's events list is eventually consistent: wait until an expected event is listed. */
export async function waitForEvent(since: number, type: string, status?: string) {
  await expect.poll(async () => {
    const d = await stripe("GET", `events?limit=100&created[gte]=${since}&type=${encodeURIComponent(type)}`);
    return d.data.some((e: any) => !status || e.data?.object?.status === status);
  }, { timeout: 60_000, message: `Stripe event ${type}${status ? ` (${status})` : ""} listed` }).toBe(true);
}

/** Find the frame (page or iframe) that contains `probe`. Stripe Checkout renders its payment
 *  form inside an iframe in the current version. */
async function frameWith(page: Page, probe: (f: Frame) => Locator, timeoutMs = 30_000) {
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
async function fillFirstVisible(f: Frame, selectors: string[], value: string) {
  for (const sel of selectors) {
    const loc = f.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) { await loc.fill(value); return true; }
  }
  return false;
}

export async function payOnStripeCheckout(page: Page, card: string, expectSuccess = true) {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
  // Wait for the payment form (it lives inside an iframe). A customer who already paid once may
  // be shown their SAVED card instead of empty card fields — then there is nothing to fill.
  const cardInput = (fr: Frame) => fr.locator('input[name="cardNumber"], input[autocomplete="cc-number"], input[placeholder="1234 1234 1234 1234"]');
  const cardButton = (fr: Frame) => fr.getByRole("button", { name: "Card", exact: true });
  const submitBtn = (fr: Frame) => fr.locator('[data-testid="hosted-payment-submit-button"]');
  await frameWith(page, (fr) => cardInput(fr).or(cardButton(fr)).or(submitBtn(fr)));
  for (const fr of page.frames()) {
    if (await cardButton(fr).isVisible().catch(() => false)) { await cardButton(fr).click(); break; }
  }
  let f: Frame | null = null;
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
  const submit = (fr: Frame) => fr.locator('[data-testid="hosted-payment-submit-button"]').or(fr.getByRole("button", { name: /^(Pay|Subscribe|Start trial)\b(?!\s+(with|securely))/ }));
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
export async function declinedShown(page: Page) {
  // still on Stripe's page, not redirected to success
  await expect(page).toHaveURL(/checkout\.stripe\.com/);
}

export const ukDate = (unix: number) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" }).format(new Date(unix * 1000));
export const periodEndOf = (sub: any): number => sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
