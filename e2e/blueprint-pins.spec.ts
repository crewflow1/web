import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Blueprint Pins (Programme B) — E2E boundary + journey.
 *
 * Real assertion every CI pass: the pin surface (and its "Add pin" control) is
 * operator-internal and never leaks to a logged-out visitor — it lives inside
 * the auth-walled register + the ssr:false viewer.
 *
 * The authenticated place → marker → open-snag journey runs for real via the
 * harness (e2e/global-setup.ts). Its beforeAll clears the sentinel job's pins
 * first — the journey pins the exact centre of the overlay, so against a
 * persistent local database a leftover centre marker from the previous run
 * would swallow this run's centre click (opening its popover instead of the
 * "Add a pin" sheet). The DB invariants stay proven against real Postgres
 * (__tests__/integration/rls/blueprint-pins.test.ts) and the pure
 * coordinate/derivation logic in unit tests (__tests__/blueprints/pins.test.ts).
 */

const JOB = "00000000-0000-0000-0000-000000000000";

test.describe("blueprint pins — stay behind the auth wall", () => {
  test("a logged-out visitor never sees the pin layer or the Add-pin control", async ({ page }) => {
    await page.goto(`/jobs/${JOB}/blueprints`);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: "+ Add pin" })).toHaveCount(0);
    await expect(page.locator("[data-pin-marker]")).toHaveCount(0);
  });
});

test.describe("blueprint pins — authenticated place-a-snag journey", () => {
  // Real authenticated E2E via the harness (e2e/global-setup.ts).
  test.use({ storageState: "e2e/.auth/owner.json" });

  /**
   * Determinism against a PERSISTENT local database (Ch.18: a flaky E2E is a
   * defect to fix). globalSetup seeds the job/blueprint idempotently but never
   * clears pins, and every pass of this journey inserts a pin at u=0.5, v=0.5 —
   * so without cleanup the next local run's centre click lands on the existing
   * marker and the "Add a pin" sheet never opens. CI never sees this (fresh
   * `supabase start` volume every run); this makes local re-runs behave the same.
   * Snags are deleted first — snag→pin is ON DELETE CASCADE, while deleting a
   * pin alone would strand its snag — then any remaining (note-kind) pins.
   */
  test.beforeAll(async () => {
    const db = createClient(
      assertLocalE2eTarget("blueprint-pins.spec.ts"),
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data: pins, error: readErr } = await db
      .from("blueprint_pins")
      .select("snag_id")
      .eq("job_id", JOB);
    if (readErr) throw new Error(`[blueprint-pins cleanup] read failed: ${readErr.message}`);
    const snagIds = [
      ...new Set(
        (pins ?? [])
          .map((p: { snag_id: string | null }) => p.snag_id)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (snagIds.length) {
      const { error } = await db.from("snags").delete().in("id", snagIds);
      if (error) throw new Error(`[blueprint-pins cleanup] snag delete failed: ${error.message}`);
    }
    const { error: pinErr } = await db.from("blueprint_pins").delete().eq("job_id", JOB);
    if (pinErr) throw new Error(`[blueprint-pins cleanup] pin delete failed: ${pinErr.message}`);
  });

  test(
    "Add pin → tap drawing → create snag → marker appears → open snag deep-links",
    async ({ page }) => {
      await page.goto(`/jobs/${JOB}/blueprints`);
      await page.getByRole("button", { name: "View" }).first().click();
      const dialog = page.getByRole("dialog", { name: /Drawing viewer/ });
      await expect(dialog.locator("canvas[data-rendered-page]")).toBeVisible();

      await dialog.getByRole("button", { name: "+ Add pin" }).click();
      // tap the centre of the page box
      const box = await dialog.locator("[data-blueprint-overlay]").boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

      const sheet = page.getByRole("dialog", { name: "Add a pin" });
      await expect(sheet).toBeVisible();
      await sheet.getByLabel("Snag title").fill("Cracked render at RC junction");
      await sheet.getByRole("button", { name: "Create snag" }).click();

      // a marker now exists, and activating it deep-links to the snag
      const marker = dialog.locator("[data-pin-marker]").first();
      await expect(marker).toBeVisible();
      await marker.click();
      await expect(page.getByRole("link", { name: /Open snag/ })).toBeVisible();
    },
  );
});
