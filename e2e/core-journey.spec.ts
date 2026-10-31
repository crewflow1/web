import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * CORE CUSTOMER JOURNEY (authenticated OWNER, real browser) — the launch-gate
 * flow a construction owner runs daily, split into small SERIAL tests so each
 * step has its own timeout and asserts PERSISTED state (not a transient banner):
 *
 *   1. lead → customer
 *   2. quote with line items + correct VAT math
 *   3. request approval → self-approve → accept  ⇒ auto Job + draft Invoice
 *   4. assign a staff member to the job (persists)
 *   5. record a payment ⇒ invoice balance/status + dashboard update
 *
 * Verification is EVENT-BASED: `waitForURL` for redirects, `expect.poll` against
 * the database (service-role, LOCAL-only via assertLocalE2eTarget) for persisted
 * state. The only time-based wait is a short post-navigation hydration settle,
 * because several forms are controlled React inputs / client `router.push` and a
 * fill/click before hydration is silently lost (Playwright actionability waits do
 * not cover React hydration).
 *
 * MUST run against a PRODUCTION build (`npm run start`): under `next dev`,
 * Pattern-A `router.push` post-action navigation is dropped (a dev-only artifact).
 */

const svc = createClient(
  assertLocalE2eTarget("core-journey.spec.ts"),
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

type Row = Record<string, unknown>;
async function one(table: string, col: string, val: string): Promise<Row | null> {
  const { data } = await svc.from(table).select("*").eq(col, val).maybeSingle();
  return (data as Row | null) ?? null;
}
async function many(table: string, col: string, val: string): Promise<Row[]> {
  const { data } = await svc.from(table).select("*").eq(col, val);
  return (data as Row[] | null) ?? [];
}

test.use({ storageState: "e2e/.auth/owner.json" });

const TAG = `J${Date.now().toString(36)}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const idOf = (url: string) => url.match(UUID)?.[0] ?? "";

// Shared across the serial chain.
const S: { customerId: string; quoteId: string; jobId: string; invoiceId: string } = {
  customerId: "",
  quoteId: "",
  jobId: "",
  invoiceId: "",
};

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800); // post-navigation React hydration
}
async function gotoReady(page: Page, url: string) {
  await page.goto(url);
  await settle(page);
}
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

test.describe.configure({ mode: "serial" });

test.describe("core customer journey — owner, real browser", () => {
  test("1. lead → customer", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoReady(page, "/leads/new");
    await page.locator('input[name="contact_name"]').fill(`${TAG} Lead Co`);
    await page.locator('input[name="contact_email"]').fill(`${TAG}@lead.test`);
    await submitAndLand(page, "Save lead", new RegExp(`/leads/${UUID.source}`));
    await expect(page.getByRole("heading", { name: `${TAG} Lead Co` })).toBeVisible();

    await page.getByRole("button", { name: /convert to customer/i }).click();
    await page.waitForURL(new RegExp(`/customers/${UUID.source}`));
    S.customerId = idOf(page.url());
    expect(S.customerId).not.toBe("");
    // Persisted: the customer row exists for this org.
    await expect.poll(() => one("customers", "id", S.customerId)).not.toBeNull();
  });

  test("2. quote with line items + correct VAT math", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoReady(page, "/quotes/new");
    await page.locator('select[name="customer_id"]').selectOption(S.customerId);
    // The builder starts with ONE empty line — fill it. qty 2 × £100 @ 20% VAT.
    const desc = page.getByPlaceholder(/supply only/i).first();
    await desc.fill("Supply & fit (test)");
    await expect(desc).toHaveValue("Supply & fit (test)");
    await page.getByLabel(/quantity/i).first().fill("2");
    await page.getByLabel(/unit price/i).first().fill("100");
    // Live totals <dl>: subtotal £200, VAT £40, total £240 (VAT defaults to 20%).
    await expect(page.getByText(/£240\.00/)).toBeVisible();
    await submitAndLand(page, "Save quote", new RegExp(`/quotes/${UUID.source}`));
    S.quoteId = idOf(page.url());
    expect(S.quoteId).not.toBe("");
    // Persisted: a DRAFT quote whose totals the SERVER computed to £240.
    await expect
      .poll(async () => {
        const q = await one("quotes", "id", S.quoteId);
        return q && { status: q.status, total: Number(q.total) };
      })
      .toEqual({ status: "draft", total: 240 });
  });

  test("3. approve → accept ⇒ auto Job + draft Invoice", async ({ page }) => {
    test.setTimeout(90_000);
    await gotoReady(page, `/quotes/${S.quoteId}`);
    await page.getByRole("button", { name: /request approval/i }).click();
    await page.waitForURL(/saved=approval_requested/);
    await settle(page);
    await page.getByRole("button", { name: /^approve$/i }).click();
    await page.waitForURL(/saved=approved/);
    await settle(page);
    await page.getByRole("button", { name: /accept on customer'?s behalf/i }).click();
    await page.waitForURL(/saved=accepted/);

    // Persisted: quote accepted + a job auto-created (quotes.job_id set).
    await expect
      .poll(async () => {
        const q = await one("quotes", "id", S.quoteId);
        return q && { status: q.status, hasJob: !!q.job_id };
      })
      .toEqual({ status: "accepted", hasJob: true });
    const q = await one("quotes", "id", S.quoteId);
    S.jobId = String(q?.job_id ?? "");
    expect(S.jobId).not.toBe("");

    // Persisted: a draft invoice auto-created, linked to the job, totalling £240.
    await expect
      .poll(async () => {
        const invs = await many("invoices", "job_id", S.jobId);
        return invs.length === 1 ? Number(invs[0]!.total) : -1;
      })
      .toBe(240);
    S.invoiceId = String((await many("invoices", "job_id", S.jobId))[0]!.id);
  });

  test("4. assign a staff member to the job (persists)", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoReady(page, `/jobs/${S.jobId}`);
    const sel = page.locator('select[name="assigned_to"]');
    await expect(sel).toBeVisible();
    const values = await sel
      .locator("option")
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v.length > 10));
    expect(values[0], "the job form must offer an assignable staff member").toBeTruthy();
    await sel.selectOption(values[0]!);
    await page.getByRole("button", { name: /save changes/i }).click();
    // Persisted: jobs.assigned_to is now set to a real user.
    await expect
      .poll(async () => {
        const j = await one("jobs", "id", S.jobId);
        return !!j?.assigned_to;
      })
      .toBe(true);
  });

  test("5. record a payment ⇒ invoice balance/status + dashboard", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoReady(page, `/invoices/${S.invoiceId}`);
    // Amount defaults to the outstanding balance (£240); submit as-is.
    await page.locator('input[name="amount"]').first().waitFor();
    await page.getByRole("button", { name: /record payment/i }).click();

    // Persisted: a payment row for the full amount, and the invoice derives paid.
    await expect
      .poll(async () => {
        const pays = await many("invoice_payments", "invoice_id", S.invoiceId);
        return pays.reduce((n, p) => n + Number(p.amount ?? 0), 0);
      })
      .toBe(240);
    await expect
      .poll(async () => (await one("invoices", "id", S.invoiceId))?.status)
      .toBe("paid");

    // Dashboard renders its money tiles for the owner.
    await gotoReady(page, "/dashboard");
    await expect(page.getByText(/cash in this month/i)).toBeVisible();
    await expect(page.getByText(/outstanding/i).first()).toBeVisible();
  });
});
