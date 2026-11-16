/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seeding client, loose rows */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * A field worker opens an assigned job on a phone and reads the instructions.
 *
 * The job page used to show staff the owner/admin EDIT form ("Save changes"), and every save was
 * refused — a dead-end button on the page a site worker uses most. Staff now get the same details
 * read-only. Real browser (production build, real Postgres), phone viewport, the e2e staff user.
 */
const SLUG = "e2e-harness-org";
const STAFF_EMAIL = "e2e-staff@crewflow.test";
const TAG = `J${Date.now().toString(36)}`;
const INSTRUCTIONS = `Gate code 4821. Report to the site office first. ${TAG}`;

function svc() {
  return createClient(assertLocalE2eTarget("staff-job-view.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as { from: (t: string) => any };
}

test.describe("staff job view on a phone (browser)", () => {
  test.use({ storageState: "e2e/.auth/staff.json", viewport: { width: 390, height: 844 } });
  const db = svc();
  let jobId = "";

  test.beforeAll(async () => {
    const org = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!org) throw new Error("harness org not found — did globalSetup run?");
    const staffId = (await db.from("users").select("id").eq("email", STAFF_EMAIL).maybeSingle()).data?.id;
    if (!staffId) throw new Error("e2e staff user not found");
    const customer = (await db.from("customers").insert({ org_id: org, name: `Cust ${TAG}` }).select("id").single()).data.id;
    const job = await db.from("jobs").insert({ org_id: org, customer_id: customer, assigned_to: staffId, status: "in-progress", scheduled_date: "2026-12-01", notes: INSTRUCTIONS }).select("id").single();
    if (job.error) throw new Error(`job: ${job.error.message}`);
    jobId = job.data.id;
    await db.from("job_assignments").insert({ org_id: org, job_id: jobId, user_id: staffId });
  });

  test("the assigned job shows its instructions read-only, with no edit form and no sideways scroll", async ({ page }) => {
    await page.goto(`/jobs/${jobId}`);
    const details = page.getByTestId("job-details-readonly");
    await expect(details).toBeVisible();
    await expect(details).toContainText(INSTRUCTIONS);
    await expect(details).toContainText("In progress");
    await expect(details).toContainText("Only an owner or admin can change these details.");
    // the dead end is gone: no job edit form for a field worker
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    // usable on a phone: the page does not scroll sideways
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal overflow at 390px").toBeLessThanOrEqual(1);
    // and nothing was changed by looking
    const row = (await db.from("jobs").select("status, notes").eq("id", jobId).single()).data;
    expect(row).toEqual({ status: "in-progress", notes: INSTRUCTIONS });
  });
});
