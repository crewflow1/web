/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * H2-CASH M3 — Journey C: the Daily Briefing surfaces deterministic cash signals.
 *
 * Seeds an accepted contract with no billing schedule (→ "not yet scheduled to
 * bill") plus an overdue invoice, then the OWNER loads /dashboard and sees the
 * money signals linking to /cash. The exact aggregate £ depends on the whole org,
 * so we assert the signal TYPE + the deep link, not a brittle total.
 */

const SLUG = "e2e-harness-org";
function svc() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
const TAG = `C-${Date.now()}`;

test.describe("daily briefing — deterministic cash signals reach the dashboard", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");
    const cust = (await db.from("customers").insert({ org_id: orgId, name: `Briefing ${TAG}` }).select("id").single()).data;
    const job = (await db.from("jobs").insert({ org_id: orgId, customer_id: cust.id, status: "new" }).select("id").single()).data;
    // Accepted contract, NO billing plan → unscheduled contract value signal.
    await db.from("quotes").insert({ org_id: orgId, customer_id: cust.id, job_id: job.id, number: `QC-${TAG}`, status: "accepted", subtotal: 25000, vat_total: 5000, total: 30000 });
    // An overdue invoice → the overdue money signal.
    await db.from("invoices").insert({ org_id: orgId, customer_id: cust.id, job_id: job.id, number: `INVC-${TAG}`, amount: 3000, vat_total: 600, status: "sent", due_date: "2020-02-02" });
  });

  test("the briefing shows money signals that deep-link to /cash", async ({ page }) => {
    await page.goto("/dashboard");
    // The briefing rendered (greeting heading).
    await expect(page.getByRole("heading", { name: /good (morning|afternoon|evening)/i })).toBeVisible();
    // A money category label is present.
    await expect(page.getByText("Money").first()).toBeVisible();
    // The unscheduled-contract-value nudge (deterministic, LOW severity) is present.
    await expect(page.getByText(/not yet scheduled to bill/i).first()).toBeVisible();
    // At least one briefing item deep-links to /cash.
    await expect(page.locator('a[href="/cash"]').first()).toBeVisible();
  });
});
