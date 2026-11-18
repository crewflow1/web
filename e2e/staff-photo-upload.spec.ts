/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seeding client, loose rows */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";

/**
 * A field worker uploads site photos from a phone.
 *
 * The photo upload had no end-to-end proof at all, and no staff-level test. Real browser at a
 * phone viewport as the e2e STAFF user, production build, real Postgres and real Storage:
 *   • two photos chosen on an ASSIGNED job are stored under the company's own prefix, attached
 *     to the job, shown in the gallery, and still there after a reload;
 *   • a file over the 10 MB limit is refused with a message and nothing is stored;
 *   • a job the worker is NOT assigned to is out of reach — the upload API answers 404 and
 *     stores nothing.
 */
const SLUG = "e2e-harness-org";
const STAFF_EMAIL = "e2e-staff@crewflow.test";
const TAG = `ph${Date.now().toString(36)}`;
// A valid 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function svc() {
  return createClient(assertLocalE2eTarget("staff-photo-upload.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as any;
}

test.describe.configure({ mode: "serial" });
test.describe("staff upload site photos on a phone (browser)", () => {
  test.use({ storageState: "e2e/.auth/staff.json", viewport: { width: 390, height: 844 } });
  const db = svc();
  let org = "", mine = "", notMine = "";

  const photosOf = async (jobId: string) => (((await db.from("jobs").select("photos").eq("id", jobId).single()).data?.photos ?? []) as string[]);
  const stored = async (jobId: string) => ((await db.storage.from("job-photos").list(`${org}/${jobId}`)).data ?? []) as any[];

  test.beforeAll(async () => {
    org = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!org) throw new Error("harness org not found — did globalSetup run?");
    const staffId = (await db.from("users").select("id").eq("email", STAFF_EMAIL).maybeSingle()).data?.id;
    if (!staffId) throw new Error("e2e staff user not found");
    const customer = (await db.from("customers").insert({ org_id: org, name: `Cust ${TAG}` }).select("id").single()).data.id;
    const a = await db.from("jobs").insert({ org_id: org, customer_id: customer, assigned_to: staffId, status: "in-progress" }).select("id").single();
    if (a.error) throw new Error(`job: ${a.error.message}`);
    mine = a.data.id;
    await db.from("job_assignments").insert({ org_id: org, job_id: mine, user_id: staffId });
    const b = await db.from("jobs").insert({ org_id: org, customer_id: customer, status: "in-progress" }).select("id").single();
    if (b.error) throw new Error(`other job: ${b.error.message}`);
    notMine = b.data.id;
  });

  test.afterAll(async () => {
    for (const job of [mine, notMine]) {
      const files = await stored(job);
      if (files.length) await db.storage.from("job-photos").remove(files.map((f: any) => `${org}/${job}/${f.name}`));
    }
  });

  test("two photos chosen on an assigned job are stored, attached, shown, and survive a reload", async ({ page }) => {
    await page.goto(`/jobs/${mine}`);
    const input = page.locator("section", { has: page.getByRole("heading", { name: "Photos", exact: true }) }).locator('input[type="file"]');
    await waitForHydrated(input);
    await expect(page.getByText("0 attached")).toBeVisible();

    await input.setInputFiles([
      { name: "before.png", mimeType: "image/png", buffer: PNG },
      { name: "after site visit.png", mimeType: "image/png", buffer: PNG },
    ]);
    await expect(page.getByText("2 attached")).toBeVisible({ timeout: 20_000 });

    const paths = await photosOf(mine);
    expect(paths).toHaveLength(2);
    for (const p of paths) expect(p.startsWith(`${org}/${mine}/`), `stored under the company's own prefix: ${p}`).toBe(true);
    expect(await stored(mine)).toHaveLength(2);

    await page.reload();
    await expect(page.getByText("2 attached")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("section", { has: page.getByRole("heading", { name: "Photos", exact: true }) }).locator("img").first()).toBeVisible();
    // usable on a phone: no sideways scroll with the gallery showing
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal overflow at 390px").toBeLessThanOrEqual(1);
  });

  test("a file over the 10 MB limit is refused with a message and nothing more is stored", async ({ page }) => {
    await page.goto(`/jobs/${mine}`);
    const input = page.locator("section", { has: page.getByRole("heading", { name: "Photos", exact: true }) }).locator('input[type="file"]');
    await waitForHydrated(input);
    await input.setInputFiles([{ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 1) }]);
    await expect(page.getByRole("alert").filter({ hasText: /huge\.png|exceeds|too large|10 ?MB/i })).toBeVisible({ timeout: 20_000 });
    expect(await photosOf(mine)).toHaveLength(2);
    expect(await stored(mine)).toHaveLength(2);
  });

  test("a job the worker is not assigned to is out of reach: the upload is refused and nothing is stored", async ({ page }) => {
    const res = await page.request.post(`/api/jobs/${notMine}/photos`, {
      multipart: { photos: { name: "sneaky.png", mimeType: "image/png", buffer: PNG } },
    });
    expect(res.status()).toBe(404);
    expect(await photosOf(notMine)).toHaveLength(0);
    expect(await stored(notMine)).toHaveLength(0);
  });
});
