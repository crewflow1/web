/* eslint-disable @typescript-eslint/no-explicit-any -- seed scaffolding: the
   generated Database types don't cover the new H&S tables, so the service-role
   seed goes through a loose cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Permit-to-Work (H&S M2) — authenticated journey, no mocks. Uses the seeded
 * storageState (e2e/global-setup.ts). An ISSUED permit + a confirmed control are
 * seeded via service-role, then the OWNER navigates the real app: register →
 * detail, seeing the PTW number, permit type, live status, validity window and
 * the confirmed control. Plus the logged-out boundary.
 *
 * The create/issue/lifecycle WRITE rules are proven at the integration tier
 * (__tests__/integration/health-safety/permits.test.ts — 14 real-Postgres cases,
 * incl. the issue-gate, transition matrix and immutability). The browser WRITE
 * journey below exists for a different reason: permits actions used to call
 * redirect() from the Server Action, and navigations at this route depth lose
 * the Next 15.5 stranded-commit race (measured here: 60% of same-page saves
 * never moved the browser while the row was written — vercel/next.js#83386).
 * The actions now return FormState and <StateForm> document-navigates, and the
 * page.url() assertions after each click pin exactly the behaviour that was
 * broken — if someone converts a permit action back to redirect(), this goes
 * red.
 */

const SLUG = "e2e-harness-org";
const REF = `PTW-E2E-${Date.now()}`;

function svc() {
  return createClient(assertLocalE2eTarget("health-safety-permits.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe("permits — behind the auth wall", () => {
  test("a logged-out visitor is sent to /login", async ({ page }) => {
    await page.goto("/health-safety/permits");
    await expect(page).toHaveURL(/\/login/);
  });
});

/** React has attached a fiber to a form — the client dispatch is live. A
 *  pre-hydration click would fall back to a native document POST and prove
 *  nothing about the client-dispatch navigation under test. */
async function waitForHydratedForm(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => {
    const el = document.querySelector("form");
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
  });
}

test.describe("permits — authenticated write journey lands every navigation", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test("create → edit → add condition → issue: the browser moves after every click", async ({
    page,
  }) => {
    const stamp = Date.now();
    const title = `Hot works — E2E write ${stamp}`;

    // CREATE: /health-safety/permits/new → the new draft's own page.
    await page.goto("/health-safety/permits/new");
    await waitForHydratedForm(page);
    await page.locator('select[name="permitType"]').selectOption("hot_works");
    await page.locator('input[name="title"]').fill(title);
    await page.locator('textarea[name="scope"]').fill("Weld the E2E beam");
    // The issue gate requires a validity window — set it now (visible
    // datetime-local inputs sync their hidden ISO twins client-side).
    await page.locator('input[type="datetime-local"]').first().fill("2026-07-29T08:00");
    await page.locator('input[type="datetime-local"]').last().fill("2099-07-29T18:00");
    await page.getByRole("button", { name: /save draft/i }).click();
    await expect(page).toHaveURL(/\/health-safety\/permits\/[0-9a-f-]{36}\?saved=created/, {
      timeout: 20_000,
    });
    const permitUrl = new URL(page.url());
    const permitId = permitUrl.pathname.split("/").pop()!;
    await expect(page.getByRole("heading", { name: title })).toBeVisible();

    // EDIT: same-route ?saved= swap — the shape that silently stranded 60% of
    // saves before the FormState conversion.
    const edited = `${title} (edited)`;
    await waitForHydratedForm(page);
    await page.locator('input[name="title"]').fill(edited);
    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(page).toHaveURL(
      new RegExp(`/health-safety/permits/${permitId}\\?saved=updated`),
      { timeout: 20_000 },
    );
    await expect(page.getByRole("heading", { name: edited })).toBeVisible();

    // ADD CONDITION (required, so it gates issue — and confirms the smaller
    // inline StateForms dispatch + navigate too).
    await waitForHydratedForm(page);
    await page.locator("input#label").fill("Fire watch in place");
    await page.getByRole("button", { name: /add condition/i }).click();
    await expect(page).toHaveURL(
      new RegExp(`/health-safety/permits/${permitId}\\?saved=condition`),
      { timeout: 20_000 },
    );
    await expect(page.getByText("Fire watch in place").first()).toBeVisible();

    // CONFIRM the condition, then ISSUE — the permit gets its permanent number.
    await waitForHydratedForm(page);
    await page.getByRole("button", { name: /^confirm/i }).first().click();
    await expect(page).toHaveURL(
      new RegExp(`/health-safety/permits/${permitId}\\?saved=condition`),
      { timeout: 20_000 },
    );
    await waitForHydratedForm(page);
    await page.getByRole("button", { name: /issue permit/i }).click();
    await expect(page).toHaveURL(
      new RegExp(`/health-safety/permits/${permitId}\\?saved=issued`),
      { timeout: 20_000 },
    );
    await expect(page.getByText(/PTW-/).first()).toBeVisible();
  });
});

test.describe("permits — authenticated register + detail", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  let permitId = "";
  const TITLE = `Hot works — welding ${Date.now()}`;

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any; auth: { admin: { listUsers: () => Promise<any> } } };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");
    const owner = (await db.from("memberships").select("user_id").eq("org_id", orgId).limit(1).maybeSingle()).data?.user_id;
    // draft permit with a full window
    const p = await db.from("permits_to_work")
      .insert({ org_id: orgId, permit_type: "hot_works", title: TITLE, scope: "Weld the steel beam", location: "Plot 4",
        valid_from: "2026-06-15T08:00:00Z", valid_until: "2099-06-15T16:00:00Z" })
      .select("id").single();
    permitId = String(p.data?.id);
    // a confirmed required control, then issue → active (bypasses the flaky write-POST)
    await db.from("permit_conditions").insert({ org_id: orgId, permit_id: permitId, label: "Fire watch in place", required: true, confirmed: true, confirmed_by: owner ?? null, confirmed_at: new Date().toISOString() });
    await db.from("permits_to_work").update({ status: "issued", reference: REF, issued_at: new Date().toISOString(), issued_by: owner ?? null }).eq("id", permitId);
    await db.from("permits_to_work").update({ status: "active", activated_at: new Date().toISOString() }).eq("id", permitId);
  });

  test("register lists the permit; detail shows the number, type, live status + confirmed control", async ({ page }) => {
    await page.goto("/health-safety/permits");
    await expect(page.getByRole("heading", { name: /permits? to work|health & safety/i }).first()).toBeVisible();
    await expect(page.getByText(TITLE).first()).toBeVisible();

    await page.goto(`/health-safety/permits/${permitId}`);
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
    await expect(page.getByText(REF).first()).toBeVisible();
    await expect(page.getByText(/Hot works/i).first()).toBeVisible();
    // an active, in-window permit reads Active (not expired — valid_until is 2099)
    await expect(page.getByText(/Active/i).first()).toBeVisible();
    // the confirmed control is shown
    await expect(page.getByText("Fire watch in place").first()).toBeVisible();
  });
});
