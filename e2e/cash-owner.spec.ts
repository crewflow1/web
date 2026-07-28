/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * H2-CASH M3 — Journey A: the owner "Get paid" surface, authenticated, no mocks.
 *
 * Seeds a job with an accepted contract, an overdue invoice, and a planned
 * (un-invoiced) billing stage via service-role under the harness org, then the
 * OWNER opens /cash and sees the precise figures + the M3 cash outlook (due vs
 * planned vs unscheduled). Reads only in the browser (writes go through the DB
 * tier) to dodge the middleware getUser() flake. The maths itself is unit-tested;
 * this proves the data reaches the real page.
 */

const SLUG = "e2e-harness-org";
function svc() {
  return createClient(assertLocalE2eTarget("cash-owner.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
const TAG = `A-${Date.now()}`;

test.describe("owner cash — the get-paid surface reflects the precise position + forecast", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  let orgId = "";

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    const cust = (await db.from("customers").insert({ org_id: orgId, name: `Cash Owner ${TAG}` }).select("id").single()).data;
    const custId = cust.id as string;
    const job = (await db.from("jobs").insert({ org_id: orgId, customer_id: custId, status: "new", retention_percent: 0 }).select("id").single()).data;
    const jobId = job.id as string;
    // Accepted contract worth £24,000 gross → the live "revised" contract value.
    await db.from("quotes").insert({ org_id: orgId, customer_id: custId, job_id: jobId, number: `Q-${TAG}`, status: "accepted", subtotal: 20000, vat_total: 4000, total: 24000 });
    // An overdue invoice: £4,000 + £800 VAT = £4,800 gross, due in the past.
    await db.from("invoices").insert({ org_id: orgId, customer_id: custId, job_id: jobId, number: `INV-${TAG}`, amount: 4000, vat_total: 800, status: "sent", due_date: "2020-01-01" });
    // A billing plan with one planned (un-invoiced) stage → ready to invoice.
    const plan = (await db.from("job_billing_plans").insert({ org_id: orgId, job_id: jobId, structure: "staged", basis_amount: 20000, status: "active" }).select("id").single()).data;
    await db.from("job_billing_stages").insert({ org_id: orgId, plan_id: plan.id, job_id: jobId, sequence: 0, name: `First fix ${TAG}`, kind: "stage", basis: "fixed", amount: 5000, vat_rate: 20 });
  });

  test("/cash shows the overdue debt, ready-to-invoice work and the cash outlook", async ({ page }) => {
    await page.goto("/cash");
    await expect(page.getByRole("heading", { name: /get paid/i })).toBeVisible();

    // The M3 cash outlook section is present, distinguishing certainty (static —
    // proves the section renders regardless of other orgs' data).
    await expect(page.getByRole("heading", { name: /cash outlook/i })).toBeVisible();
    await expect(page.getByText(/Planned billing/i).first()).toBeVisible();
    await expect(page.getByText(/Unscheduled contract value/i).first()).toBeVisible();
    await expect(page.getByText(/Ready to invoice/i).first()).toBeVisible();

    // Assert on THIS seed's distinctive rows, not org aggregates (other specs seed
    // into the same org during a CI run): the £4,800 overdue invoice and this
    // job's customer label both appear in the queues.
    await expect(page.getByText(/£4,800/).first()).toBeVisible();
    await expect(page.getByText(new RegExp(`Cash Owner ${TAG}`)).first()).toBeVisible();
  });
});
