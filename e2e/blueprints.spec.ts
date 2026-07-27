import { test, expect } from "@playwright/test";

/**
 * Blueprint Centre E2E — the drawing register is operator-internal (private
 * bucket, no customer portal), so the deterministic boundary is that it sits
 * behind the auth wall. The DB invariants + storage scoping are proven at the
 * integration/security tiers.
 */
test.describe("blueprints — the drawing register is behind auth", () => {
  test("a logged-out visitor to a job's drawings is sent to /login", async ({ page }) => {
    const jobId = "00000000-0000-0000-0000-000000000000";
    await page.goto(`/jobs/${jobId}/blueprints`);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fjobs%2F${jobId}%2Fblueprints`));
    await expect(page.getByText(/Drawings|Revision history/)).toHaveCount(0);
  });

  test("the blueprint file route 404s for a logged-out visitor / guessed id", async ({ request }) => {
    const res = await request.get(`/jobs/00000000-0000-0000-0000-000000000000/blueprints/f/11111111-1111-1111-1111-111111111111`, { maxRedirects: 0 });
    expect([302, 401, 403, 404, 307]).toContain(res.status());
    // must NOT 302 to a signed storage URL for an unauthenticated caller
    if (res.status() === 302 || res.status() === 307) {
      expect(res.headers()["location"] ?? "").not.toContain("/storage/v1/object/sign");
    }
  });
});
