import { test, expect } from "@playwright/test";

/**
 * Asset inspections/templates E2E — gate 6 for the M4 platform (templates →
 * scheduling → overrides).
 *
 * Runs against the REAL production build (`next start`) on the REAL Supabase
 * local stack. Like every spec in this tier it proves the one identity an
 * unauthenticated E2E can assert deterministically — the anonymous visitor —
 * which for M4 is the request boundary of the compliance surfaces: **the
 * template library/editor, the org-wide inspections overview and the
 * inspection run page never paint for a caller without a session.** A printed
 * checklist or a due-work URL leaking into an unauthenticated context is
 * exactly the risk this closes.
 *
 * The full M4 lifecycle (template v1 → publish → run keeps v1 → safety fail →
 * block → override denied/recorded → linked re-inspection clears exactly one
 * block) is proven DETERMINISTICALLY one tier down against real Postgres:
 *   - asset-inspection-templates.test.ts (11) — versioning + immutability
 *   - asset-inspection-generator.test.ts (7)  — idempotent + concurrent claims
 *   - asset-inspection-overrides.test.ts (13) — overrides/lineage/hardening/pre-use
 * An AUTHENTICATED browser lifecycle E2E needs the passwordless login harness
 * (tracked as its own infra increment) — not faked here.
 */

// Well-formed-but-nonexistent UUIDs: the wall must fire BEFORE any resolution.
const FAKE_ASSET = "00000000-0000-0000-0000-00000000aaaa";
const FAKE_INSPECTION = "00000000-0000-0000-0000-00000000bbbb";

const M4_PAGES: ReadonlyArray<readonly [string, string, RegExp]> = [
  ["/assets/templates", "%2Fassets%2Ftemplates", /Inspection templates/],
  ["/assets/templates/new", "%2Fassets%2Ftemplates%2Fnew", /New inspection template/],
  ["/assets/inspections", "%2Fassets%2Finspections", /Blocked assets|Overdue/],
];

test.describe("asset inspections — the M4 surfaces sit behind the auth wall", () => {
  for (const [path, next, marker] of M4_PAGES) {
    test(`a logged-out visitor to ${path} is sent to /login, nothing painted`, async ({
      page,
    }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${next}`));
      await expect(page.getByText(marker)).toHaveCount(0);
      await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
    });
  }

  test("a logged-out visit to an inspection run URL is sent to /login, checklist never paints", async ({
    page,
  }) => {
    await page.goto(`/assets/${FAKE_ASSET}/inspections/${FAKE_INSPECTION}`);
    await expect(page).toHaveURL(/\/login\?next=/);
    await expect(page.getByRole("button", { name: /complete inspection/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });
});
