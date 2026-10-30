import { test, expect, type Page } from "@playwright/test";

/**
 * CORE CUSTOMER FUNNEL (authenticated OWNER, real browser) — the top of the
 * launch-gate journey a construction owner runs daily:
 *
 *   Lead → Customer → Quote (line items + VAT math).
 *
 * Driven as the seeded OWNER (globalSetup mints owner.json in the active
 * "E2E Co" org). This is the first end-to-end AUTHENTICATED journey spec — the
 * other e2e specs cover auth walls and surface reachability, not a logged-in
 * create flow with a real calculation assertion.
 *
 * The REMAINDER of the journey (quote approval → accept → auto job + draft
 * invoice → staff assignment → progress → payment → dashboard) was VERIFIED
 * WORKING by hand against a production build during the launch-journey review
 * (2026-10-30): accepting an approved quote auto-created the Job and a draft
 * Invoice, the "View linked job" link resolved, and job staff-assignment
 * persisted to `jobs.assigned_to` (confirmed in the DB). It is kept below as a
 * documented `test.fixme` rather than an asserted test because the full 9-step
 * flow crosses three different form-navigation patterns (useActionState SPA nav,
 * server-action `redirect(?saved=)`, and `fetch()`→push) and needs robust
 * event-based waits (not hydration settles) before it is a stable CI gate.
 * Hardening it into a reliable end-to-end gate is tracked as follow-up.
 *
 * NOTE for runners: the full flow must run against a PRODUCTION build
 * (`npm run start`), not `next dev` — under dev, `router.push`-based post-action
 * navigation (Pattern A) is dropped, which is a dev-only artifact.
 */

test.use({ storageState: "e2e/.auth/owner.json" });

const TAG = `J${Date.now().toString(36)}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** Navigate and wait for the client form to HYDRATE before interacting — several
 *  forms are controlled React inputs / use client router.push, so a fill or click
 *  before hydration is silently lost. networkidle + a short settle is the reliable
 *  signal here (Playwright's actionability waits do not cover React hydration). */
async function gotoReady(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
}

/** Click a submit button by its exact label, then land on the redirect URL or
 *  surface the form validation error (so a failure names the cause). */
async function submitAndLand(page: Page, label: string, urlRe: RegExp) {
  await page.getByRole("button", { name: label }).click();
  try {
    await page.waitForURL(urlRe, { timeout: 30_000 });
  } catch {
    const alerts = (await page.locator('[role="alert"]').allTextContents())
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" | ");
    throw new Error(`"${label}" did not navigate to ${urlRe} (alerts: ${alerts || "none"})`);
  }
}

test("owner: lead → customer → quote with correct VAT math", async ({ page }) => {
  test.setTimeout(90_000);

  await test.step("1. create a lead", async () => {
    await gotoReady(page, "/leads/new");
    await page.locator('input[name="contact_name"]').fill(`${TAG} Lead Co`);
    await page.locator('input[name="contact_email"]').fill(`${TAG}@lead.test`);
    await submitAndLand(page, "Save lead", new RegExp(`/leads/${UUID.source}`));
    await expect(page.getByRole("heading", { name: `${TAG} Lead Co` })).toBeVisible();
  });

  await test.step("2. convert the lead to a customer", async () => {
    await page.getByRole("button", { name: /convert to customer/i }).click();
    await page.waitForURL(new RegExp(`/customers/${UUID.source}`));
    await expect(page.getByRole("heading", { name: `${TAG} Lead Co` })).toBeVisible();
  });

  await test.step("3. create a quote; VAT + total compute (2 × £100 @ 20% = £240)", async () => {
    await gotoReady(page, "/quotes/new");
    const cust = page.locator('select[name="customer_id"]');
    const opts = await cust.locator("option").allTextContents();
    const ci = opts.findIndex((o) => o.includes(TAG));
    expect(ci, "the new customer must be selectable in the quote builder").toBeGreaterThan(-1);
    await cust.selectOption({ index: ci });
    // The builder starts with ONE empty line — fill it (a second would be empty).
    const desc = page.getByPlaceholder(/supply only/i).first();
    await desc.fill("Supply & fit (test)");
    await expect(desc).toHaveValue("Supply & fit (test)");
    await page.getByLabel(/quantity/i).first().fill("2");
    await page.getByLabel(/unit price/i).first().fill("100");
    // VAT defaults to 20% on a new line, so 2 × £100 → subtotal £200, VAT £40.
    // The live totals <dl>: total £240.
    await expect(page.getByText(/£240\.00/)).toBeVisible();
    await submitAndLand(page, "Save quote", new RegExp(`/quotes/${UUID.source}`));
    await expect(page.getByText(/draft/i).first()).toBeVisible();
  });
});

/**
 * FULL fulfilment tail — VERIFIED MANUALLY (see file header); kept as a fixme
 * harness pending robust-wait hardening for CI. Do not delete: it documents the
 * exact selectors/patterns for the accept→job→invoice→payment→dashboard flow.
 */
test.fixme(
  "owner: approve → accept (auto job + invoice) → assign → progress → payment → dashboard",
  () => {
    // Verified by hand 2026-10-30 against a production build:
    //  4. Request approval → Approve (owner self-approve) → Accept on customer's
    //     behalf  (quote detail, Pattern-B redirect ?saved=approved/accepted).
    //  5. Accept auto-creates the Job + a draft Invoice; "View linked job →"
    //     resolves to /jobs/<id>.
    //  6. assigned_to <select> on the job form → Save changes persists the
    //     assignment (confirmed in jobs.assigned_to).
    //  7. Progress: percent input → Record → ?saved=progress.
    //  8. /invoices → open the auto-created invoice → Record payment.
    //  9. /dashboard shows "Cash in this month" / "Accepted this month" tiles.
  },
);
