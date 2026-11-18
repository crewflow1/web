/* eslint-disable @typescript-eslint/no-explicit-any -- service-role admin client, loose rows */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";
import { findAuthUserId } from "./_actors";

/**
 * Self sign-up and onboarding on a PHONE (390 × 844), interrupted and resumed, in a real
 * browser on the production build against the real local Auth + Postgres:
 *
 *   1. a new person creates an account and lands on the company form — then leaves;
 *   2. signing in again later brings them straight back to the company form (no dead end);
 *   3. a bad postcode is refused with a visible message; a good one creates ONE company with
 *      them as owner and the terms acceptance stamped, and they wait on "access pending";
 *   4. leaving and signing in again lands on "access pending" again — no second company;
 *   5. once CrewFlow activates the company, the set-up wizard works on the phone and a skipped
 *      step stays skipped after a reload.
 * Every screen: no sideways scroll at 390 px and no hydration error.
 * (Email confirmation is off in the local Auth stack, so sign-up signs straight in.)
 */
const TAG = `ob${Date.now().toString(36)}`;
const EMAIL = `onboard-${TAG}@example.test`;
const PW = `Pw-${crypto.randomUUID()}`;
const COMPANY = `${TAG} Roofing`;
const PHONE = { width: 390, height: 844 };

const db = createClient(assertLocalE2eTarget("launch-onboarding-phone.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
}) as any;

function watch(page: Page, into: string[]) {
  page.on("console", (m) => {
    if (m.type() === "error" && /hydrat|Minified React error #(418|423|425)/i.test(m.text())) into.push(`${page.url()} ${m.text()}`);
  });
  page.on("pageerror", (e) => into.push(`${page.url()} pageerror: ${e.message}`));
}
async function noSidewaysScroll(page: Page, where: string) {
  const ox = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ox, `${where}: no horizontal overflow at 390px`).toBeLessThanOrEqual(1);
}
/** A fresh phone browser (no cookies) — the person coming back later. */
async function freshPhone(browser: Browser, errors: string[]): Promise<Page> {
  const ctx = await browser.newContext({ viewport: PHONE, storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  watch(page, errors);
  return page;
}
async function signIn(page: Page) {
  await page.goto("/login");
  const submit = page.getByRole("button", { name: "Sign in", exact: true }).last();
  await waitForHydrated(submit);
  await page.locator('input[name="email"]').last().fill(EMAIL);
  await page.locator('input[name="password"]').fill(PW);
  await submit.click();
}
async function userId(): Promise<string | undefined> {
  return findAuthUserId(db, EMAIL);
}
async function companiesOf(uid: string): Promise<any[]> {
  return (await db.from("memberships").select("org_id, role, organizations(name, status, tos_accepted_at)").eq("user_id", uid)).data ?? [];
}

test.describe.configure({ mode: "serial" });
test.describe("onboarding on a phone, interrupted and resumed (browser)", () => {
  const errors: string[] = [];

  test.afterAll(async () => {
    const uid = await userId();
    if (!uid) return;
    for (const m of await companiesOf(uid)) await db.from("organizations").delete().eq("id", m.org_id);
    await db.auth.admin.deleteUser(uid);
  });

  test("sign up on a phone lands on the company form; leaving and signing in again comes back to it", async ({ browser }) => {
    test.setTimeout(90_000);
    const page = await freshPhone(browser, errors);
    await page.goto("/login");
    await noSidewaysScroll(page, "/login");
    const tab = page.getByRole("button", { name: "Create account" }).first();
    await waitForHydrated(tab);
    await tab.click();
    await page.locator('input[name="email"]').last().fill(EMAIL);
    await page.locator('input[name="password"]').fill(PW);
    await page.locator('input[name="confirm"]').fill(PW);
    await page.getByRole("button", { name: "Create account", exact: true }).last().click();
    await expect(page).toHaveURL(/\/onboarding\/company/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Tell us about your business" })).toBeVisible();
    await noSidewaysScroll(page, "/onboarding/company");
    await page.context().close(); // walks away before creating the company

    const back = await freshPhone(browser, errors);
    await signIn(back);
    await expect(back).toHaveURL(/\/onboarding\/company/, { timeout: 20_000 });
    await expect(back.getByRole("heading", { name: "Tell us about your business" })).toBeVisible();
    await back.context().close();
  });

  test("a bad postcode is refused visibly; a good one creates one company, owner + terms stamped, then access pending", async ({ browser }) => {
    test.setTimeout(90_000);
    const page = await freshPhone(browser, errors);
    await signIn(page);
    await expect(page).toHaveURL(/\/onboarding\/company/, { timeout: 20_000 });
    const submit = page.getByRole("button", { name: "Continue →" });
    await waitForHydrated(submit);
    const fill = async (postcode: string) => {
      await page.locator('input[name="name"]').fill(COMPANY);
      await page.locator('input[name="first_name"]').fill("Jo");
      await page.locator('input[name="phone"]').fill("+44 7700 900123");
      await page.locator('input[name="postcode"]').fill(postcode);
      await page.locator('input[name="tos_accept"]').check();
    };
    await fill("NOT A CODE");
    await submit.click();
    await expect(page.getByRole("alert").filter({ hasText: "Doesn't look like a UK postcode" })).toBeVisible({ timeout: 15_000 });
    const uid = await userId();
    expect(uid).toBeTruthy();
    expect(await companiesOf(uid!), "nothing created on a refused submit").toHaveLength(0);
    // record (not assert) whether the typed answers survived the refusal — see the report
    const kept = await page.locator('input[name="name"]').inputValue();
    test.info().annotations.push({ type: "company-form values after refusal", description: kept === COMPANY ? "kept" : "cleared" });
    console.log(`[onboarding] company-form values after a refused submit: ${kept === COMPANY ? "kept" : "cleared"}`);

    await waitForHydrated(submit);
    await fill("BT15 1AA");
    await submit.click();
    await expect(page).toHaveURL(/\/access-pending/, { timeout: 20_000 });
    await noSidewaysScroll(page, "/access-pending");
    const mine = await companiesOf(uid!);
    expect(mine).toHaveLength(1);
    expect(mine[0].role).toBe("owner");
    expect(mine[0].organizations.name).toBe(COMPANY);
    expect(mine[0].organizations.status).toBe("pending");
    expect(mine[0].organizations.tos_accepted_at).toBeTruthy();
    await page.context().close();
  });

  test("coming back while pending lands on access pending again — no second company", async ({ browser }) => {
    const page = await freshPhone(browser, errors);
    await signIn(page);
    await expect(page).toHaveURL(/\/access-pending/, { timeout: 20_000 });
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/access-pending/);
    expect(await companiesOf((await userId())!)).toHaveLength(1);
    await page.context().close();
  });

  test("once activated, the set-up wizard works on a phone and a skipped step stays skipped", async ({ browser }) => {
    test.setTimeout(90_000);
    const uid = (await userId())!;
    const orgId = (await companiesOf(uid))[0].org_id;
    const act = await db.from("organizations").update({ status: "active" }).eq("id", orgId);
    if (act.error) throw new Error(`activate: ${act.error.message}`);

    const page = await freshPhone(browser, errors);
    await signIn(page);
    await expect(page).not.toHaveURL(/\/login|\/access-pending|\/onboarding\/company/, { timeout: 20_000 });
    await page.goto("/onboarding/setup");
    await expect(page).toHaveURL(/\/onboarding\/setup/);
    await noSidewaysScroll(page, "/onboarding/setup");
    const skip = page.getByRole("button", { name: "Skip for now" }).first();
    await waitForHydrated(skip);
    const before = await page.getByRole("button", { name: "Bring back" }).count();
    await skip.click();
    await expect(page).toHaveURL(/saved=skipped/, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Bring back" })).toHaveCount(before + 1);
    await page.goto("/onboarding/setup");
    await expect(page.getByRole("button", { name: "Bring back" })).toHaveCount(before + 1);
    await noSidewaysScroll(page, "/onboarding/setup after skip");
    await page.context().close();
    expect(errors, "no hydration errors across onboarding").toEqual([]);
  });
});
