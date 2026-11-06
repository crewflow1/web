import { test, expect, type Page, type Browser } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { mintState, asActor } from "./_actors";

/**
 * CORE CUSTOMER JOURNEY (authenticated OWNER, real browser) — the launch-gate
 * flow a construction owner runs daily, split into small SERIAL tests so each
 * step has its own timeout and asserts PERSISTED state (not a transient banner):
 *
 *   1. lead → customer
 *   2. quote with line items + correct VAT math
 *   3. request approval → approve (distinct admin approver) → accept ⇒ auto Job + draft Invoice
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
/**
 * Pick a customer in the shared CustomerCombobox typeahead (replaced the old
 * <select name="customer_id">). Types a term, then clicks the option whose
 * label contains `matchName`. The combobox debounces + hits
 * /api/customers/search, so the option is awaited (Playwright auto-waits).
 */
async function pickCustomer(page: Page, typeText: string, matchName: string) {
  const box = page.getByRole("combobox", { name: /customer/i });
  await box.click();
  await box.fill(typeText);
  await page.getByRole("option", { name: new RegExp(matchName) }).first().click();
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

// --- Separation-of-duties approver (step 3) -------------------------------
// The seeded org is SHARED and other specs (first-customer-sim) add a second
// owner/admin approver to it, so the owner can no longer self-approve their own
// quote (a control we must NOT weaken). Rather than depend on the org having a
// single approver, this spec seeds its OWN dedicated admin approver (granted
// quotes:manage) and approves THROUGH them — the real two-approver flow — so the
// step is deterministic regardless of what else is in the org.
const PASSWORD = "E2e-Harness-Pw-2f9c1a"; // local-only synthetic credential (matches global-setup)
const SLUG = "e2e-harness-org";
const APPROVER_EMAIL = "e2e-core-approver@crewflow.test";
const APPROVER_STATE = "e2e/.auth/core-approver.json";
let APPROVER_ORG_ID = "";

/** Idempotently seed a dedicated admin approver with quotes:manage, and mint its session. */
async function seedApprover(): Promise<void> {
  const org = (await svc.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data as
    | { id: string }
    | null;
  if (!org?.id) throw new Error("[core-journey] seeded org not found — did globalSetup run?");
  APPROVER_ORG_ID = org.id;

  const created = await svc.auth.admin.createUser({ email: APPROVER_EMAIL, password: PASSWORD, email_confirm: true });
  let id = created.data.user?.id;
  if (!id) {
    const list = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
    id = list.data.users.find((u) => u.email === APPROVER_EMAIL)?.id;
    if (id) await svc.auth.admin.updateUserById(id, { password: PASSWORD, email_confirm: true });
  }
  if (!id) throw new Error(`[core-journey] could not seed approver ${APPROVER_EMAIL}`);
  await svc.from("users").upsert({ id, email: APPROVER_EMAIL, full_name: "E2E Core Approver" });
  await svc.from("memberships").upsert(
    { org_id: APPROVER_ORG_ID, user_id: id, role: "admin" },
    { onConflict: "org_id,user_id" },
  );
  // R4 default-deny: a bare admin holds NO management capabilities. Grant
  // quotes:manage (implies view + approve) so this admin can legitimately approve.
  const mem = (
    await svc.from("memberships").select("id").eq("org_id", APPROVER_ORG_ID).eq("user_id", id).maybeSingle()
  ).data as { id: string } | null;
  if (!mem?.id) throw new Error("[core-journey] approver membership missing");
  const { error: grantErr } = await svc.from("membership_permissions").upsert(
    { org_id: APPROVER_ORG_ID, membership_id: mem.id, module: "quotes", action: "manage", granted_by: null },
    { onConflict: "membership_id,module,action" },
  );
  if (grantErr) throw new Error(`[core-journey] grant quotes:manage failed: ${grantErr.message}`);
  await mintState(APPROVER_EMAIL, PASSWORD, APPROVER_STATE);
}

test.describe.configure({ mode: "serial" });

test.describe("core customer journey — owner, real browser", () => {
  test.beforeAll(async () => {
    await seedApprover();
  });

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
    // The converted customer is named after the lead's contact (`${TAG} Lead Co`).
    await pickCustomer(page, TAG, `${TAG} Lead Co`);
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

  test("3. approve → accept ⇒ auto Job + draft Invoice", async ({ page, browser }) => {
    test.setTimeout(90_000);
    await gotoReady(page, `/quotes/${S.quoteId}`);
    await page.getByRole("button", { name: /request approval/i }).click();
    await page.waitForURL(/saved=approval_requested/);
    await settle(page);
    // Approve as a DISTINCT authorised approver (separation of duties). The owner
    // created the quote, so when another approver exists the app correctly blocks
    // self-approval; we approve through the seeded admin (quotes:manage) instead of
    // weakening that rule. This is the common production path (multi-approver orgs).
    await asActor(browser, APPROVER_STATE, async (approver) => {
      await gotoReady(approver, `/quotes/${S.quoteId}`);
      await approver.getByRole("button", { name: /^approve$/i }).click();
      await approver.waitForURL(/saved=approved/);
    });
    // Back as the owner: the approved quote can now be accepted on the customer's behalf.
    await gotoReady(page, `/quotes/${S.quoteId}`);
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
