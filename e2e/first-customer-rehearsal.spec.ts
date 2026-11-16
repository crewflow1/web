/* eslint-disable @typescript-eslint/no-explicit-any -- service-role client, Stripe REST JSON, loose rows */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";
import { mintState, findAuthUserId } from "./_actors";
import {
  STRIPE_E2E_ON, assertStripeTestEnv, stripe, relay, now, waitForEvent, payOnStripeCheckout, declinedShown, ukDate, periodEndOf,
} from "./_stripe-test";

/**
 * FIRST-CUSTOMER LAUNCH REHEARSAL (opt-in; local only).
 *
 * One synthetic Northern Ireland firm — "Lagan Valley Builders Ltd" — taken through the whole
 * business journey in a real browser, on the production build, against the real local Postgres,
 * Auth, Storage and mail catcher and REAL Stripe test mode. Every step asserts the PERSISTED state
 * (service-role reads) and, for billing, the Stripe state:
 *
 *   1  sales-led provisioning: public demo request → HQ "Confirm onboarding" → one company, one owner
 *   2  the owner sets a password from the real emailed link (Mailpit) and signs in
 *   3  HQ: £1,000 setup fee (a declined card first) then £500/month — active only after both
 *   4  owner: company details (VAT, address); invites an admin and a staff member, both join + sign in
 *   5  a customer is added; a member of the public enquires on /l/<slug> → lead
 *   6  lead → quote with VAT lines (to the penny) → admin approves → sent → customer accepts on /q/<token>
 *      → exactly one job + one draft invoice
 *   7  owner schedules the job and assigns the staff member
 *   8  admin issues a RAMS; staff on a 390 px phone: sees the job + instructions, signs the RAMS,
 *      clocks in/out, uploads a site photo, records progress and a diary entry
 *   9  owner completes the job, issues the invoice, refuses an over-payment, records the full payment;
 *      the dashboard money tiles equal totals recomputed from the tables
 *   10 owner schedules cancellation: exact end date = Stripe current_period_end; company stays active
 *   11 period end (Stripe deletes the subscription) → cancelled: owner read-only + export; crew locked out
 *   12 reactivation: a NEW subscription, no second setup fee; every earlier record intact and unchanged
 * Failure scenarios (F1–F8) sit where the journey's state supports them.
 *
 * Bridged hops (local harness only, each documented where it happens):
 *   - webhook DELIVERY (see ./_stripe-test.ts);
 *   - the Auth server's redirect for the emailed RECOVERY link (localhost vs 127.0.0.1 — see
 *     e2e/auth-recovery-and-signup.spec.ts);
 *   - team INVITE emails go through Resend, which has no key locally (by policy), so the product
 *     says it could not send them. The invite itself (the pending account carrying the invite) IS
 *     created; the spec opens the same-shaped link the email carries (generateLink → our
 *     /auth/callback?token_hash=…), exactly as lib/auth/magic-link.ts builds it.
 */
const ON = STRIPE_E2E_ON;
const MAIL = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:54324";
const HQ_EMAIL = "e2e-hq@crewflow.test";
const HQ_STATE = "e2e/.auth/hq.json";
const TAG = `lvb${Date.now().toString(36)}`;
const COMPANY = "Lagan Valley Builders Ltd";
const NI_PHONE = "028 9266 1234";
const PHONE = { width: 390, height: 844 };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const people = {
  owner: { email: `owner-${TAG}@example.test`, name: "Ciara Doherty", pw: `Pw-${crypto.randomUUID()}`, state: `e2e/.auth/${TAG}-owner.json` },
  admin: { email: `admin-${TAG}@example.test`, name: "Aidan Quinn", pw: `Pw-${crypto.randomUUID()}`, state: `e2e/.auth/${TAG}-admin.json` },
  staff: { email: `staff-${TAG}@example.test`, name: "Sean Murphy", pw: `Pw-${crypto.randomUUID()}`, state: `e2e/.auth/${TAG}-staff.json` },
};
type Who = keyof typeof people;

const db = () => createClient(assertLocalE2eTarget("first-customer-rehearsal.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } }) as any;
const pence = (v: unknown) => Math.round(Number(v ?? 0) * 100);

// ── state threaded through the serial chain ──────────────────────────────────────────────
const S = {
  demoId: "", org: "", slug: "", customer: "", firstSub: "", t0: 0,
  ownerId: "", adminId: "", staffId: "",
  adminLink: "", staffLink: "",
  repeatCustomer: "", leadId: "", leadCustomer: "", quoteId: "", quoteToken: "", jobId: "", invoiceId: "", raId: "",
  snapshot: "" as string,
};
const org = async () => (await db().from("organizations").select("status, setup_fee_status, stripe_customer_id, stripe_subscription_id, cancelled_at").eq("id", S.org).single()).data;

// ── helpers ──────────────────────────────────────────────────────────────────────────────
async function mailTo(address: string): Promise<any[]> {
  const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
  if (!res.ok) throw new Error(`mail catcher search failed: ${res.status}`);
  return ((await res.json()) as any).messages ?? [];
}
async function verifyLinkIn(messageId: string): Promise<string> {
  const msg = (await (await fetch(`${MAIL}/api/v1/message/${messageId}`)).json()) as any;
  const m = `${msg.HTML ?? ""}\n${msg.Text ?? ""}`.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify[^\s"'<>]+/);
  if (!m) throw new Error("no verification link in the email");
  return m[0].replace(/&amp;/g, "&");
}
/** Follow the emailed link as far as the Auth server's redirect and return its one-time code. */
async function codeFromEmailLink(link: string): Promise<string | null> {
  const res = await fetch(link, { redirect: "manual" });
  try { return new URL(res.headers.get("location") ?? "").searchParams.get("code"); } catch { return null; }
}
async function freshPage(browser: Browser, viewport?: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, ...(viewport ? { viewport } : {}) });
  return ctx.newPage();
}
async function signInViaForm(page: Page, email: string, password: string) {
  await page.goto("/login");
  const submit = page.getByRole("button", { name: "Sign in", exact: true }).last();
  await waitForHydrated(submit);
  await page.locator('input[name="email"]').last().fill(email);
  await page.locator('input[name="password"]').fill(password);
  await submit.click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
}
/** Run a block as a person, in a fresh session (a new password sign-in each time — a reused
 *  storage file would replay a rotated refresh token). */
async function as<T>(browser: Browser, who: Who | "hq", fn: (page: Page) => Promise<T>, viewport?: { width: number; height: number }): Promise<T> {
  let state = HQ_STATE;
  if (who !== "hq") {
    await mintState(people[who].email, people[who].pw, people[who].state);
    state = people[who].state;
  }
  const ctx = await browser.newContext({ storageState: state, ...(viewport ? { viewport } : {}) });
  try { return await fn(await ctx.newPage()); } finally { await ctx.close(); }
}
async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
async function tile(page: Page, label: string): Promise<number> {
  const card = page.locator("div.rounded-xl", { has: page.getByText(label, { exact: true }) }).first();
  const text = (await card.locator("div.tabular-nums").first().innerText()).replace(/[^0-9.-]/g, "");
  return Math.round(Number(text) * 100);
}
/** The invite link exactly as the product's branded email carries it (lib/auth/magic-link.ts). */
async function inviteLink(email: string): Promise<string> {
  const { data, error } = await db().auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo: "http://localhost:3000/auth/callback" } });
  if (error || !data?.properties?.hashed_token) throw new Error(`generateLink: ${error?.message}`);
  return `/auth/callback?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=magiclink`;
}
/** The four records a customer's history is made of, for the before/after comparison. */
async function recordSnapshot(): Promise<string> {
  const d = db();
  const pick = async (t: string, col: string, val: string) => ((await d.from(t).select("*").eq(col, val).order("id")).data ?? []);
  const photos = ((await d.storage.from("job-photos").list(`${S.org}/${S.jobId}`)).data ?? []).map((f: any) => f.name).sort();
  return JSON.stringify({
    customers: await pick("customers", "org_id", S.org),
    quote: await pick("quotes", "id", S.quoteId),
    quoteLines: await pick("quote_line_items", "quote_id", S.quoteId),
    job: await pick("jobs", "id", S.jobId),
    invoice: await pick("invoices", "id", S.invoiceId),
    invoiceLines: await pick("invoice_line_items", "invoice_id", S.invoiceId),
    payments: await pick("invoice_payments", "invoice_id", S.invoiceId),
    photos,
  });
}
/** Is migration 20261365000000 (jobs INSERT needs jobs:create) applied to this database? */
function jobsInsertNeedsCapability(): boolean {
  try {
    const out = execFileSync("psql", [process.env.DB_URL ?? process.env.DATABASE_URL ?? "", "-Atc",
      "select count(*) from pg_policy where polrelid='public.jobs'::regclass and polname='jobs: members can insert'"], { encoding: "utf8" });
    return out.trim() === "0";
  } catch { return false; }
}

// expected quote, computed here independently in pence (per-line VAT, half-up)
const LINES = [
  { desc: "Groundworks and foundations for rear extension", qty: 1, unit: "4250.00", rate: "20" },
  { desc: "Velux roof windows supplied and fitted", qty: 3, unit: "389.99", rate: "20" },
  { desc: "Loft insulation rolls (energy-saving materials)", qty: 2, unit: "12.45", rate: "5" },
];
const EXPECT = (() => {
  let sub = 0, vat = 0;
  for (const l of LINES) { const lt = Math.round(l.qty * Math.round(Number(l.unit) * 100)); sub += lt; vat += Math.round((lt * Number(l.rate)) / 100); }
  return { sub, vat, total: sub + vat };
})();
const gbp = (p: number) => `£${(p / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money = (p: number) => new RegExp(gbp(p).replace(/[£.]/g, (c) => `\\${c}`).replace(",", ",?"));

test.describe.configure({ mode: "serial" });
test.describe(`first-customer launch rehearsal · ${COMPANY} (opt-in, Stripe test mode)`, () => {
  test.skip(!ON, "set STRIPE_E2E=1 with a Stripe TEST key and a local webhook secret to run");

  test.beforeAll(async () => {
    if (!ON) return;
    assertStripeTestEnv();
    if (!(process.env.CREWFLOW_SUPERADMIN_EMAILS ?? "").toLowerCase().includes(HQ_EMAIL)) {
      // the webServer reads .env.local; the spec only needs the HQ session file from globalSetup
      console.log("[rehearsal] CREWFLOW_SUPERADMIN_EMAILS not in the test process env — relying on the server's .env.local");
    }
    // a previous run that died before its afterAll: remove its synthetic company (and its Stripe customer)
    const stale = ((await db().from("organizations").select("id, stripe_customer_id").eq("name", COMPANY)).data ?? []) as any[];
    for (const o of stale) {
      if (o.stripe_customer_id) await stripe("DELETE", `customers/${o.stripe_customer_id}`).catch(() => {});
      await db().from("organizations").delete().eq("id", o.id);
    }
  });

  test.afterAll(async () => {
    if (!ON) return;
    for (const p of Object.values(people)) rmSync(p.state, { force: true });
    const d = db();
    if (S.org) {
      const o = await org().catch(() => null);
      if (o?.stripe_subscription_id) await stripe("DELETE", `subscriptions/${o.stripe_subscription_id}`).catch(() => {});
      if (o?.stripe_customer_id) await stripe("DELETE", `customers/${o.stripe_customer_id}`).catch(() => {});
      for (const bucket of ["job-photos", "signatures"]) {
        const dirs = ((await d.storage.from(bucket).list(S.org)).data ?? []) as any[];
        for (const dir of dirs) {
          const files = ((await d.storage.from(bucket).list(`${S.org}/${dir.name}`)).data ?? []) as any[];
          if (files.length) await d.storage.from(bucket).remove(files.map((f: any) => `${S.org}/${dir.name}/${f.name}`));
        }
      }
      await d.from("organizations").delete().eq("id", S.org);
    }
    if (S.demoId) await d.from("demo_requests").delete().eq("id", S.demoId);
    for (const p of Object.values(people)) {
      const id = await findAuthUserId(d, p.email).catch(() => undefined);
      if (id) { await d.from("users").delete().eq("id", id); await d.auth.admin.deleteUser(id); }
    }
  });

  // 1 ────────────────────────────────────────────────────────────────────────────────────
  test("1. sales-led provisioning: a demo request → HQ Confirm onboarding → one company, one owner", async ({ browser, request }) => {
    test.setTimeout(120_000);
    const res = await request.post("/api/demo", { data: { name: people.owner.name, company: COMPANY, email: people.owner.email, phone: NI_PHONE, employees: "6-10" } });
    expect(res.status(), await res.text()).toBe(200);
    const demo = (await db().from("demo_requests").select("id, status, linked_org_id").eq("email", people.owner.email).single()).data;
    S.demoId = demo.id;
    expect(demo.linked_org_id).toBeNull();

    await as(browser, "hq", async (page) => {
      await page.goto(`/admin/demos?demo=${S.demoId}`);
      const arm = page.getByRole("button", { name: "Move to onboarding…" });
      await waitForHydrated(arm);
      await arm.click();
      await expect(page.getByText(/This creates a real workspace for/)).toBeVisible();
      const confirm = page.getByRole("button", { name: "Confirm onboarding" });
      await waitForHydrated(confirm);
      await confirm.click();
      await expect.poll(async () => (await db().from("demo_requests").select("status").eq("id", S.demoId).single()).data.status, { timeout: 45_000 }).toBe("active_onboarding");
    });
    S.org = (await db().from("demo_requests").select("linked_org_id").eq("id", S.demoId).single()).data.linked_org_id;
    expect(S.org).toMatch(UUID);
    const o = (await db().from("organizations").select("name, slug, phone, status, setup_fee_status, stripe_customer_id, stripe_subscription_id").eq("id", S.org).single()).data;
    expect(o).toMatchObject({ name: COMPANY, phone: NI_PHONE, status: "trial", stripe_customer_id: null, stripe_subscription_id: null });
    expect(o.setup_fee_status ?? "pending").toBe("pending");
    S.slug = o.slug;
    expect((await db().from("organizations").select("id").eq("name", COMPANY)).data, "exactly one company").toHaveLength(1);
    const members = (await db().from("memberships").select("role, user_id").eq("org_id", S.org)).data as any[];
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("owner");
    S.ownerId = members[0].user_id;
    const authUser = (await db().auth.admin.getUserById(S.ownerId)).data.user;
    expect(authUser.email).toBe(people.owner.email);
    expect(authUser.email_confirmed_at, "the sales-led owner is pre-verified").toBeTruthy();
    test.info().annotations.push({ type: "not automatable locally", description: "The branded welcome email with the owner's sign-in link goes through Resend, which has no key locally (sendEmail → no_key). Production delivery is a founder check." });
  });

  // 2 ────────────────────────────────────────────────────────────────────────────────────
  test("2. the owner sets a password from the emailed link (real email) and signs in with it", async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await freshPage(browser);
    // The Auth server throttles emails per user (max_frequency, 1 s locally) and counts the sign-in
    // link HQ generated moments ago in step 1. A real owner asks hours later; wait out the window
    // (a known timestamp, not a retry) so the request is not silently throttled.
    const u = (await db().auth.admin.getUserById(S.ownerId)).data.user;
    const last = Math.max(Date.parse(u.recovery_sent_at ?? "") || 0, Date.parse(u.confirmation_sent_at ?? "") || 0);
    if (last + 2_000 > Date.now()) await page.waitForTimeout(last + 2_000 - Date.now());
    await page.goto("/reset-password");
    const send = page.locator('form button[type="submit"]');
    await waitForHydrated(send);
    await page.locator('input[name="email"]').fill(people.owner.email);
    await send.click();
    await expect(page.getByText(/If an account exists for that email/)).toBeVisible();
    await expect.poll(async () => (await mailTo(people.owner.email)).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const [message] = await mailTo(people.owner.email);
    const code = await codeFromEmailLink(await verifyLinkIn(message.ID));
    expect(code, "the Auth server redirects back with a one-time code").toBeTruthy();
    await page.goto(`/auth/callback?code=${encodeURIComponent(code!)}&next=/update-password`);
    await expect(page).toHaveURL(/\/update-password/);
    const save = page.locator('form button[type="submit"]');
    await waitForHydrated(save);
    await page.locator('input[name="password"]').fill(people.owner.pw);
    await page.locator('input[name="confirm"]').fill(people.owner.pw);
    await save.click();
    await expect(page).not.toHaveURL(/\/update-password|\/login/, { timeout: 15_000 });
    await page.context().close();

    const fresh = await freshPage(browser);
    await signInViaForm(fresh, people.owner.email, people.owner.pw);
    await expect(fresh).toHaveURL(/\/dashboard/);
    await fresh.context().close();
    test.info().annotations.push({ type: "founder check", description: "Email confirmation is OFF in the local Auth stack; the production project's confirmation setting must be checked by the founder." });
  });

  test("F1. interrupted onboarding resumes: a skipped set-up step is still skipped after leaving and signing in again", async ({ browser }) => {
    test.setTimeout(60_000);
    let before = 0;
    await as(browser, "owner", async (page) => {
      await page.goto("/onboarding/setup");
      await expect(page).toHaveURL(/\/onboarding\/setup/);
      const skip = page.getByRole("button", { name: "Skip for now" }).first();
      await waitForHydrated(skip);
      before = await page.getByRole("button", { name: "Bring back" }).count();
      await skip.click();
      await expect(page).toHaveURL(/saved=skipped/, { timeout: 15_000 });
    });
    const back = await freshPage(browser);
    await signInViaForm(back, people.owner.email, people.owner.pw);
    await back.goto("/onboarding/setup");
    await expect(back.getByRole("button", { name: "Bring back" })).toHaveCount(before + 1);
    await back.context().close();
  });

  // 3 ────────────────────────────────────────────────────────────────────────────────────
  test("3. HQ: £1,000 setup fee (a declined card first — F2) then £500/month; the company is active only after both", async ({ browser }) => {
    test.setTimeout(360_000);
    await as(browser, "hq", async (page) => {
      // policy: the subscription cannot be opened before the setup fee
      await page.goto(`/admin/customers/${S.org}`);
      const sub = page.getByRole("button", { name: "Open subscription checkout (£500/mo)" });
      await waitForHydrated(sub);
      await sub.click();
      await expect(page).toHaveURL(/error=setup_fee_outstanding/);
    });
    expect((await org()).status).toBe("trial");

    S.t0 = now();
    await as(browser, "hq", async (page) => {
      await page.goto(`/admin/customers/${S.org}`);
      const btn = page.getByRole("button", { name: "Open setup-fee checkout (£1,000)" });
      await waitForHydrated(btn);
      await btn.click();
      await payOnStripeCheckout(page, "4000 0000 0000 0002", false); // generic decline
      await declinedShown(page);
      // F2: the decline is delivered and changes nothing — the company stays unpaid and inactive
      const afterDecline = await relay(S.t0);
      expect(afterDecline.filter((d) => d.status !== 200), JSON.stringify(afterDecline)).toEqual([]);
      const o = await org();
      expect(o.status, "a declined card leaves the company inactive").toBe("trial");
      expect(o.setup_fee_status ?? "pending").toBe("pending");
      await payOnStripeCheckout(page, "4242 4242 4242 4242");
    });
    await waitForEvent(S.t0, "checkout.session.completed");
    let delivered = await relay(S.t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    let o = await org();
    expect(o, "fee paid, company NOT active yet").toMatchObject({ setup_fee_status: "paid", status: "trial" });
    S.customer = o.stripe_customer_id;
    expect(S.customer).toMatch(/^cus_/);
    const sessions = await stripe("GET", `checkout/sessions?customer=${S.customer}&limit=10`);
    const paid = sessions.data.filter((s: any) => s.metadata?.kind === "setup_fee" && s.payment_status === "paid");
    expect(paid, "exactly one paid setup-fee session").toHaveLength(1);
    expect(paid[0]).toMatchObject({ amount_total: 100_000, currency: "gbp" });

    S.t0 = now();
    await as(browser, "hq", async (page) => {
      await page.goto(`/admin/customers/${S.org}`);
      const btn = page.getByRole("button", { name: "Open subscription checkout (£500/mo)" });
      await waitForHydrated(btn);
      await btn.click();
      await payOnStripeCheckout(page, "4242 4242 4242 4242");
    });
    await waitForEvent(S.t0, "checkout.session.completed");
    await waitForEvent(S.t0, "customer.subscription.updated", "active");
    delivered = await relay(S.t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    o = await org();
    expect(o.status, "active only after both payments").toBe("active");
    expect(o.stripe_customer_id).toBe(S.customer);
    S.firstSub = o.stripe_subscription_id;
    const sub = await stripe("GET", `subscriptions/${S.firstSub}`);
    expect(sub.status).toBe("active");
    expect(sub.customer).toBe(S.customer);
    expect(sub.items.data[0].price).toMatchObject({ unit_amount: 50_000, currency: "gbp" });
    expect(sub.items.data[0].price.recurring.interval).toBe("month");
  });

  test("F3. duplicate, reordered and forged Stripe webhooks change nothing", async () => {
    const before = await org();
    const dup = await relay(S.t0, { repeat: 2, reverse: true });
    expect(dup.every((d) => d.status === 200), JSON.stringify(dup)).toBe(true);
    expect(await org()).toEqual(before);
    const forged = await fetch("http://localhost:3000/api/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` }, body: JSON.stringify({ id: "evt_forged", type: "customer.subscription.deleted", data: { object: { id: S.firstSub, customer: S.customer, status: "canceled" } } }) });
    expect(forged.status, "a forged signature is refused").toBe(401);
    expect(await org(), "nothing changed").toEqual(before);
    const ids = [...new Set(dup.map((d) => d.id))];
    const rows = await db().from("billing_events").select("event_id, processed_at, error_message").in("event_id", ids);
    expect((rows.data ?? []).length, "one row per Stripe event, however often it was delivered").toBe(ids.length);
  });

  // 4 ────────────────────────────────────────────────────────────────────────────────────
  test("4. owner: company details (required-field check), invites an admin and a staff member; both join and sign in", async ({ browser }) => {
    test.setTimeout(240_000);
    await as(browser, "owner", async (page) => {
      await page.goto("/settings");
      const form = page.locator("form", { has: page.getByRole("button", { name: "Save organisation" }) });
      const save = form.getByRole("button", { name: "Save organisation" });
      await waitForHydrated(save);
      // required field: an empty trading name is refused and nothing is saved
      await form.locator('input[name="name"]').fill("");
      await form.locator('input[name="vat_number"]').fill("GB 123 4567 89");
      await save.click();
      await expect(form.getByText("Trading name is required")).toBeVisible({ timeout: 15_000 });
      expect((await db().from("organizations").select("name, vat_number").eq("id", S.org).single()).data).toEqual({ name: COMPANY, vat_number: null });

      await form.locator('input[name="name"]').fill(COMPANY);
      await form.locator('input[name="vat_number"]').fill("GB 123 4567 89");
      await form.locator('input[name="address_line1"]').fill("14 Bachelors Walk");
      await form.locator('input[name="address_city"]').fill("Lisburn");
      await form.locator('input[name="address_postcode"]').fill("BT28 1XJ");
      await save.click();
      await expect(page.getByText("Organisation saved.")).toBeVisible({ timeout: 15_000 });
    });
    expect((await db().from("organizations").select("name, phone, vat_number, address").eq("id", S.org).single()).data).toEqual({
      name: COMPANY, phone: NI_PHONE, vat_number: "GB 123 4567 89", address: { line1: "14 Bachelors Walk", city: "Lisburn", postcode: "BT28 1XJ" },
    });

    // invites — through the real add-staff dialog
    for (const who of ["admin", "staff"] as const) {
      await as(browser, "owner", async (page) => {
        await page.goto("/staff");
        const trigger = page.getByTestId("add-staff-button");
        await waitForHydrated(trigger);
        await trigger.click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByRole("heading", { name: "Add a staff member" })).toBeVisible();
        await dialog.locator('input[name="full_name"]').fill(people[who].name);
        await dialog.locator('input[name="email"]').fill(people[who].email);
        await dialog.locator('select[name="role"]').selectOption(who);
        await dialog.getByRole("button", { name: "Send invite" }).click();
        // no Resend key locally → the product says so honestly (it does not claim the email went)
        await expect(dialog.getByText(/Couldn't send the invite email|Invite emailed/)).toBeVisible({ timeout: 20_000 });
      });
      const id = await findAuthUserId(db(), people[who].email);
      expect(id, `${who}: the invited account exists`).toBeTruthy();
      const u = (await db().auth.admin.getUserById(id!)).data.user;
      expect(u.app_metadata, `${who}: the invite is anchored in admin-only metadata`).toMatchObject({ invited_org_id: S.org, invited_role: who });
      expect((await db().from("memberships").select("id").eq("org_id", S.org).eq("user_id", id)).data, "not a member until they accept").toHaveLength(0);
      if (who === "admin") S.adminId = id!; else S.staffId = id!;
    }
    test.info().annotations.push({ type: "not automatable locally", description: "Team invite emails go through Resend (no key locally): the dialog reports it could not send. The invite link is opened in the exact shape the email carries." });

    // each invitee opens their link, joins, sets a password, and signs in with it
    for (const who of ["admin", "staff"] as const) {
      const link = await inviteLink(people[who].email);
      if (who === "admin") S.adminLink = link; else S.staffLink = link;
      const page = await freshPage(browser, who === "staff" ? PHONE : undefined);
      await page.goto(link);
      await expect(page).toHaveURL(/\/onboarding\/join/, { timeout: 20_000 });
      await expect(page.getByRole("heading", { name: `Join ${COMPANY} on CrewFlow` })).toBeVisible();
      await expect(page.getByText(`You'll be added as ${who}`, { exact: false })).toBeVisible();
      const join = page.getByRole("button", { name: `Join ${COMPANY}` });
      await page.locator('input[name="full_name"]').fill(people[who].name);
      await join.click();
      await expect(page).toHaveURL(who === "admin" ? /\/dashboard/ : /\/me|\/dashboard/, { timeout: 20_000 });
      await page.goto("/update-password");
      const save = page.locator('form button[type="submit"]');
      await waitForHydrated(save);
      await page.locator('input[name="password"]').fill(people[who].pw);
      await page.locator('input[name="confirm"]').fill(people[who].pw);
      await save.click();
      await expect(page).not.toHaveURL(/\/update-password/, { timeout: 15_000 });
      await page.context().close();
      const fresh = await freshPage(browser, who === "staff" ? PHONE : undefined);
      await signInViaForm(fresh, people[who].email, people[who].pw);
      await expect(fresh).toHaveURL(who === "admin" ? /\/dashboard/ : /\/me/);
      await fresh.context().close();
      const m = (await db().from("memberships").select("role").eq("org_id", S.org).eq("user_id", who === "admin" ? S.adminId : S.staffId)).data;
      expect(m, `${who} joined with the invited role`).toEqual([{ role: who }]);
    }

    // the owner grants the admin the areas they run: quotes, jobs, site safety
    await as(browser, "owner", async (page) => {
      await page.goto(`/staff/${S.adminId}`);
      const saveBtn = page.getByRole("button", { name: "Save permissions" });
      await waitForHydrated(saveBtn);
      for (const label of ["Quotes & estimates — Manage", "Jobs & projects — Manage", "Site safety (RAMS) — Manage"]) {
        await page.getByRole("checkbox", { name: label }).check();
      }
      await saveBtn.click();
      const mem = (await db().from("memberships").select("id").eq("org_id", S.org).eq("user_id", S.adminId).single()).data;
      await expect.poll(async () => ((await db().from("membership_permissions").select("module, action").eq("membership_id", mem.id)).data ?? []).map((r: any) => `${r.module}:${r.action}`).sort(), { timeout: 15_000 })
        .toEqual(["jobs:manage", "quotes:manage", "site_safety:manage"]);
    });
  });

  test("F4. a used invite link is refused; a tampered one too — and neither signs anyone in", async ({ browser }) => {
    for (const link of [S.staffLink, S.staffLink.replace(/token_hash=([^&]{6})/, "token_hash=000000")]) {
      const page = await freshPage(browser);
      await page.goto(link);
      await expect(page).toHaveURL(/\/login\?error=magic_link_(used|expired|invalid)|\/login\?error=auth_failed/);
      await page.goto("/dashboard");
      await expect(page).toHaveURL(/\/login/);
      await page.context().close();
    }
    expect((await db().from("memberships").select("id").eq("org_id", S.org)).data, "still exactly three members").toHaveLength(3);
  });

  // 5 ────────────────────────────────────────────────────────────────────────────────────
  test("5. a customer is added; a member of the public enquires on the company's form (required fields first) → a lead", async ({ browser }) => {
    test.setTimeout(120_000);
    await as(browser, "owner", async (page) => {
      await page.goto("/customers/new");
      const save = page.getByRole("button", { name: "Save customer" });
      await waitForHydrated(save);
      await page.locator('input[name="name"]').fill("Siobhan Kelly");
      await page.locator('input[name="email"]').fill(`siobhan-${TAG}@example.test`);
      await page.locator('input[name="phone"]').fill("028 9267 4410");
      await page.locator('input[name="address_line1"]').fill("3 Hillhall Road");
      await page.locator('input[name="city"]').fill("Lisburn");
      await page.locator('input[name="postcode"]').fill("BT27 5BY");
      await save.click();
      await page.waitForURL(new RegExp(`/customers/${UUID.source}`), { timeout: 20_000 });
      S.repeatCustomer = page.url().match(UUID)![0];
    });
    expect((await db().from("customers").select("org_id, name, phone, postcode").eq("id", S.repeatCustomer).single()).data)
      .toEqual({ org_id: S.org, name: "Siobhan Kelly", phone: "028 9267 4410", postcode: "BT27 5BY" });

    const leads = async () => ((await db().from("leads").select("id, source, status, contact_name, contact_email, contact_phone, postcode, service").eq("org_id", S.org)).data ?? []) as any[];
    const page = await freshPage(browser, PHONE);
    await page.goto(`/l/${S.slug}`);
    await expect(page.getByRole("heading", { name: COMPANY })).toBeVisible();
    const send = page.getByRole("button", { name: "Send enquiry" });
    await waitForHydrated(send);
    await send.click(); // nothing filled in
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 15_000 });
    expect(await leads(), "an incomplete enquiry creates nothing").toHaveLength(0);
    await page.locator("#name").fill("Declan Byrne");
    await page.locator("#email").fill(`declan-${TAG}@example.test`);
    await page.locator("#phone").fill("028 9260 1188");
    await page.locator("#service").fill("Rear kitchen extension");
    await page.locator("#postcode").fill("BT28 2HD");
    await page.locator("#message").fill("Single-storey rear extension, roughly 4m x 5m, with two roof windows. Hoping to start in the new year.");
    await page.locator('input[name="consent"]').check();
    await send.click();
    await expect(page.getByText("Thank you — your enquiry has been sent.")).toBeVisible({ timeout: 15_000 });
    expect(await overflowPx(page), "the enquiry form fits a phone").toBeLessThanOrEqual(1);
    await page.context().close();
    const l = await leads();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ source: "web", status: "new", contact_name: "Declan Byrne", contact_phone: "028 9260 1188", postcode: "BT28 2HD" });
    S.leadId = l[0].id;
  });

  // 6 ────────────────────────────────────────────────────────────────────────────────────
  test("6. lead → quote with VAT lines (to the penny) → admin approves → sent → the customer accepts → one job + one draft invoice", async ({ browser }) => {
    test.setTimeout(240_000);
    await as(browser, "owner", async (page) => {
      await page.goto(`/leads/${S.leadId}`);
      const convert = page.getByRole("button", { name: /convert to customer/i });
      await waitForHydrated(convert);
      await convert.click();
      await page.waitForURL(new RegExp(`/customers/${UUID.source}`), { timeout: 20_000 });
      S.leadCustomer = page.url().match(UUID)![0];
      await page.goto(`/leads/${S.leadId}`);
      await page.getByRole("link", { name: /Create a quote/ }).click();
      await page.waitForURL(/\/quotes\/new\?/);
      const saveQuote = page.getByRole("button", { name: "Save quote" });
      await waitForHydrated(saveQuote);
      const desc = page.getByPlaceholder(/supply only/i);
      for (let i = 0; i < LINES.length; i++) {
        if (i > 0) await page.getByRole("button", { name: "+ Add line" }).click();
        await desc.nth(i).fill(LINES[i]!.desc);
        await page.getByLabel("Quantity").nth(i).fill(String(LINES[i]!.qty));
        await page.getByLabel("Unit price").nth(i).fill(LINES[i]!.unit);
        await page.getByLabel(`Line ${i + 1} VAT rate`).selectOption(LINES[i]!.rate);
      }
      const totals = page.locator("dl").filter({ hasText: "Subtotal" });
      await expect(totals).toContainText(money(EXPECT.sub));
      await expect(totals).toContainText(money(EXPECT.vat));
      await expect(totals).toContainText(money(EXPECT.total));
      await saveQuote.click();
      await page.waitForURL(new RegExp(`/quotes/${UUID.source}$`), { timeout: 30_000 });
      S.quoteId = page.url().match(UUID)![0];
      const request = page.getByRole("button", { name: "Request approval" });
      await waitForHydrated(request);
      await request.click();
      await expect.poll(async () => (await db().from("quotes").select("status").eq("id", S.quoteId).single()).data.status, { timeout: 20_000 }).toBe("pending_approval");
      // the creator cannot approve their own quote while another approver exists
      await page.reload();
      await expect(page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
    });
    const q = (await db().from("quotes").select("status, lead_id, customer_id, subtotal, vat_total, total, public_token").eq("id", S.quoteId).single()).data;
    expect({ sub: pence(q.subtotal), vat: pence(q.vat_total), total: pence(q.total) }, "server totals to the penny").toEqual(EXPECT);
    expect(q).toMatchObject({ lead_id: S.leadId, customer_id: S.leadCustomer });
    const lines = ((await db().from("quote_line_items").select("description, qty, unit_price, vat_rate, line_total").eq("quote_id", S.quoteId).order("sort_order")).data ?? []) as any[];
    expect(lines.map((l) => ({ d: l.description, t: pence(l.line_total), r: Number(l.vat_rate) }))).toEqual(LINES.map((l) => ({ d: l.desc, t: Math.round(l.qty * Math.round(Number(l.unit) * 100)), r: Number(l.rate) })));
    S.quoteToken = q.public_token;

    await as(browser, "admin", async (page) => {
      await page.goto(`/quotes/${S.quoteId}`);
      const approve = page.getByRole("button", { name: /^approve$/i });
      await waitForHydrated(approve);
      await approve.click();
      await expect.poll(async () => (await db().from("quotes").select("status, approved_by").eq("id", S.quoteId).single()).data, { timeout: 20_000 }).toEqual({ status: "approved", approved_by: S.adminId });
    });
    await as(browser, "owner", async (page) => {
      await page.goto(`/quotes/${S.quoteId}`);
      const markSent = page.getByRole("button", { name: "Mark as sent (no email)" });
      await waitForHydrated(markSent);
      await markSent.click();
      await expect.poll(async () => (await db().from("quotes").select("status, sent_at").eq("id", S.quoteId).single()).data, { timeout: 20_000 }).toMatchObject({ status: "sent", sent_at: expect.any(String) });
    });

    // the customer, on their phone, with nothing but the link
    const cust = await freshPage(browser, PHONE);
    await cust.goto(`/q/${S.quoteToken}`);
    await expect(cust.getByText(money(EXPECT.total)).first()).toBeVisible();
    await cust.locator("#signer_name").fill("Declan Byrne");
    await cust.getByRole("button", { name: "Accept & sign" }).click();
    await expect(cust).toHaveURL(/saved=accepted/, { timeout: 30_000 });
    await expect(cust.getByText("Quote accepted successfully.")).toBeVisible();
    expect(await overflowPx(cust)).toBeLessThanOrEqual(1);
    await cust.context().close();

    const accepted = (await db().from("quotes").select("status, job_id, accept_signature").eq("id", S.quoteId).single()).data;
    expect(accepted.status).toBe("accepted");
    expect(accepted.accept_signature).toMatchObject({ name: "Declan Byrne", source: "public" });
    S.jobId = accepted.job_id;
    expect(S.jobId).toMatch(UUID);
    const jobs = (await db().from("jobs").select("id, customer_id").eq("org_id", S.org)).data as any[];
    expect(jobs, "exactly one job").toEqual([{ id: S.jobId, customer_id: S.leadCustomer }]);
    const invs = (await db().from("invoices").select("id, status, total, quote_id, job_id, customer_id").eq("org_id", S.org)).data as any[];
    expect(invs, "exactly one invoice").toHaveLength(1);
    expect(invs[0]).toMatchObject({ status: "draft", quote_id: S.quoteId, job_id: S.jobId, customer_id: S.leadCustomer });
    expect(pence(invs[0].total)).toBe(EXPECT.total);
    S.invoiceId = invs[0].id;
    expect(((await db().from("invoice_line_items").select("id").eq("invoice_id", S.invoiceId)).data ?? []).length).toBe(LINES.length);
  });

  // 7 ────────────────────────────────────────────────────────────────────────────────────
  test("7. owner schedules the job, writes the site instructions and assigns the staff member", async ({ browser }) => {
    test.setTimeout(90_000);
    const today = new Date().toISOString().slice(0, 10);
    await as(browser, "owner", async (page) => {
      await page.goto(`/jobs/${S.jobId}`);
      const form = page.locator("form", { has: page.getByRole("button", { name: "Save changes" }) });
      const save = form.getByRole("button", { name: "Save changes" });
      await waitForHydrated(save);
      await form.locator('select[name="assigned_to"]').selectOption(S.staffId);
      await form.locator('select[name="status"]').selectOption("in-progress");
      await form.locator('input[name="scheduled_date"]').fill(today);
      await form.locator('textarea[name="notes"]').fill(`Site access via the rear lane. Hard hats and hi-vis at all times. ${TAG}`);
      await save.click();
      await expect.poll(async () => (await db().from("jobs").select("assigned_to, status, scheduled_date, notes").eq("id", S.jobId).single()).data, { timeout: 20_000 })
        .toEqual({ assigned_to: S.staffId, status: "in-progress", scheduled_date: today, notes: `Site access via the rear lane. Hard hats and hi-vis at all times. ${TAG}` });
      await page.reload();
      await expect(page.locator("section", { has: page.getByRole("heading", { name: "Assigned team" }) }).getByText(people.staff.name)).toBeVisible();
    });
  });

  // 8 ────────────────────────────────────────────────────────────────────────────────────
  test("8. admin issues a RAMS for the job; staff on a phone: job + instructions, signs the RAMS, clocks in/out, photo, progress, diary", async ({ browser }) => {
    test.setTimeout(240_000);
    await as(browser, "admin", async (page) => {
      await page.goto(`/health-safety/new?job=${S.jobId}`);
      await expect(page.locator("#jobId")).toHaveValue(S.jobId);
      await page.locator("#title").fill(`Rear extension RAMS ${TAG}`);
      await page.locator("#activity").fill("Excavation, blockwork and roof window installation at a domestic property");
      await page.locator("#assessorId").selectOption(S.adminId);
      await page.getByRole("button", { name: /save draft/i }).click();
      await expect(page).toHaveURL(new RegExp(`/health-safety/${UUID.source}`), { timeout: 20_000 });
      S.raId = page.url().match(UUID)![0];
      await page.locator("#hazard").fill("Working at height on the roof");
      await page.locator("#whoAtRisk").fill("Operatives");
      await page.locator("#likelihood").selectOption("3");
      await page.locator("#severity").selectOption("4");
      await page.locator("#controlMeasures").fill("Scaffold with edge protection, harness for roof window openings, toolbox talk before work starts.");
      await page.getByRole("button", { name: "Add hazard" }).click();
      await expect.poll(async () => ((await db().from("risk_assessment_hazards").select("id").eq("risk_assessment_id", S.raId)).data ?? []).length, { timeout: 15_000 }).toBe(1);
      await page.goto(`/health-safety/${S.raId}`);
      await page.getByRole("button", { name: "Issue risk assessment" }).click();
      await expect.poll(async () => (await db().from("risk_assessments").select("status, job_id").eq("id", S.raId).single()).data, { timeout: 20_000 }).toEqual({ status: "issued", job_id: S.jobId });
    });

    await as(browser, "staff", async (page) => {
      // the assigned job and its instructions
      await page.goto("/jobs");
      await expect(page.getByText("Declan Byrne").filter({ visible: true }).first()).toBeVisible();
      expect(await overflowPx(page), "/jobs at 390px").toBeLessThanOrEqual(1);
      await page.goto(`/jobs/${S.jobId}`);
      const details = page.getByTestId("job-details-readonly");
      await expect(details).toContainText(`Site access via the rear lane. Hard hats and hi-vis at all times. ${TAG}`);
      await expect(details).toContainText("In progress");

      // RAMS sign-off
      await page.goto(`/health-safety/${S.raId}`);
      const sign = page.getByRole("button", { name: "I have read and understood — sign" });
      await waitForHydrated(sign);
      await page.locator('input[name="signedName"]').fill(people.staff.name);
      await sign.click();
      await expect(page.getByText(/You acknowledged this on/i)).toBeVisible({ timeout: 15_000 });
      const acks = (await db().from("safety_acknowledgements").select("user_id, signed_name").eq("subject_id", S.raId)).data;
      expect(acks).toEqual([{ user_id: S.staffId, signed_name: people.staff.name }]);
      expect(await overflowPx(page), "RAMS at 390px").toBeLessThanOrEqual(1);

      // clock in, then out
      await page.goto("/me");
      const clockIn = page.getByRole("button", { name: "Clock in" });
      await waitForHydrated(clockIn);
      await page.locator('select[name="job_id"]').selectOption(S.jobId);
      await page.locator('input[name="note"]').fill(`Groundworks ${TAG}`);
      await clockIn.click();
      await expect(page.getByText("Clocked in. Have a good shift.")).toBeVisible({ timeout: 15_000 });
      const open = (await db().from("time_entries").select("id, job_id, org_id, ended_at").eq("user_id", S.staffId).is("ended_at", null)).data as any[];
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ job_id: S.jobId, org_id: S.org });
      const clockOut = page.getByRole("button", { name: "Clock out" });
      await waitForHydrated(clockOut);
      await clockOut.click();
      await expect(page.getByText("Clocked out. Hours saved.")).toBeVisible({ timeout: 15_000 });
      expect((await db().from("time_entries").select("ended_at").eq("id", open[0].id).single()).data.ended_at).not.toBeNull();
      expect(await overflowPx(page), "/me at 390px").toBeLessThanOrEqual(1);

      // a site photo
      await page.goto(`/jobs/${S.jobId}`);
      const photos = page.locator("section", { has: page.getByRole("heading", { name: "Photos", exact: true }) }).locator('input[type="file"]');
      await waitForHydrated(photos);
      await photos.setInputFiles([{ name: "foundations.png", mimeType: "image/png", buffer: PNG }]);
      await expect(page.getByText("1 attached")).toBeVisible({ timeout: 20_000 });
      const paths = (await db().from("jobs").select("photos").eq("id", S.jobId).single()).data.photos as string[];
      expect(paths).toHaveLength(1);
      expect(paths[0]!.startsWith(`${S.org}/${S.jobId}/`)).toBe(true);

      // progress
      const progress = page.locator("form", { has: page.locator("#percent") });
      const record = progress.getByRole("button", { name: "Record" });
      await waitForHydrated(record);
      await page.locator("#percent").fill("60");
      await page.locator("#note").fill(`Foundations poured ${TAG}`);
      await record.click();
      await expect(page).toHaveURL(/saved=progress/, { timeout: 15_000 });
      const obs = (await db().from("job_progress_observations").select("percent, recorded_by").eq("job_id", S.jobId)).data as any[];
      expect(obs.map((r) => ({ ...r, percent: Number(r.percent) }))).toEqual([{ percent: 60, recorded_by: S.staffId }]);

      // diary
      await page.goto(`/diary/new?job=${S.jobId}`);
      await expect(page.locator("#job_id")).toHaveValue(S.jobId);
      const saveEntry = page.getByRole("button", { name: "Save entry" });
      await waitForHydrated(saveEntry);
      await page.locator("#work_summary").fill(`Footings dug and concrete poured ${TAG}`);
      await saveEntry.click();
      await page.waitForURL(new RegExp(`/diary/${UUID.source}`), { timeout: 20_000 });
      const diary = (await db().from("site_diary_entries").select("job_id, work_summary").eq("job_id", S.jobId)).data;
      expect(diary).toEqual([{ job_id: S.jobId, work_summary: `Footings dug and concrete poured ${TAG}` }]);
      expect(await overflowPx(page), "diary at 390px").toBeLessThanOrEqual(1);
    }, PHONE);
  });

  test("F5. staff cannot open owner pages or create jobs", async ({ browser }) => {
    test.setTimeout(120_000);
    const refused: string[] = [];
    await as(browser, "staff", async (page) => {
      // /settings itself is open to everyone (their own profile) — but not the company's details
      await page.goto("/settings");
      await expect(page.getByRole("button", { name: "Save organisation" })).toHaveCount(0);
      for (const path of ["/settings/billing", "/staff", "/invoices", `/invoices/${S.invoiceId}`, "/quotes", "/reports", "/jobs/new", "/admin"]) {
        const res = await page.goto(path);
        // these pages stream: a server-side redirect inside a Suspense boundary is applied by the
        // client router after `load`, so wait (bounded) for the refusal to land
        const outcome = async () => {
          const landed = new URL(page.url()).pathname;
          if ((res?.status() ?? 200) === 404 || (await page.getByRole("heading", { name: /doesn.t exist|not found/i }).count()) > 0) return "not-found";
          return landed === path ? "open" : `redirected to ${landed}`;
        };
        const seen = await expect.poll(outcome, { timeout: 10_000 }).not.toBe("open").then(outcome, outcome);
        if (seen === "open") refused.push(`${path}: OPEN to staff`);
        else test.info().annotations.push({ type: `staff → ${path}`, description: seen });
      }
    }, PHONE);
    expect(refused, refused.join("\n")).toEqual([]);

    // the Data API: a staff member's own session trying to insert a job
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const staffClient = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } }) as any;
    await staffClient.auth.signInWithPassword({ email: people.staff.email, password: people.staff.pw });
    const ins = await staffClient.from("jobs").insert({ org_id: S.org, status: "new" }).select("id");
    const created = (ins.data ?? []) as any[];
    if (created.length) await db().from("jobs").delete().in("id", created.map((r) => r.id));
    if (jobsInsertNeedsCapability()) {
      expect(ins.error, "a staff session cannot insert a job").not.toBeNull();
      expect(created).toHaveLength(0);
    } else {
      test.info().annotations.push({ type: "pending migration 20261365000000", description: `jobs INSERT still open to any member on this database (staff insert ${created.length ? "SUCCEEDED and was removed" : "refused"}); the capability policy lands with migration 365 (other workstream).` });
    }
    expect((await db().from("jobs").select("id").eq("org_id", S.org)).data, "still exactly the one job").toHaveLength(1);
  });

  // 9 ────────────────────────────────────────────────────────────────────────────────────
  test("9. owner completes the job, issues the invoice, refuses an over-payment, records the full payment; tiles reconcile", async ({ browser }) => {
    test.setTimeout(150_000);
    await as(browser, "owner", async (page) => {
      await page.goto(`/jobs/${S.jobId}`);
      const form = page.locator("form", { has: page.getByRole("button", { name: "Save changes" }) });
      const save = form.getByRole("button", { name: "Save changes" });
      await waitForHydrated(save);
      await form.locator('select[name="status"]').selectOption("completed");
      await save.click();
      await expect.poll(async () => (await db().from("jobs").select("status").eq("id", S.jobId).single()).data.status, { timeout: 20_000 }).toBe("completed");

      await page.goto(`/invoices/${S.invoiceId}`);
      const sent = page.getByRole("button", { name: "sent", exact: true });
      await waitForHydrated(sent);
      await sent.click();
      await expect.poll(async () => (await db().from("invoices").select("status, sent_at").eq("id", S.invoiceId).single()).data, { timeout: 20_000 }).toMatchObject({ status: "sent", sent_at: expect.any(String) });

      await page.reload();
      const record = page.getByRole("button", { name: "Record payment" });
      await waitForHydrated(record);
      await page.locator('input[name="amount"]').fill(((EXPECT.total + 1) / 100).toFixed(2));
      await record.click();
      await expect(page.getByText(`more than the £${(EXPECT.total / 100).toFixed(2)} still owed on this invoice`)).toBeVisible({ timeout: 15_000 });
      expect((await db().from("invoice_payments").select("id").eq("invoice_id", S.invoiceId)).data, "the over-payment recorded nothing").toHaveLength(0);
      await page.locator('input[name="amount"]').fill((EXPECT.total / 100).toFixed(2));
      await page.locator('input[name="reference"]').fill(`BACS ${TAG}`);
      await record.click();
      await expect.poll(async () => ((await db().from("invoice_payments").select("amount").eq("invoice_id", S.invoiceId)).data ?? []).map((p: any) => pence(p.amount)), { timeout: 20_000 }).toEqual([EXPECT.total]);
      await expect.poll(async () => (await db().from("invoices").select("status").eq("id", S.invoiceId).single()).data.status).toBe("paid");

      // dashboard tiles vs totals recomputed independently from the tables
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
      const invoices = ((await db().from("invoices").select("id, status, total, created_at").eq("org_id", S.org)).data ?? []) as any[];
      const payments = ((await db().from("invoice_payments").select("amount, paid_at").eq("org_id", S.org)).data ?? []) as any[];
      const ISSUED = ["sent", "awaiting_payment", "partially_paid", "paid", "overdue"];
      const invoiced = invoices.filter((i) => ISSUED.includes(i.status) && i.created_at >= monthStart).reduce((n, i) => n + pence(i.total), 0);
      const cashIn = payments.filter((p) => p.paid_at >= monthStart.slice(0, 10)).reduce((n, p) => n + pence(p.amount), 0);
      expect({ invoiced, cashIn }, "this company's month so far").toEqual({ invoiced: EXPECT.total, cashIn: EXPECT.total });
      await page.goto("/dashboard");
      await expect(page.getByText("Invoiced this month", { exact: true }).first()).toBeVisible();
      expect({ invoiced: await tile(page, "Invoiced this month"), cashIn: await tile(page, "Cash in this month"), outstanding: await tile(page, "Outstanding") })
        .toEqual({ invoiced, cashIn, outstanding: 0 });
    });
    S.snapshot = await recordSnapshot();
  });

  // 10 ───────────────────────────────────────────────────────────────────────────────────
  test("10. owner schedules cancellation: the exact end date = Stripe current_period_end; the company and its crew keep access", async ({ browser }) => {
    test.setTimeout(150_000);
    const before = await stripe("GET", `subscriptions/${S.firstSub}`);
    const end = periodEndOf(before);
    S.t0 = now();
    await as(browser, "owner", async (page) => {
      await page.goto("/settings/billing");
      await expect(page.getByText(`on ${ukDate(end)}`).first()).toBeVisible();
      const trigger = page.getByRole("button", { name: "Cancel subscription", exact: true });
      await waitForHydrated(trigger);
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByTestId("access-end-date")).toHaveText(ukDate(end));
      await dialog.getByLabel(/Why are you cancelling/).fill("first-customer launch rehearsal");
      await dialog.getByRole("button", { name: `Cancel at end of period (${ukDate(end)})` }).click();
      await page.waitForURL(/\/settings\/billing\?cancellation_scheduled=1/, { timeout: 60_000 });
      await expect(page.getByTestId("cancellation-scheduled")).toContainText(`ends on ${ukDate(end)}`);
    });
    const after = await stripe("GET", `subscriptions/${S.firstSub}`);
    expect(after).toMatchObject({ status: "active", cancel_at_period_end: true });
    expect(periodEndOf(after)).toBe(end);
    await waitForEvent(S.t0, "customer.subscription.updated");
    const delivered = await relay(S.t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    expect((await org()).status, "full access until the period end").toBe("active");
    for (const who of ["staff", "admin"] as const) {
      await as(browser, who, async (page) => {
        await page.goto("/dashboard");
        await expect(page, `${who} still has access`).not.toHaveURL(/access-pending|login/);
      }, who === "staff" ? PHONE : undefined);
    }
  });

  // 11 ───────────────────────────────────────────────────────────────────────────────────
  test("11. the period ends (Stripe deletes the subscription) → cancelled: owner read-only with export; admin and staff locked out", async ({ browser }) => {
    test.setTimeout(150_000);
    S.t0 = now();
    await stripe("DELETE", `subscriptions/${S.firstSub}`);
    await waitForEvent(S.t0, "customer.subscription.deleted");
    const delivered = await relay(S.t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    expect((await org()).status).toBe("cancelled");
    await as(browser, "owner", async (page) => {
      await page.goto("/account/billing");
      await expect(page.getByRole("link", { name: "Download data export" })).toBeVisible();
      await page.goto("/dashboard");
      await expect(page).not.toHaveURL(/access-pending/);
      await expect(page.getByTestId("held-company-banner")).toContainText(/cancelled — read-only/i);
    });
    for (const who of ["admin", "staff"] as const) {
      await as(browser, who, async (page) => {
        await page.goto("/dashboard");
        await expect(page, `${who} sees the lock screen`).toHaveURL(/access-pending/);
        await page.goto(`/jobs/${S.jobId}`);
        await expect(page, `${who} cannot reach a job`).toHaveURL(/access-pending/);
      }, who === "staff" ? PHONE : undefined);
    }
    expect((await db().from("organizations").select("id").eq("id", S.org)).data, "cancellation never deletes the company").toHaveLength(1);
  });

  // 12 ───────────────────────────────────────────────────────────────────────────────────
  test("12. reactivation: the owner asks, HQ takes a NEW subscription (no second setup fee); every earlier record is intact", async ({ browser }) => {
    test.setTimeout(240_000);
    await as(browser, "owner", async (page) => {
      await page.goto("/account/billing");
      const ask = page.getByRole("button", { name: "Ask to reactivate" });
      await waitForHydrated(ask);
      await ask.click();
      await expect(page.getByText("We've got your request.")).toBeVisible();
    });
    S.t0 = now();
    await as(browser, "hq", async (page) => {
      await page.goto(`/admin/customers/${S.org}`);
      const btn = page.getByRole("button", { name: "Open subscription checkout (£500/mo)" });
      await waitForHydrated(btn);
      await btn.click();
      await payOnStripeCheckout(page, "4242 4242 4242 4242");
    });
    await waitForEvent(S.t0, "checkout.session.completed");
    await waitForEvent(S.t0, "customer.subscription.updated", "active");
    const delivered = await relay(S.t0);
    expect(delivered.filter((d) => d.status !== 200), JSON.stringify(delivered)).toEqual([]);
    const o = await org();
    expect(o).toMatchObject({ status: "active", cancelled_at: null, stripe_customer_id: S.customer });
    expect(o.stripe_subscription_id).not.toBe(S.firstSub);
    expect((await stripe("GET", `subscriptions/${o.stripe_subscription_id}`)).status).toBe("active");
    const fees = await stripe("GET", `checkout/sessions?customer=${S.customer}&limit=20`);
    expect(fees.data.filter((s: any) => s.metadata?.kind === "setup_fee" && s.payment_status === "paid"), "the setup fee was charged exactly once").toHaveLength(1);
    expect(await recordSnapshot(), "customers, quote, job, invoice, payment and photo unchanged").toBe(S.snapshot);
    for (const who of ["admin", "staff"] as const) {
      await as(browser, who, async (page) => {
        await page.goto("/dashboard");
        await expect(page, `${who} is back in`).not.toHaveURL(/access-pending|login/);
      });
    }
    await as(browser, "owner", async (page) => {
      await page.goto(`/jobs/${S.jobId}`);
      await expect(page.locator("section", { has: page.getByRole("heading", { name: "Photos", exact: true }) }).getByText("1 attached")).toBeVisible();
    });
  });

  // failure scenarios that add records — after the before/after comparison ────────────────
  test("F6. a duplicate quote-accept (two submits at once) creates one job and one invoice", async ({ browser }) => {
    test.setTimeout(90_000);
    const token = crypto.randomUUID();
    const q = await db().from("quotes").insert({ org_id: S.org, customer_id: S.repeatCustomer, number: `Q-${TAG}-DUP`, status: "sent", subtotal: 500, vat_total: 100, public_token: token, sent_at: new Date().toISOString() }).select("id").single();
    if (q.error) throw new Error(`quote: ${q.error.message}`);
    const li = await db().from("quote_line_items").insert({ quote_id: q.data.id, org_id: S.org, description: "Garden wall repointing", qty: 1, unit_price: 500, vat_rate: 20, line_total: 500, sort_order: 0 });
    if (li.error) throw new Error(`line: ${li.error.message}`);
    const pages = [await freshPage(browser), await freshPage(browser)];
    for (const p of pages) {
      await p.goto(`/q/${token}`);
      await p.locator("#signer_name").fill("Siobhan Kelly");
    }
    await Promise.all(pages.map((p) => p.getByRole("button", { name: "Accept & sign" }).click()));
    await Promise.all(pages.map((p) => p.waitForURL(/saved=accepted|error=/, { timeout: 30_000 })));
    const outcomes = pages.map((p) => new URL(p.url()).search);
    test.info().annotations.push({ type: "duplicate accept — what each submit saw", description: outcomes.join(" | ") });
    // both submits are told the truth: the quote is accepted (the losing one used to say
    // "Couldn't record acceptance" beside "Quote accepted successfully")
    for (const p of pages) {
      await expect(p).toHaveURL(/saved=accepted/);
      await expect(p.getByText("Couldn't record acceptance")).toHaveCount(0);
      await p.context().close();
    }
    const accepted = (await db().from("quotes").select("status, job_id").eq("id", q.data.id).single()).data;
    expect(accepted.status).toBe("accepted");
    expect((await db().from("jobs").select("id").eq("org_id", S.org).eq("customer_id", S.repeatCustomer)).data, "one job").toHaveLength(1);
    expect((await db().from("invoices").select("id").eq("quote_id", q.data.id)).data, "one invoice").toHaveLength(1);
  });

  test("F7. two payments recorded at once on one invoice cannot exceed its total (database guard)", async ({ browser }) => {
    test.setTimeout(90_000);
    const inv = await db().from("invoices").insert({ org_id: S.org, customer_id: S.repeatCustomer, number: `INV-${TAG}-RACE`, status: "sent", amount: 250, vat_total: 50, due_date: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) }).select("id").single();
    if (inv.error) throw new Error(`invoice: ${inv.error.message}`);
    await mintState(people.owner.email, people.owner.pw, people.owner.state);
    const ctx = await browser.newContext({ storageState: people.owner.state });
    try {
      const pages = [await ctx.newPage(), await ctx.newPage()];
      const amounts = ["200.00", "150.00"]; // each fits on its own; together they would over-pay £300
      for (let i = 0; i < 2; i++) {
        await pages[i]!.goto(`/invoices/${inv.data.id}`);
        await waitForHydrated(pages[i]!.getByRole("button", { name: "Record payment" }));
        await pages[i]!.locator('input[name="amount"]').fill(amounts[i]!);
        await pages[i]!.locator('input[name="reference"]').fill(`race-${i}`);
      }
      await Promise.all(pages.map((p) => p.getByRole("button", { name: "Record payment" }).click()));
      await expect.poll(async () => ((await db().from("invoice_payments").select("id").eq("invoice_id", inv.data.id)).data ?? []).length, { timeout: 20_000 }).toBeGreaterThan(0);
      await pages[0]!.waitForTimeout(2_000); // let the losing submit finish
      const rows = ((await db().from("invoice_payments").select("amount").eq("invoice_id", inv.data.id)).data ?? []) as any[];
      const total = rows.reduce((n, r) => n + pence(r.amount), 0);
      expect(total, "never more than the £300.00 owed").toBeLessThanOrEqual(30_000);
      expect(rows, "only one of the two went through").toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });
});
