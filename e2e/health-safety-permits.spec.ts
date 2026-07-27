/* eslint-disable @typescript-eslint/no-explicit-any -- seed scaffolding: the
   generated Database types don't cover the new H&S tables, so the service-role
   seed goes through a loose cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Permit-to-Work (H&S M2) — authenticated journey, no mocks. Uses the seeded
 * storageState (e2e/global-setup.ts). An ISSUED permit + a confirmed control are
 * seeded via service-role, then the OWNER navigates the real app: register →
 * detail, seeing the PTW number, permit type, live status, validity window and
 * the confirmed control. Plus the logged-out boundary.
 *
 * The create/issue/lifecycle WRITE actions are proven at the integration tier
 * (__tests__/integration/health-safety/permits.test.ts — 14 real-Postgres cases,
 * incl. the issue-gate, transition matrix and immutability). The browser journey
 * reads a seeded record: the app middleware's getUser() intermittently bounces
 * authenticated write-POSTs to /login in this local harness (documented in
 * lib/supabase/middleware.ts; an existing action reproduces it; not our code),
 * so gating CI on a browser write would be flaky.
 */

const SLUG = "e2e-harness-org";
const REF = `PTW-E2E-${Date.now()}`;

function svc() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe("permits — behind the auth wall", () => {
  test("a logged-out visitor is sent to /login", async ({ page }) => {
    await page.goto("/health-safety/permits");
    await expect(page).toHaveURL(/\/login/);
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
