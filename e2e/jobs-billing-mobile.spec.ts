/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * Per-job billing "Get paid" tiles — 7-figure money on a phone.
 *
 * The owner reads a job's billing (P&L) page on a 375px phone, and a
 * construction job legitimately carries a 7-figure ex-VAT contract value
 * (£5,000,000.00). The tiles used a LOCAL `Stat` whose card had no `min-w-0`
 * and whose value line had no `truncate` — the inverse of the canonical
 * components/ui/stat-tile.tsx. A comma-grouped GBP figure has no soft-wrap
 * opportunity, so the min-content width of a 7-figure value pushed the 2-up
 * grid wider than the viewport and the whole "Get paid" page scrolled
 * sideways. The tiles now use StatTile (`min-w-0` card, `truncate tabular-nums`
 * value — the idiom the fixed tiles on /dashboard, /stock and /cash use), so a
 * wide figure is clipped to its cell instead of stretching the grid.
 *
 * Reads only in the browser — the summary maths itself is proved in the unit
 * tier (lib/billing); this spec guards the layout.
 *
 * Seeding is idempotent against the PERSISTENT local database: a fixed-id job,
 * a fixed-named customer and this job's single active billing plan are deleted
 * and reseeded in beforeAll, so a local run does not drift the scanned DOM. The
 * plan's `basis_amount` is 7-figure, so the unconditional "Contract (ex-VAT)"
 * tile carries the value that used to blow out the grid at 375px.
 */

const SLUG = "e2e-harness-org";
// Fixed, namespaced ids so beforeAll is idempotent and never collides with the
// globalSetup sentinel job or another spec's seeds.
const JOB = "b1111111-1111-1111-1111-111111111111";
const CUST_NAME = "Job Billing Mobile E2E Customer";

function svc() {
  return createClient(
    assertLocalE2eTarget("jobs-billing-mobile.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

test.describe("job billing — 7-figure money tiles at 375px do not overflow", () => {
  test.use({ storageState: "e2e/.auth/owner.json", viewport: { width: 375, height: 812 } });

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    let custId = (
      await db.from("customers").select("id").eq("org_id", orgId).eq("name", CUST_NAME).maybeSingle()
    ).data?.id;
    if (!custId) {
      custId = (
        await db.from("customers").insert({ org_id: orgId, name: CUST_NAME }).select("id").single()
      ).data?.id;
    }

    // Fixed-id job (upsert) so this spec owns a stable target with a customer set.
    const job = await db
      .from("jobs")
      .upsert({ id: JOB, org_id: orgId, customer_id: custId, status: "in-progress" });
    if (job.error) throw new Error(`billing seed (job): ${job.error.message}`);

    // One active plan per job (a unique partial index enforces it), so reset this
    // spec's own row before reseeding. A £5,000,000.00 ex-VAT contract makes the
    // unconditional "Contract (ex-VAT)" tile 7-figure — the value that used to
    // stretch the 2-up grid past 375px.
    await db.from("job_billing_plans").delete().eq("org_id", orgId).eq("job_id", JOB);
    const plan = await db.from("job_billing_plans").insert({
      org_id: orgId,
      job_id: JOB,
      structure: "full",
      basis_amount: 5_000_000,
      status: "active",
    });
    if (plan.error) throw new Error(`billing seed (plan): ${plan.error.message}`);
  });

  test("renders the get-paid tiles with no horizontal scroll at 375px", async ({ page }) => {
    await page.goto(`/jobs/${JOB}/billing`);

    // The money tiles reached the page with their 7-figure value.
    await expect(page.getByText("Contract (ex-VAT)").first()).toBeVisible();
    await expect(page.getByText("£5,000,000.00").first()).toBeVisible();

    // Settle first: reading scrollWidth before web fonts land measures fallback
    // glyph metrics (narrower), which can mask a real overflow.
    await settleForAxe(page);
    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(
      overflow.scrollWidth - overflow.clientWidth,
      `page overflows horizontally at 375px (${overflow.scrollWidth} > ${overflow.clientWidth})`,
    ).toBeLessThanOrEqual(1);
  });
});
