/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * H2-CASH M3 — Journey D: the retention regression (the headline P3 fix).
 *
 * The M2 approximation netted the FULL job retention from collectable, so
 * retention accrued on already-PAID invoices wrongly reduced chase-now cash.
 * This seeds exactly that: two £12,000 invoices on a 5%-retention job — one
 * unpaid, one paid in full. Correct (M3) collectable is £11,500 (only the unpaid
 * invoice's £500 retention is still withheld); the old M2 maths would show
 * £11,000. Asserting £11,500 on the JOB billing page makes the regression
 * impossible to reintroduce unnoticed. Job-scoped, so unaffected by other specs.
 */

const SLUG = "e2e-harness-org";
function svc() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
const TAG = `D-${Date.now()}`;

test.describe("owner cash — retention is netted precisely (only what's still withheld)", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  let jobId = "";

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");
    const cust = (await db.from("customers").insert({ org_id: orgId, name: `Retention ${TAG}` }).select("id").single()).data;
    const job = (await db.from("jobs").insert({ org_id: orgId, customer_id: cust.id, status: "new", retention_percent: 5, practical_completion_date: "2025-01-01", defects_liability_months: 12 }).select("id").single()).data;
    jobId = job.id as string;
    // Invoice 1 — UNPAID: £10,000 + £2,000 VAT = £12,000. Accrues £500 retention,
    // all still embedded (unpaid).
    await db.from("invoices").insert({ org_id: orgId, customer_id: cust.id, job_id: jobId, number: `INVD1-${TAG}`, amount: 10000, vat_total: 2000, status: "sent", due_date: "2027-01-01" });
    // Invoice 2 — PAID IN FULL: also accrues £500 retention, but ZERO is embedded
    // (nothing owed). M2 wrongly withheld this £500; M3 does not.
    const inv2 = (await db.from("invoices").insert({ org_id: orgId, customer_id: cust.id, job_id: jobId, number: `INVD2-${TAG}`, amount: 10000, vat_total: 2000, status: "sent", due_date: "2027-01-01" }).select("id").single()).data;
    await db.from("invoice_payments").insert({ org_id: orgId, invoice_id: inv2.id, amount: 12000, paid_at: "2026-06-01" });
  });

  test("the job's collectable nets only the £500 still withheld, not the full £1,000 accrued", async ({ page }) => {
    await page.goto(`/jobs/${jobId}/billing`);
    // Exact match: the job billing page's h1 is "Get paid" AND (with no plan) an
    // h2 "Set up how you'll get paid" also exists — target the h1 unambiguously.
    await expect(page.getByRole("heading", { name: "Get paid", exact: true })).toBeVisible();

    // Retention held across both invoices = 5% × £20,000 net = £1,000.
    await expect(page.getByText(/£1,000/).first()).toBeVisible();

    // Collectable now = £12,000 outstanding − £500 STILL-withheld retention = £11,500.
    // (The M2 approximation would have shown £11,000 by netting the full £1,000.)
    await expect(page.getByText(/£11,500/).first()).toBeVisible();

    // The precise netting is surfaced honestly.
    await expect(page.getByText(/£500 retention still withheld/i).first()).toBeVisible();
  });
});
