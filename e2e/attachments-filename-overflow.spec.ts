import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Attachments panel — long-filename mobile overflow regression.
 *
 * A phone-camera upload arrives with a long unbroken filename. The panel renders that
 * filename as a <button>, and a <button> is an inline-block: its width is shrink-to-fit,
 * and `truncate`'s `white-space: nowrap` makes its PREFERRED MINIMUM width the full text
 * width. So it sized to its content (~464px inside a 244px column), overflowed its
 * already-`min-w-0` parent, and pushed the whole detail page into horizontal scroll at
 * phone width. `max-w-full` is what actually caps it so `truncate` can clip.
 *
 * NOTE for anyone tempted to "tidy up" the fix: `min-w-0` on the button does NOT work
 * here — that only unsticks a FLEX ITEM's `min-width: auto`, and the button is not a
 * flex item (its parent div is). The parent already has `min-w-0`. Measured: with
 * `min-w-0` the button still lays out at its full 464px content width, unclipped.
 *
 * Seeds one attachment row on the harness job via service-role, then GET-navigates only
 * (the upload/delete write paths are covered by the attachments action suite). Asserts
 * both the symptom (no page-level horizontal scroll) and the mechanism (the button is
 * clipped and stays within its column), so a regression fails for a legible reason.
 *
 * The panel is shared by customers/suppliers/invoices/leads/quotes/staff/jobs, so this
 * guards all seven detail pages through the jobs one.
 */

const SLUG = "e2e-harness-org";
const JOB = "00000000-0000-0000-0000-000000000000"; // the sentinel id the harness seeds
const FILENAME = "a-very-long-unbroken-site-photo-filename-from-a-phone-camera.jpg";

function svc() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe("attachments — long filename at phone width", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  let orgId = "";

  test.beforeAll(async () => {
    const db = svc();
    const t = (n: string) => (db as unknown as { from: (n: string) => any }).from(n); // eslint-disable-line @typescript-eslint/no-explicit-any
    orgId = String((await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id ?? "");
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    // Idempotent on a persistent local DB: drop any row this spec left behind.
    await t("tenant_attachments").delete().eq("target_table", "jobs").eq("target_id", JOB).eq("filename", FILENAME);

    const ins = await t("tenant_attachments")
      .insert({
        org_id: orgId,
        target_table: "jobs",
        target_id: JOB,
        filename: FILENAME,
        storage_path: `${orgId}/jobs/${JOB}/${FILENAME}`, // org-first, per tg_assert_storage_path_org
        mime_type: "image/jpeg",
        size_bytes: 1_258_291,
      })
      .select("id")
      .single();
    if (ins.error) throw new Error(`overflow seed: attachment insert failed (${ins.error.message})`);
  });

  test.afterAll(async () => {
    const db = svc();
    const t = (n: string) => (db as unknown as { from: (n: string) => any }).from(n); // eslint-disable-line @typescript-eslint/no-explicit-any
    await t("tenant_attachments").delete().eq("target_table", "jobs").eq("target_id", JOB).eq("filename", FILENAME);
  });

  test("a long attachment filename does not push the job page into horizontal scroll at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/jobs/${JOB}`);
    await page.waitForLoadState("networkidle");

    // The row is actually on the page — otherwise this would pass vacuously.
    const name = page.getByRole("button", { name: FILENAME, exact: true });
    await expect(name).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "no horizontal scroll at phone width").toBeLessThanOrEqual(1);
  });

  test("the filename button is clipped to its column rather than sized to its text", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/jobs/${JOB}`);
    await page.waitForLoadState("networkidle");

    const box = await page.getByRole("button", { name: FILENAME, exact: true }).evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      parentWidth: (el.parentElement as HTMLElement).getBoundingClientRect().width,
      clipped: el.scrollWidth > el.clientWidth,
    }));

    expect(box.width, "filename button must not exceed its column").toBeLessThanOrEqual(box.parentWidth + 1);
    expect(box.clipped, "filename must be ellipsised, not laid out at full text width").toBe(true);
  });
});
