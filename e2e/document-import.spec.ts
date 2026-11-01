import { test, expect } from "@playwright/test";

/**
 * FEATURE 2 — document-to-form autofill, end-to-end (one representative flow).
 *
 * Proves the WHOLE pipeline wiring against the real app + real Postgres + real
 * Supabase storage: the Import button → the upload server action (auth +
 * capability + tenant-scoped storage upload + governed extraction + draft row)
 * → the review dialog → carrying the draft into the EXISTING create form →
 * saving through the normal validated workflow.
 *
 * It does NOT fake live AI. In the e2e environment no vision tier is bound, so
 * extraction honestly degrades to an empty proposal ("AI reading isn't enabled")
 * and the dialog's primary action is "Continue to form". That is exactly the
 * production default today, and it exercises every seam except the model call
 * itself — which is governed and tested separately. The point proven here is
 * that the plumbing is correct and that extraction being off NEVER blocks the
 * operator from creating the record.
 *
 * The owner storageState has the wildcard capability, so the Import button is
 * visible for the customer form (customers:create).
 */

test.use({ storageState: "e2e/.auth/owner.json" });

// A tiny but valid 1x1 PNG — enough to be accepted as an image upload.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("document import → review → save (customer)", () => {
  test("owner imports a document and saves the prefilled customer form", async ({ page }) => {
    await page.goto("/customers");
    await page.waitForLoadState("networkidle");

    // The Import button sits beside "New customer".
    const importBtn = page.getByRole("button", { name: /import a customer from a document/i });
    await expect(importBtn).toBeVisible();

    // Upload directly into the hidden file input the button drives.
    await page.setInputFiles('[data-testid="import-input-customer"]', {
      name: "acme-letterhead.png",
      mimeType: "image/png",
      buffer: PNG_1x1,
    });

    // The review dialog opens and resolves to a terminal state (review or the
    // "AI off" continue path). Either way a primary action appears.
    const dialogTitle = page.getByRole("heading", { name: /import customer/i });
    await expect(dialogTitle).toBeVisible({ timeout: 30_000 });

    const proceed = page.getByRole("button", { name: /use these values|continue to form/i });
    await expect(proceed).toBeVisible({ timeout: 30_000 });
    await proceed.click();

    // We land on the EXISTING create form, carrying the draft id.
    await page.waitForURL(/\/customers\/new\?.*import=/, { timeout: 30_000 });

    // The prefill banner is shown, and the form is the normal create form.
    await expect(page.getByText(/document/i).first()).toBeVisible();

    // Save through the normal validated workflow — the operator always types/
    // confirms the record. (Dark AI means name is empty; we fill it.)
    const unique = `E2E Import ${Date.now()}`;
    await page.locator('input[name="name"]').fill(unique);
    await page.getByRole("button", { name: /save customer/i }).click();

    // Lands on the new customer's detail page — the record was created by the
    // normal action, not by the import.
    await page.waitForURL(/\/customers\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByText(unique).first()).toBeVisible();
  });
});
