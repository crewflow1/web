/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * H2-CASH M3 — Journey B: the customer portal payment schedule.
 *
 * The token IS the credential (no login). Seeds TWO customers under the harness
 * org; customer A has a job + billing plan + a distinctively-named stage, customer
 * B has neither. Proves: (1) A's portal shows A's own agreed schedule; (2) B's
 * portal never shows A's stage (the job-id filter is the only barrier on the
 * RLS-bypassing admin client); (3) a forged token gets the invalid-link page.
 */

const SLUG = "e2e-harness-org";
function svc() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
const TAG = `B-${Date.now()}`;
const STAGE_A = `Deposit ${TAG}`;

test.describe("customer portal — a customer sees their own schedule and never another's", () => {
  let tokenA = "";
  let tokenB = "";

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    const cA = (await db.from("customers").insert({ org_id: orgId, name: `Portal A ${TAG}` }).select("id, portal_token").single()).data;
    tokenA = String(cA.portal_token);
    const jobA = (await db.from("jobs").insert({ org_id: orgId, customer_id: cA.id, status: "new" }).select("id").single()).data;
    const planA = (await db.from("job_billing_plans").insert({ org_id: orgId, job_id: jobA.id, structure: "staged", basis_amount: 16000, status: "active" }).select("id").single()).data;
    await db.from("job_billing_stages").insert({ org_id: orgId, plan_id: planA.id, job_id: jobA.id, sequence: 0, name: STAGE_A, kind: "deposit", basis: "fixed", amount: 4000, vat_rate: 20 });

    const cB = (await db.from("customers").insert({ org_id: orgId, name: `Portal B ${TAG}` }).select("id, portal_token").single()).data;
    tokenB = String(cB.portal_token);
  });

  test("customer A sees their agreed payment schedule", async ({ page }) => {
    await page.goto(`/customer-portal/${tokenA}/invoices`);
    await expect(page.getByText(/expired or invalid/i)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /payment schedule/i })).toBeVisible();
    await expect(page.getByText(STAGE_A)).toBeVisible();
    // Gross of the deposit (4000 + 20% VAT) = £4,800.
    await expect(page.getByText(/£4,800/).first()).toBeVisible();
  });

  test("customer B NEVER sees customer A's stage (cross-customer isolation)", async ({ page }) => {
    await page.goto(`/customer-portal/${tokenB}/invoices`);
    await expect(page.getByText(/expired or invalid/i)).toHaveCount(0); // valid token, own (empty) portal
    await expect(page.getByText(STAGE_A)).toHaveCount(0); // but none of A's schedule
  });

  test("a forged token gets the invalid-link page, not another customer's data", async ({ page }) => {
    await page.goto("/customer-portal/00000000-0000-0000-0000-0000000000ff/invoices");
    await expect(page.getByText(STAGE_A)).toHaveCount(0);
    await expect(page.getByText(/expired or invalid|request a new/i).first()).toBeVisible();
  });
});
