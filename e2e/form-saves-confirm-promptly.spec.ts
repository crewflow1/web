/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seeding client, loose rows */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";

/**
 * Saves confirm promptly — the ten-second stall cannot come back.
 *
 * Before app/(app)/_components/commit-nudge.tsx, most of these saves wrote their row at once but
 * showed the confirmation (and the new values) only ~10 s later, measured on the production build:
 * record payment 9.5 s, assign worker 9.7 s, staff profile 10.1 s, qualification 10.1 s, holiday
 * entitlement 9.6 s, rota shift 9.6 s, leave request 10.0 s (one of the two timings), settings
 * 9.7 s. With it, every one is ~0.3 s. The stall depends on timing, so each save is driven twice:
 * plainly, and with the page's requests passed through an interceptor (no delay, no change),
 * which flips the timing; either way the confirmation must arrive within 3 seconds. Each test
 * also checks the row was written. Owner session, harness org, production build, real Postgres.
 */
const SLUG = "e2e-harness-org";
const TAG = `fp${Date.now().toString(36)}`;
const LIMIT_MS = 3_000;
const db = createClient(assertLocalE2eTarget("form-saves-confirm-promptly.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
}) as any;
let org = "", staff = "", staffName = "", customer = "", orgPhone: string | null = null;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const farDay = () => day(400 + Math.floor(Math.random() * 3000));

async function submitAndTime(page: Page, intercept: boolean, path: string, form: Locator, fill: () => Promise<void>, done: Locator): Promise<number> {
  if (intercept) await page.route(`**${path}*`, (r) => r.continue());
  await page.goto(path);
  const submit = form.locator('button[type="submit"]').first();
  await waitForHydrated(submit);
  await fill();
  const t0 = Date.now();
  await submit.click();
  await expect(done, `confirmation within ${LIMIT_MS} ms`).toBeVisible({ timeout: LIMIT_MS });
  return Date.now() - t0;
}

test.use({ storageState: "e2e/.auth/owner.json" });
test.describe.configure({ mode: "serial" });
test.describe("saves confirm promptly (browser)", () => {
  test.beforeAll(async () => {
    const o = (await db.from("organizations").select("id, phone").eq("slug", SLUG).maybeSingle()).data;
    if (!o) throw new Error("harness org not found — did globalSetup run?");
    org = o.id; orgPhone = o.phone;
    const s = (await db.from("users").select("id, full_name").eq("email", "e2e-staff@crewflow.test").single()).data;
    staff = s.id; staffName = s.full_name;
    customer = (await db.from("customers").insert({ org_id: org, name: `Prompt ${TAG}` }).select("id").single()).data.id;
  });
  test.afterAll(async () => {
    await db.from("users").update({ full_name: staffName }).eq("id", staff);
    await db.from("organizations").update({ phone: orgPhone }).eq("id", org);
  });

  for (const intercept of [false, true]) {
    const how = intercept ? "interceptor" : "plain";

    test(`record a payment · ${how}`, async ({ page }) => {
      const inv = (await db.from("invoices").insert({ org_id: org, customer_id: customer, number: `FP-${TAG}-${how}`, status: "sent", amount: 100, vat_total: 20 }).select("id").single()).data.id;
      const form = page.locator("form", { has: page.locator('input[name="amount"]') }).last();
      await submitAndTime(page, intercept, `/invoices/${inv}`, form, async () => { await form.locator('input[name="amount"]').fill("10"); }, page.getByText("Payment recorded."));
      expect(((await db.from("invoice_payments").select("id").eq("invoice_id", inv)).data ?? []).length).toBe(1);
    });

    test(`assign a worker to a job · ${how}`, async ({ page }) => {
      const job = (await db.from("jobs").insert({ org_id: org, customer_id: customer, status: "new" }).select("id").single()).data.id;
      const form = page.locator("form", { has: page.locator('select[name="user_id"]') }).first();
      await submitAndTime(page, intercept, `/jobs/${job}`, form, async () => { await form.locator('select[name="user_id"]').selectOption(staff); },
        page.locator("form", { has: page.locator('input[type="hidden"][name="user_id"]') }).first());
      expect(((await db.from("job_assignments").select("id").eq("job_id", job).eq("user_id", staff)).data ?? []).length).toBe(1);
    });

    test(`edit a staff profile · ${how}`, async ({ page }) => {
      const name = `${staffName} ${how}`;
      const form = page.locator("form", { has: page.locator('input[name="full_name"]') }).first();
      await submitAndTime(page, intercept, `/staff/${staff}`, form, async () => { await form.locator('input[name="full_name"]').fill(name); }, page.getByText("Profile saved."));
      expect((await db.from("users").select("full_name").eq("id", staff).single()).data.full_name).toBe(name);
    });

    test(`add a qualification · ${how}`, async ({ page }) => {
      const title = `CSCS ${TAG} ${how}`;
      const form = page.locator("form", { has: page.locator('input[name="title"]') }).first();
      await submitAndTime(page, intercept, `/staff/${staff}`, form, async () => { await form.locator('input[name="title"]').fill(title); }, page.getByText("Qualification added."));
      expect(((await db.from("staff_qualifications").select("id").eq("user_id", staff).eq("title", title)).data ?? []).length).toBe(1);
    });

    test(`save a holiday entitlement · ${how}`, async ({ page }) => {
      const form = page.locator("form", { has: page.locator('input[name="annual_allowance_days"]') }).first();
      await submitAndTime(page, intercept, `/staff/${staff}`, form, async () => { await form.locator('input[name="annual_allowance_days"]').fill(intercept ? "28" : "26"); }, page.getByText("Holiday entitlement saved."));
    });

    test(`add a rota shift · ${how}`, async ({ page }) => {
      const d = farDay();
      const form = page.locator("form", { has: page.locator('input[name="starts_at"][type="datetime-local"]') }).first();
      await submitAndTime(page, intercept, "/staff/rota", form, async () => {
        await form.locator('select[name="user_id"]').selectOption(staff);
        await form.locator('input[name="starts_at"]').fill(`${d}T08:00`);
        await form.locator('input[name="ends_at"]').fill(`${d}T16:00`);
      }, page.getByText("Shift added."));
    });

    test(`request leave · ${how}`, async ({ page }) => {
      const d = farDay();
      const form = page.locator("form", { has: page.locator('textarea[name="reason"], input[name="reason"]') }).first();
      await submitAndTime(page, intercept, "/staff/leave", form, async () => {
        await form.locator('input[name="starts_at"]').fill(d);
        await form.locator('input[name="ends_at"]').fill(d);
      }, page.getByText("Leave request submitted."));
    });

    test(`save organisation settings · ${how}`, async ({ page }) => {
      const phone = intercept ? "028 9000 2222" : "028 9000 1111";
      const form = page.locator("form", { has: page.getByRole("button", { name: "Save organisation" }) });
      await submitAndTime(page, intercept, "/settings", form, async () => { await form.locator('input[name="phone"]').fill(phone); }, page.getByText("Organisation saved."));
      expect((await db.from("organizations").select("phone").eq("id", org).single()).data.phone).toBe(phone);
      // and the field shows the saved value, not the old one
      await expect(form.locator('input[name="phone"]')).toHaveValue(phone);
    });
  }
});
