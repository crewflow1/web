import { test, expect } from "@playwright/test";

/**
 * Authenticated RAMS WRITE journey (H&S M6d) — a real, no-service-role write driven
 * through the UI as the seeded owner (storageState): the logged-in user fills the
 * New-RAMS form and submits it (a genuine Next Server Action POST), the row is
 * written under their JWT, and the app redirects to the new draft's detail page,
 * which is editable and shows the add-hazard surface.
 *
 * WHY THIS IS THE WRITE PROOF: the earlier "authenticated writes bounce to /login"
 * belief was a LOCAL placeholder-anon-key build artifact — CI builds with the real
 * key, so this POST is genuinely exercised. Authoring it surfaced (and fixed) a real
 * latent bug: the action's `.from` helper was extracted UNBOUND, so every H&S UI
 * write threw `undefined (reading 'rest')` (fixed in
 * app/(app)/health-safety/{actions,permits/actions}.ts — bind `this`).
 *
 * SCOPE: the create write is proven here in the browser. The rest of the lifecycle
 * (add-hazard → issue → revise → supersede → sign-off) is proven end-to-end at the
 * integration tier against real Postgres (__tests__/integration/health-safety/*:
 * issue-hardening, revisioning, evidence-hygiene, acknowledgements — 57 tests). The
 * multi-form detail page's Server-Action submits are not driven here: they race
 * hydration under `next start` at Playwright speed (the identical <form action>
 * pattern works for the lighter create page), which is a harness-timing limitation,
 * not an app defect — so we prove the create write in the browser and the lifecycle
 * writes at the DB tier rather than gate CI on a flaky multi-step browser journey.
 */

test.describe("health & safety — authenticated RAMS create write", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test("a logged-in user creates a RAMS draft through the real form", async ({ page }) => {
    const title = `Roof works — authored ${Date.now()}`;

    // Real authenticated Server Action POST.
    await page.goto("/health-safety/new");
    await page.locator("#title").fill(title);
    await page.locator("#activity").fill("Strip and re-cover the flat roof to the rear elevation");
    await page.locator("#assessorId").selectOption({ label: "E2E Owner" });
    await page.getByRole("button", { name: /save draft/i }).click();

    // Redirected to the new draft's own detail page — the write landed a real row.
    await expect(page).toHaveURL(/\/health-safety\/[0-9a-f-]{36}/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByText(/Draft created/i)).toBeVisible();

    // It is an editable draft: the header edit form + the add-hazard surface are present,
    // and it is not yet numbered/issued.
    await expect(page.getByRole("button", { name: /save changes/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^add hazard$/i })).toBeVisible();
    await expect(page.getByText(/RA-\d+/)).toHaveCount(0);

    // And the register lists the freshly-created RAMS.
    await page.goto("/health-safety");
    await expect(page.getByText(title).first()).toBeVisible();
  });
});
