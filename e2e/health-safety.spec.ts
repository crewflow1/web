import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Health & Safety RAMS (Milestone 1) — authenticated journey, no mocks. Uses the
 * seeded storageState (e2e/global-setup.ts). A draft RAMS + an assessed hazard are
 * seeded via service-role, then the OWNER navigates the real app: register → detail,
 * seeing the hazard, its 5×5 risk band and the (draft-only) Issue control. Plus the
 * logged-out boundary.
 *
 * NOTE: the create/issue *write* server-actions are exercised + proven at the
 * integration tier (__tests__/integration/health-safety + rls, real Postgres). The
 * browser journey here deliberately reads a seeded record — the app middleware's
 * getUser() is known to intermittently bounce authenticated write-POSTs to /login in
 * this local harness (documented in lib/supabase/middleware.ts), so gating CI on a
 * browser write would be flaky; the write path's correctness is not left unproven.
 */

const SLUG = "e2e-harness-org";

function svc() {
  const url = assertLocalE2eTarget("health-safety.spec.ts");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

test.describe("health & safety — behind the auth wall", () => {
  test("a logged-out visitor is sent to /login", async ({ page }) => {
    await page.goto("/health-safety");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("health & safety — authenticated RAMS journey", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  let raId = "";
  const TITLE = `Working at height — scaffold ${Date.now()}`;

  test.beforeAll(async () => {
    const db = svc();
    type Ins = { insert: (r: Record<string, unknown>) => { select: (c: string) => { single: () => Promise<{ data: { id: string } | null }> } } & PromiseLike<{ error: unknown }> };
    const t = (name: string) => (db as unknown as { from: (n: string) => Ins }).from(name);
    const org = await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle();
    const orgId = (org.data as { id: string } | null)?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");
    const ra = await t("risk_assessments")
      .insert({ org_id: orgId, title: TITLE, activity: "Erect scaffold to rear elevation" })
      .select("id").single();
    raId = String(ra.data?.id);
    await t("risk_assessment_hazards")
      .insert({ org_id: orgId, risk_assessment_id: raId, hazard: "Fall from height", likelihood: 4, severity: 5, control_measures: "Edge protection, harness" });
  });

  test("register lists the RAMS; the detail shows the hazard, its risk band, and the Issue control", async ({ page }) => {
    // 1. Register (authenticated GET) lists the seeded draft.
    await page.goto("/health-safety");
    await expect(page.getByRole("heading", { name: /health & safety|risk assessment/i }).first()).toBeVisible();
    const row = page.getByText(TITLE).first();
    await expect(row).toBeVisible();

    // 2. Open the detail page.
    await page.goto(`/health-safety/${raId}`);
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();

    // 3. The assessed hazard renders with its 5×5 rating banded Critical (4×5 = 20).
    //    (.first() — the hazard shows in both the desktop table and the mobile card.)
    await expect(page.getByText("Fall from height").first()).toBeVisible();
    await expect(page.getByText(/Critical/i).first()).toBeVisible();

    // 4. It is still a draft → the Issue control is present (disabled here, as the
    //    seeded RAMS names no assessor). The write path itself — create/add-hazard/
    //    issue + the immutability freeze — is proven at the integration tier (header).
    await expect(page.getByRole("button", { name: /issue risk assessment/i })).toBeVisible();
    // and it is NOT yet numbered / issued
    await expect(page.getByText(/RA-\d+/)).toHaveCount(0);
  });
});
