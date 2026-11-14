/* eslint-disable @typescript-eslint/no-explicit-any -- seed writes through a loose cast */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Regression: a DRAFT delay event's detail page must render.
 *
 * Found by the UI page sweep (docs/programme/ui-coverage/): for a draft event
 * /delays/[id] loads the "link a variation" picker, whose read selected
 * `quotes.title` — a column that does not exist. PostgREST rejected the read
 * (42703), the loud-read helper threw, and EVERY draft delay page rendered the
 * workspace error boundary for every role. Recorded/withdrawn events skip the
 * picker, which is why only drafts were affected.
 *
 * The fixture includes a VARIATION on the same job so the picker read returns
 * a row and the label mapping is exercised, not just the empty case.
 */
const JOB = "00000000-0000-0000-0000-000000000000"; // harness job (e2e/global-setup.ts)
const SLUG = "e2e-harness-org";

test.describe("draft delay event detail", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  let delayId = "";
  let quoteId = "";
  let customerId = "";
  const db = (): { from: (t: string) => any } => {
    assertLocalE2eTarget("delays-draft-detail.spec.ts");
    return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as { from: (t: string) => any };
  };

  test.beforeAll(async () => {
    const d = db();
    const orgId = (await d.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    expect(orgId, "harness org seeded").toBeTruthy();
    const c = await d.from("customers").insert({ org_id: orgId, name: "E2E Delay Fixture Customer" }).select("id").single();
    expect(c.error, `customer seed: ${c.error?.message}`).toBeNull();
    customerId = c.data.id;
    const q = await d
      .from("quotes")
      .insert({ org_id: orgId, job_id: JOB, customer_id: customerId, number: "E2E-VAR-901", status: "draft", variation_number: 901 })
      .select("id")
      .single();
    expect(q.error, `variation quote seed: ${q.error?.message}`).toBeNull();
    quoteId = q.data.id;
    const ins = await d
      .from("delay_events")
      .insert({ org_id: orgId, job_id: JOB, category: "weather", started_on: "2026-11-02", description: "E2E draft delay — regression fixture" })
      .select("id, status")
      .single();
    expect(ins.error, `delay seed: ${ins.error?.message}`).toBeNull();
    expect(ins.data.status).toBe("draft");
    delayId = ins.data.id;
  });

  test.afterAll(async () => {
    const d = db();
    if (delayId) await d.from("delay_events").delete().eq("id", delayId);
    if (quoteId) await d.from("quotes").delete().eq("id", quoteId);
    if (customerId) await d.from("customers").delete().eq("id", customerId);
  });

  test("renders the event and offers the job's variation in the picker (no error boundary)", async ({ page }) => {
    const res = await page.goto(`/delays/${delayId}`);
    expect(res?.status()).toBeLessThan(500);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/delay$/i);
    await expect(page.getByRole("heading", { name: /something went wrong/i })).toHaveCount(0);
    // the variation picker's read succeeded and mapped a label for the seeded variation
    await expect(page.locator("option", { hasText: "Variation #901 — E2E-VAR-901" })).toHaveCount(1);
  });
});
