/* eslint-disable @typescript-eslint/no-explicit-any -- service-role admin client + mail-catcher JSON */
import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";

/**
 * Account recovery and sign-up, end to end in a real browser — no mocks.
 *
 *   • PASSWORD RECOVERY: a real user asks for a reset on /reset-password, the REAL email that
 *     Supabase Auth sends is read from the local mail catcher, its link is opened in the same
 *     browser, /auth/callback establishes the recovery session, the user sets a new password on
 *     /update-password — and then the NEW password signs in and the OLD one does not.
 *   • An unknown address gets the same neutral message and NO email (no account enumeration).
 *   • A recovery link cannot be used twice.
 *   • SIGN-UP: a new person creates an account with a password and lands in onboarding to
 *     create their company — as the right auth user, with no company and no access yet.
 *
 * ONE HOP IS BRIDGED, and only because of the local harness: the emailed link goes to the Auth
 * server, which redirects back to the site with a one-time code. Locally the Auth server's site
 * host is 127.0.0.1 while `next start` serves (and sets cookies for) localhost, so the browser
 * would arrive on a host that does not hold the request's verifier cookie. The spec therefore
 * asks the Auth server for that redirect itself (consuming the emailed token exactly as a click
 * would), takes the one-time code from it, and opens the app's own /auth/callback with it. In
 * production the two hosts are the same and this hop is an ordinary redirect. Everything on
 * the app side is real: the request, the email, the callback's code exchange against the
 * verifier cookie, the recovery session, the password change.
 * Email CONFIRMATION on sign-up is a hosted-project setting (off in the local stack): the
 * confirmation link lands on the same /auth/callback route that the recovery test proves.
 */
const MAIL = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:54324";
const TAG = `auth${Date.now().toString(36)}`;
const OLD_PW = `Old-${crypto.randomUUID()}`;
const NEW_PW = `New-${crypto.randomUUID()}`;
const RECOVER_EMAIL = `recover-${TAG}@example.test`;
const SIGNUP_EMAIL = `signup-${TAG}@example.test`;
const GHOST_EMAIL = `nobody-${TAG}@example.test`;

function svc() {
  return createClient(assertLocalE2eTarget("auth-recovery-and-signup.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as any;
}

async function mailTo(address: string): Promise<any[]> {
  const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
  if (!res.ok) throw new Error(`mail catcher search failed: ${res.status}`);
  return ((await res.json()) as any).messages ?? [];
}
async function firstLinkIn(messageId: string): Promise<string> {
  const msg = (await (await fetch(`${MAIL}/api/v1/message/${messageId}`)).json()) as any;
  const body = `${msg.HTML ?? ""}\n${msg.Text ?? ""}`;
  const m = body.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify[^\s"'<>]+/);
  if (!m) throw new Error("no verification link in the recovery email");
  return m[0].replace(/&amp;/g, "&");
}
/** Follow the emailed link as far as the Auth server's redirect and return its one-time code. */
async function codeFromEmailLink(link: string): Promise<{ code: string | null; location: string }> {
  const res = await fetch(link, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  let code: string | null = null;
  try { code = new URL(location).searchParams.get("code"); } catch { /* no redirect */ }
  return { code, location };
}
async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  const submit = page.getByRole("button", { name: "Sign in", exact: true }).last();
  await waitForHydrated(submit);
  await page.locator('input[name="email"]').last().fill(email);
  await page.locator('input[name="password"]').fill(password);
  await submit.click();
}

test.describe.configure({ mode: "serial" });
test.describe("account recovery and sign-up (browser, real email)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const db = svc();
  let userId = "";
  let usedLink = "";

  test.beforeAll(async () => {
    const u = await db.auth.admin.createUser({ email: RECOVER_EMAIL, password: OLD_PW, email_confirm: true });
    if (u.error || !u.data.user) throw new Error(`user: ${u.error?.message}`);
    userId = u.data.user.id;
  });
  test.afterAll(async () => {
    if (userId) await db.auth.admin.deleteUser(userId);
    const list = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const s = list.data?.users?.find((x: any) => x.email === SIGNUP_EMAIL);
    if (s) {
      const owned = (await db.from("memberships").select("org_id").eq("user_id", s.id)).data ?? [];
      for (const m of owned) await db.from("organizations").delete().eq("id", m.org_id);
      await db.auth.admin.deleteUser(s.id);
    }
  });

  test("password recovery: request → real email → link → new password; the new password signs in, the old one does not", async ({ page, baseURL }) => {
    test.setTimeout(90_000);

    await page.goto("/reset-password");
    const send = page.locator('form button[type="submit"]');
    await waitForHydrated(send);
    await page.locator('input[name="email"]').fill(RECOVER_EMAIL);
    await send.click();
    await expect(page.getByText(/If an account exists for that email/)).toBeVisible();

    // the real email arrives in the mail catcher
    await expect.poll(async () => (await mailTo(RECOVER_EMAIL)).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const [message] = await mailTo(RECOVER_EMAIL);
    usedLink = await firstLinkIn(message.ID);

    // the link is good for one code; the app's callback exchanges it and lands on the
    // set-a-new-password page, signed in
    const { code, location } = await codeFromEmailLink(usedLink);
    expect(code, `the Auth server redirects back with a one-time code (got: ${location.split("?")[0]})`).toBeTruthy();
    await page.goto(`/auth/callback?code=${encodeURIComponent(code!)}&next=/update-password`);
    await expect(page).toHaveURL(/\/update-password/);
    const save = page.locator('form button[type="submit"]');
    await waitForHydrated(save);
    await page.locator('input[name="password"]').fill(NEW_PW);
    await page.locator('input[name="confirm"]').fill(NEW_PW);
    await save.click();
    await expect(page).not.toHaveURL(/\/update-password/, { timeout: 15_000 });
    await expect(page).not.toHaveURL(/\/login/);

    // a fresh browser: the OLD password is refused, the NEW one signs in
    const fresh = await page.context().browser()!.newContext({ baseURL: baseURL!, storageState: { cookies: [], origins: [] } });
    const p2 = await fresh.newPage();
    await signIn(p2, RECOVER_EMAIL, OLD_PW);
    await expect(p2.getByRole("alert").filter({ hasText: /.+/ }).first()).toBeVisible();
    await expect(p2).toHaveURL(/\/login/);
    await signIn(p2, RECOVER_EMAIL, NEW_PW);
    await expect(p2).not.toHaveURL(/\/login/, { timeout: 15_000 });
    await fresh.close();
  });

  test("a used recovery link cannot be used again", async ({ browser, baseURL }) => {
    test.skip(!usedLink, "depends on the recovery test");
    const again = await codeFromEmailLink(usedLink);
    expect(again.code, "a second use of the emailed link yields no code").toBeNull();
    expect(again.location).toMatch(/error/);
    const ctx = await browser.newContext({ baseURL: baseURL!, storageState: { cookies: [], origins: [] } });
    const p = await ctx.newPage();
    await p.goto("/update-password");
    await expect(p).toHaveURL(/\/login|\/reset-password/);
    await ctx.close();
  });

  test("an unknown address gets the same message and no email (no account enumeration)", async ({ page }) => {
    await page.goto("/reset-password");
    const send = page.locator('form button[type="submit"]');
    await waitForHydrated(send);
    await page.locator('input[name="email"]').fill(GHOST_EMAIL);
    await send.click();
    await expect(page.getByText(/If an account exists for that email/)).toBeVisible();
    await page.waitForTimeout(3_000);
    expect(await mailTo(GHOST_EMAIL)).toHaveLength(0);
  });

  test("sign-up: a new person creates an account and lands in onboarding with no company and no access", async ({ page }) => {
    await page.goto("/login");
    const tab = page.getByRole("button", { name: "Create account" }).first();
    await waitForHydrated(tab);
    await tab.click();
    await page.locator('input[name="email"]').last().fill(SIGNUP_EMAIL);
    await page.locator('input[name="password"]').fill(NEW_PW);
    await page.locator('input[name="confirm"]').fill(NEW_PW);
    await page.getByRole("button", { name: "Create account", exact: true }).last().click();
    await expect(page).toHaveURL(/\/onboarding\/company|\/check-email/, { timeout: 15_000 });

    const list = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const created = list.data.users.find((x: any) => x.email === SIGNUP_EMAIL);
    expect(created, "the auth user exists").toBeTruthy();
    const memberships = (await db.from("memberships").select("org_id").eq("user_id", created.id)).data ?? [];
    expect(memberships, "no company and no membership until onboarding is completed").toHaveLength(0);
    // no company ⇒ no way into the product
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/onboarding\/company|\/check-email|\/login/);
  });
});
