import { test, expect } from "@playwright/test";

/**
 * Role-access boundary E2E — Phase-8 authenticated verification.
 *
 * The security-hardening program's #1 priority is that typing a URL cannot
 * grant access a role should not have. The server guards are unit/integration
 * tested, but this proves the boundary end-to-end in a REAL browser against the
 * REAL production build (`next start`) + the REAL Supabase local stack, using
 * the harness's seeded sessions (e2e/global-setup.ts):
 *
 *   - staff.json → a `staff` member of the seeded org (dedicated; never signed
 *     out, unlike second/third.json which the logout specs revoke).
 *   - owner.json → an `owner` of the seeded org who is NOT on the super-admin
 *     allowlist.
 *
 * Scope note: only the management surfaces that REDIRECT (requireManagement*)
 * are asserted here. Pages that instead render an inline access-denied panel
 * (e.g. /settings/api-keys) keep the same URL, so they need a content assertion
 * rather than a URL one and are out of scope for this boundary spec.
 */

/**
 * Management-only surfaces whose segment layout (requireManagementContext)
 * already redirects a non-owner/admin on `main`. (Billing joins this list once
 * PR #947 — which switches /settings/billing to requireManagementContext —
 * merges; until then it renders a buttons-hidden page, so asserting it here
 * would fail on a branch that doesn't carry that fix.)
 */
const MANAGEMENT_REDIRECT_PAGES = [
  { path: "/quotes", name: "Quotes" },
  { path: "/invoices", name: "Invoices" },
];

test.describe("a staff member cannot reach management-only pages by URL", () => {
  test.use({ storageState: "e2e/.auth/staff.json" });

  for (const { path, name } of MANAGEMENT_REDIRECT_PAGES) {
    test(`${name} (${path}) bounces staff to their own home`, async ({ page }) => {
      await page.goto(path);
      // requireManagementContext() redirects a non-owner/admin to
      // /dashboard?error=forbidden, and /dashboard itself forwards a `staff`
      // member on to /me — so a real browser lands on /me, never on the
      // management surface. One assertion proves both: arrived at /me…
      await expect(page).toHaveURL(/\/me(\?|\/|$)/);
      // …and did NOT stay on the requested management path.
      await expect(page).not.toHaveURL(
        new RegExp(path.replace(/[/]/g, "\\/")),
      );
    });
  }

  test("staff CAN reach their own day at /me (positive control)", async ({
    page,
  }) => {
    await page.goto("/me");
    await expect(page).toHaveURL(/\/me(\?|\/|$)/);
  });
});

/**
 * LEAST-PRIVILEGE ENFORCEMENT (2026-11-14). Pages the navigation hides from
 * `staff` that used to render for a staff member who typed the URL (UI-coverage
 * finding S-3 / register ST-11) — now behind a server-side guard: a capability
 * segment layout (requireCapability → staff never hold one) or the management
 * role. Decision table: docs/programme/security-least-privilege/.
 *
 * Every entry redirects exactly like the existing management pages:
 * /dashboard?error=forbidden → /me for a staff member.
 */
const STAFF_DENIED_PAGES = [
  // company financial data
  { path: "/purchase-orders/matching", name: "Bill matching (ordered / received / invoiced £)" },
  { path: "/stock/valuation", name: "Stock valuation" },
  { path: "/variations", name: "Variations register (priced scope changes)" },
  // purchase orders + suppliers
  { path: "/purchase-orders", name: "Purchase orders" },
  { path: "/purchase-orders/new", name: "New purchase order" },
  { path: "/suppliers", name: "Suppliers" },
  { path: "/suppliers/new", name: "New supplier" },
  { path: "/suppliers/compare", name: "Compare suppliers" },
  // stock, assets, fleet, sites, operations
  { path: "/stock/items/new", name: "New stock item" },
  { path: "/assets", name: "Assets" },
  { path: "/assets/new", name: "New asset" },
  { path: "/assets/templates", name: "Asset inspection templates" },
  { path: "/fleet", name: "Fleet" },
  { path: "/fleet/vehicles/new", name: "New vehicle" },
  { path: "/sites", name: "Sites" },
  { path: "/operations", name: "Operations overview" },
  // other people's personal data / administrative functions
  { path: "/settings/ai-features", name: "Company AI switch" },
  { path: "/staff", name: "Staff roster" },
  { path: "/reviews", name: "Reviews" },
  { path: "/reviews/new", name: "Request a review" },
  { path: "/onboarding/setup", name: "Organisation set-up wizard" },
  // D-17: the 18 previously member-gated routes that are management-only
  { path: "/documents", name: "Document library" },
  { path: "/compliance", name: "Compliance documents (insurance, contracts)" },
  { path: "/jobs/new", name: "Create a job" },
  { path: "/jobs/templates", name: "Job templates" },
  { path: "/staff/rota/generate", name: "Rota generator" },
  { path: "/staff/rota/conflicts", name: "Rota conflicts" },
  { path: "/health-safety/worker-links", name: "H&S worker links" },
  { path: "/expenses", name: "Expenses register" },
  { path: "/stock/replenishment", name: "Stock replenishment" },
  { path: "/assets/calibration", name: "Asset calibration" },
];

/** What staff must KEEP: their own information and the site-side working surfaces. */
const STAFF_ALLOWED_PAGES = [
  { path: "/jobs", name: "Jobs (assigned)" },
  { path: "/staff/leave", name: "Own leave" },
  { path: "/settings", name: "Own profile" },
  { path: "/notifications", name: "Own notifications" },
  { path: "/toolbox", name: "Toolbox talks" },
  { path: "/diary", name: "Site diary" },
  { path: "/materials/requests", name: "Materials requests (own)" },
  // D-17 field duties: ordinary construction workflows staff must keep
  { path: "/stock", name: "Stock (issue, transfer, count)" },
  { path: "/stock/stocktake", name: "Stock counts" },
  { path: "/stock/vans", name: "Van stock" },
  { path: "/fleet/fuel", name: "Fuel log" },
  { path: "/fleet/vehicles", name: "Vehicle list (log a fill)" },
  { path: "/assets/scan", name: "Asset QR scan" },
  { path: "/health-safety", name: "H&S documents (draft / complete)" },
  { path: "/site-reports", name: "Site reports" },
  { path: "/weather", name: "Weather" },
  { path: "/expenses/new", name: "Submit a pending job cost" },
  { path: "/staff/rota", name: "Team rota (relevant schedules)" },
];

test.describe("least privilege — nav-hidden pages are blocked for staff by the server", () => {
  test.use({ storageState: "e2e/.auth/staff.json" });

  for (const { path, name } of STAFF_DENIED_PAGES) {
    test(`${name} (${path}) bounces staff to their own home`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/me(\?|\/|$)/);
    });
  }

  for (const { path, name } of STAFF_ALLOWED_PAGES) {
    test(`staff KEEP ${name} (${path})`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status(), `${path} should render for staff`).toBeLessThan(400);
      await expect(page).toHaveURL(new RegExp(path.replace(/[/]/g, "\\/") + "(\\?|\\/|$)"));
    });
  }

  test("a colleague's profile is refused; staff are sent home", async ({ page, browser }) => {
    // Find a colleague's user id as the OWNER (the roster is management-only now).
    const ownerCtx = await browser.newContext({ storageState: "e2e/.auth/owner.json" });
    const ownerPage = await ownerCtx.newPage();
    await ownerPage.goto("/staff");
    await expect(ownerPage).toHaveURL(/\/staff(\?|$)/);
    const hrefs = await ownerPage.locator('a[href^="/staff/"]').evaluateAll((as) =>
      as.map((a) => a.getAttribute("href") ?? "").filter((h) => /^\/staff\/[0-9a-f-]{36}$/.test(h)),
    );
    await ownerCtx.close();
    expect(hrefs.length, "the owner sees the roster with member links").toBeGreaterThan(1);

    // As staff: every profile that is not their own redirects home; exactly one
    // (their own) renders.
    let own = 0;
    for (const href of [...new Set(hrefs)]) {
      // A refused profile streams a shell and then redirects (/dashboard → /me), so
      // goto's own promise proves nothing (and can surface ERR_ABORTED when the
      // chain supersedes it). Judge by where the page SETTLES: either the profile
      // body renders (its "Performance" section) or the browser lands on /me.
      await page.goto(href).catch(() => undefined);
      const settled: { outcome: "" | "home" | "profile" } = { outcome: "" };
      await expect
        .poll(
          async () => {
            const path = new URL(page.url()).pathname;
            if (path === "/me") return (settled.outcome = "home");
            const body = await page.getByRole("heading", { name: "Performance" }).count().catch(() => 0);
            if (path === href && body > 0) return (settled.outcome = "profile");
            return "";
          },
          { timeout: 30_000 },
        )
        .not.toBe("");
      if (settled.outcome === "profile") own += 1;
    }
    expect(own, "staff can open exactly their OWN profile").toBe(1);
  });
});

test.describe("least privilege — the owner keeps every gated page", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  for (const path of ["/purchase-orders", "/purchase-orders/matching", "/suppliers", "/stock", "/stock/valuation", "/assets", "/fleet", "/sites", "/operations", "/staff", "/reviews", "/variations"]) {
    test(`owner still opens ${path}`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBeLessThan(400);
      await expect(page).toHaveURL(new RegExp(path.replace(/[/]/g, "\\/") + "(\\?|$)"));
    });
  }
});

test.describe("a non-super-admin cannot reach CrewFlow HQ", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test("an org owner (not on the super-admin allowlist) gets 404 on /admin", async ({
    page,
  }) => {
    const res = await page.goto("/admin");
    // requireHqPage() → notFound() for a non-allowlisted user: a 404, never a
    // redirect and never the HQ surface (an HQ page must not announce itself).
    expect(res?.status()).toBe(404);
  });
});
