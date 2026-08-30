/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Final-roadmap-completion smoke (roadmap/final-completion, Waves 1+2).
 *
 * One authenticated pass over every NEW user-facing surface the programme
 * built, against the REAL production build + local Supabase — the same
 * harness the rest of the E2E tier uses (global-setup seeds the owner and
 * mints a real @supabase/ssr storageState).
 *
 * Selectors are pinned to verified markup (never guessed):
 *   - G1 search      → app/api/search/route.ts responds { hits: [...] }
 *   - G2 variations  → jobs/[id]/_variation-request-panel.tsx
 *                      #variation-requests-heading "Variation requests"
 *   - G3 tables      → components/ui/data-table.tsx <table> + aria-sort headers
 *   - G4 charts      → components/ui/charts/frame.tsx SVG role="img"
 *   - reachability   → notifications/page.tsx <h1>Notifications</h1>,
 *                      settings/sso/page.tsx <h1>Single sign-on (SSO)</h1>,
 *                      settings/data-retention/page.tsx <h1>Data retention</h1>
 *
 * The seeded job id is the harness sentinel (global-setup.ts JOB).
 */

const OWNER_STATE = "e2e/.auth/owner.json";
const JOB = "00000000-0000-0000-0000-000000000000";
const SLUG = "e2e-harness-org";
const CUST_NAME = "Final Roadmap Smoke Customer";

function svc() {
  return createClient(
    assertLocalE2eTarget("final-roadmap-smoke.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Idempotent: the G3 assertions need at least one customer row so the list
 *  renders the DataTable (not the empty state). Fixed name, never Date.now(). */
async function seedOneCustomer(): Promise<void> {
  const db = svc() as unknown as { from: (t: string) => any };
  const orgId = (
    await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()
  ).data?.id;
  if (!orgId) throw new Error("seeded org not found — did globalSetup run?");
  const existing = (
    await db.from("customers").select("id").eq("org_id", orgId).eq("name", CUST_NAME).maybeSingle()
  ).data?.id;
  if (!existing) {
    await db.from("customers").insert({ org_id: orgId, name: CUST_NAME });
  }
}

test.describe("final-roadmap smoke — new surfaces (desktop, authenticated)", () => {
  test.use({ storageState: OWNER_STATE });

  test.beforeAll(seedOneCustomer);

  test("G1: the search API answers an authenticated query with a hits array", async ({
    request,
  }) => {
    const res = await request.get("/api/search?q=e2e");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { hits?: unknown };
    expect(Array.isArray(body.hits), "response must carry a hits array").toBe(
      true,
    );
  });

  test("G2: the job workspace renders the variation-requests intake panel", async ({
    page,
  }) => {
    await page.goto(`/jobs/${JOB}`);
    await expect(
      page.locator("#variation-requests-heading"),
    ).toContainText("Variation requests");
  });

  test("G3: the customers list renders the canonical DataTable with sortable headers", async ({
    page,
  }) => {
    await page.goto("/customers");
    const table = page.getByRole("table", { name: "Customers" });
    await expect(table).toBeVisible();
    // At least one column header carries aria-sort (the sortable contract).
    await expect(table.locator("th[aria-sort]").first()).toBeVisible();
  });

  test("G4: the reports home renders at least one accessible SVG chart", async ({
    page,
  }) => {
    await page.goto("/reports");
    await expect(
      page.getByRole("heading", { name: "Reports", exact: true }),
    ).toBeVisible();
    await expect(page.locator('svg[role="img"]').first()).toBeVisible();
  });

  test("reachability: /notifications renders the workspace notifications page", async ({
    page,
  }) => {
    await page.goto("/notifications");
    await expect(
      page.getByRole("heading", { name: /notifications/i }),
    ).toBeVisible();
  });

  test("reachability: /settings/sso renders the SSO activation page", async ({
    page,
  }) => {
    await page.goto("/settings/sso");
    await expect(
      page.getByRole("heading", { name: "Single sign-on (SSO)" }),
    ).toBeVisible();
  });

  test("reachability: /settings/data-retention renders the GDPR data page", async ({
    page,
  }) => {
    await page.goto("/settings/data-retention");
    await expect(
      page.getByRole("heading", { name: "Data retention" }),
    ).toBeVisible();
  });
});

test.describe("final-roadmap smoke — new surfaces at mobile width", () => {
  test.use({
    storageState: OWNER_STATE,
    viewport: { width: 375, height: 812 },
  });

  test.beforeAll(seedOneCustomer);

  test("G3 mobile: the customers list renders the card list below sm (no table)", async ({
    page,
  }) => {
    await page.goto("/customers");
    // DataTable cardsBelow="sm": at 375px the table is hidden and the
    // mobileCard list renders instead — the page must not fall back to a
    // horizontally-scrolling table.
    await expect(
      page.getByRole("heading", { name: "Customers", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("table", { name: "Customers" })).toBeHidden();
  });

  test("G2 mobile: the variation-requests panel is reachable on the job page", async ({
    page,
  }) => {
    await page.goto(`/jobs/${JOB}`);
    await expect(page.locator("#variation-requests-heading")).toBeAttached();
  });

  test("reachability mobile: notifications page renders at 375px", async ({
    page,
  }) => {
    await page.goto("/notifications");
    await expect(
      page.getByRole("heading", { name: /notifications/i }),
    ).toBeVisible();
  });
});
