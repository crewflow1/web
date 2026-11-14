import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { rmSync } from "node:fs";
import { mintState, asActor } from "./_actors";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";
import { waitForHydrated } from "./_hydration";

/**
 * Subscription cancellation — the owner's journey, in a real browser.
 *
 * Runs against the local stack with NO Stripe key configured, so the workspace
 * under test has no card subscription and the cancellation is the LOCAL-ONLY
 * path (nothing in Stripe to terminate). That is a real production case — a
 * founder-provisioned trial — and it exercises every part of the UI flow: the
 * control, the single confirmation step, the navigation out of the product
 * shell, and what a cancelled owner can still reach. The Stripe leg is covered
 * with a mocked client in __tests__/billing and __tests__/integration/stripe.
 *
 * ISOLATION. The local database and the harness's seeded org (global-setup) are
 * SHARED with other suites, and this spec cancels a workspace — so it never
 * touches the seeded org. It creates its own org, its own owner and its own
 * staff member, and deletes all three afterwards.
 */

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const TAG = `cancel-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const ORG_NAME = `Cancel E2E ${TAG}`;
const PASSWORD = `Pw-${TAG}-${Math.random().toString(36).slice(2)}`;
const OWNER_EMAIL = `${TAG}-owner@crewflow.test`;
const STAFF_EMAIL = `${TAG}-staff@crewflow.test`;
const OWNER_STATE = `e2e/.auth/${TAG}-owner.json`;
const STAFF_STATE = `e2e/.auth/${TAG}-staff.json`;

function service() {
  // The URL comes FROM the guard: it refuses anything but a local database.
  const url = assertLocalE2eTarget("billing-cancellation.spec.ts");
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loose = (c: unknown) => c as { from(t: string): any };

let orgId = "";
const userIds: string[] = [];

/**
 * Review screenshots (desktop + 390px) — written ONLY when
 * CANCEL_E2E_SCREENSHOTS=1, so a normal/CI run leaves the tree untouched.
 */
const SHOTS = process.env.CANCEL_E2E_SCREENSHOTS === "1";
async function shots(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  const dir = "docs/programme/cancellation/screens";
  const original = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${dir}/${name}-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${dir}/${name}-390.png`, fullPage: true });
  await page.setViewportSize(original);
}

async function orgStatus(): Promise<string> {
  const { data, error } = await loose(service()).from("organizations").select("status").eq("id", orgId).single();
  if (error) throw new Error(error.message);
  return data.status as string;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const svc = service();
  const db = loose(svc);
  const org = await db
    .from("organizations")
    .insert({ name: ORG_NAME, slug: TAG, status: "active", onboarding_state: { completed_at: new Date().toISOString() } })
    .select("id")
    .single();
  if (org.error) throw new Error(`[cancel e2e] org seed failed: ${org.error.message}`);
  orgId = org.data.id as string;

  for (const [email, role, name] of [
    [OWNER_EMAIL, "owner", "Cancel E2E Owner"],
    [STAFF_EMAIL, "staff", "Cancel E2E Staff"],
  ] as const) {
    const created = await svc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    const id = created.data.user?.id;
    if (!id) throw new Error(`[cancel e2e] user seed failed for ${role}: ${created.error?.message}`);
    userIds.push(id);
    const u = await db.from("users").upsert({ id, email, full_name: name });
    if (u.error) throw new Error(u.error.message);
    const m = await db.from("memberships").insert({ org_id: orgId, user_id: id, role });
    if (m.error) throw new Error(m.error.message);
  }
  await mintState(OWNER_EMAIL, PASSWORD, OWNER_STATE);
  await mintState(STAFF_EMAIL, PASSWORD, STAFF_STATE);
});

test.afterAll(async () => {
  const svc = service();
  if (orgId) await loose(svc).from("organizations").delete().eq("id", orgId);
  for (const id of userIds) {
    await loose(svc).from("users").delete().eq("id", id);
    await svc.auth.admin.deleteUser(id);
  }
  for (const f of [OWNER_STATE, STAFF_STATE]) rmSync(f, { force: true });
});

test("staff are not offered — and cannot reach — the cancel control", async ({ browser }) => {
  await asActor(browser, STAFF_STATE, async (page) => {
    await page.goto("/settings/billing");
    await expect(page).not.toHaveURL(/\/settings\/billing/);
    await expect(page.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
  });
  expect(await orgStatus()).toBe("active");
});

test("owner: the confirmation step is honest, and 'Keep subscription' changes nothing", async ({ browser }) => {
  await asActor(browser, OWNER_STATE, async (page) => {
    await page.goto("/settings/billing");
    await expect(page.getByRole("heading", { name: "Cancel subscription" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Invoices & receipts" })).toBeVisible();

    const trigger = page.getByRole("button", { name: "Cancel subscription", exact: true });
    await waitForHydrated(trigger);
    await trigger.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: `Cancel CrewFlow for ${ORG_NAME}?` })).toBeVisible();
    // What stops, payments, data — stated before anything happens.
    await expect(dialog).toContainText("Your subscription ends immediately");
    await expect(dialog).toContainText("nothing further to charge");
    await expect(dialog).toContainText("Your data isn't deleted when you cancel");
    await expect(dialog.getByRole("link", { name: "Download an export now" })).toBeVisible();
    // The reason is optional and labelled so.
    await expect(dialog.getByLabel(/Why are you cancelling\?\s*Optional/)).toBeVisible();
    // Focus opens on the SAFE action.
    await expect(dialog.getByRole("button", { name: "Keep subscription" })).toBeFocused();

    await settleForAxe(page);
    const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(axe.violations, axe.violations.map((v) => `${v.id}: ${v.help}`).join("\n")).toEqual([]);

    await shots(page, "settings-billing-cancel-dialog");

    await dialog.getByRole("button", { name: "Keep subscription" }).click();
    await expect(dialog).toBeHidden();
  });
  expect(await orgStatus()).toBe("active");
});

test("owner: cancel in three clicks → confirmation, then invoices, export and reactivation stay reachable", async ({ browser }) => {
  await asActor(browser, OWNER_STATE, async (page) => {
    await page.goto("/settings/billing");
    const trigger = page.getByRole("button", { name: "Cancel subscription", exact: true });
    await waitForHydrated(trigger);
    await trigger.click(); // click 1
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/Why are you cancelling/).fill("e2e: closing the company");
    await dialog.getByRole("button", { name: "Cancel subscription now" }).click(); // click 2 (the only confirmation)

    // Full navigation out of the product shell to the owner's billing page.
    await page.waitForURL(/\/account\/billing\?cancelled=1/);
    await expect(page.getByRole("status")).toContainText("Your subscription is cancelled.");
    await expect(page.getByRole("heading", { name: /^Subscription cancelled/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Invoices & receipts" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download data export" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask to reactivate" })).toBeVisible();

    await settleForAxe(page);
    const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(axe.violations, axe.violations.map((v) => `${v.id}: ${v.help}`).join("\n")).toEqual([]);

    await shots(page, "account-billing-cancelled");

    // Entitlement is really revoked…
    expect(await orgStatus()).toBe("cancelled");
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/access-pending/);
    await expect(page.getByText("Subscription cancelled", { exact: true })).toBeVisible();
    await page.goto("/settings/billing");
    await expect(page).toHaveURL(/\/access-pending/);

    // …but the lock screen is not a dead end for the owner.
    await page.getByRole("link", { name: "Invoices, data export & reactivation" }).click();
    await expect(page).toHaveURL(/\/account\/billing/);

    // Data export still works after cancellation.
    const exp = await page.request.get("/api/account/export");
    expect(exp.status()).toBe(200);
    expect(exp.headers()["content-type"]).toBe("application/zip");
    expect((await exp.body()).subarray(0, 2).toString()).toBe("PK");

    // Reactivation is a request, and says so.
    const ask = page.getByRole("button", { name: "Ask to reactivate" });
    await waitForHydrated(ask);
    await ask.click();
    await expect(page.getByText("We've got your request.")).toBeVisible();
    // It survives a reload (recorded server-side), and changes no state.
    await page.reload();
    await expect(page.getByText("We've got your request.")).toBeVisible();
    expect(await orgStatus()).toBe("cancelled");
  });
});

test("after cancellation: staff get the lock screen only — no billing page, no export", async ({ browser }) => {
  await asActor(browser, STAFF_STATE, async (page) => {
    await page.goto("/account/billing");
    await expect(page).toHaveURL(/\/access-pending/);
    await expect(page.getByRole("link", { name: /Invoices, data export/ })).toHaveCount(0);
    await expect(page.getByText("speak to your company's account owner")).toBeVisible();
    const exp = await page.request.get("/api/account/export");
    expect(exp.status()).toBe(403);
  });
});

test("anonymous visitors reach neither the billing page nor the export", async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto("/account/billing");
    await expect(page).toHaveURL(/\/login/);
    const exp = await ctx.request.get("/api/account/export", { maxRedirects: 0 });
    expect([307, 401]).toContain(exp.status());
  } finally {
    await ctx.close();
  }
});
