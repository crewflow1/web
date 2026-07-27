import { test, expect } from "@playwright/test";

/**
 * Asset QR E2E — gate 6 for the Asset Management QR platform (M3a identity →
 * M3b scan/labels/scanner).
 *
 * Runs against the REAL production build (`next start`) on the REAL Supabase
 * local stack. Like every spec in this tier, it proves the one identity an
 * unauthenticated E2E can assert DETERMINISTICALLY — the anonymous visitor —
 * which for the QR platform is the single most important request-boundary
 * property: **a scanned asset QR never resolves, and the scanner surface never
 * paints, for a caller without a session.** A printed label that leaks a phone
 * into an authenticated resolver is exactly the risk this closes.
 *
 *   - GET /a/<token>       (the scan resolver a phone camera opens) → caught by
 *     middleware, 307 → /login with the destination preserved. The asset
 *     landing never paints; no asset/custody data reaches an anonymous caller,
 *     for a well-formed token or junk alike (identical redirect — no oracle).
 *   - GET /assets/scan     (the in-app scanner entry) → same auth wall; the
 *     scanner UI never paints.
 *
 * The full create → generate → label → scan → custody → regenerate LIFECYCLE is
 * proven DETERMINISTICALLY one tier down, against real Postgres, where those
 * data invariants belong and can't flake:
 *   - __tests__/integration/rls/asset-qr.test.ts        (one-active, atomic rotate…)
 *   - __tests__/integration/rls/asset-qr-scan.test.ts   (resolve/deny per tenant + state)
 *   - __tests__/assets/label-pdf.test.ts                (label + sheet render)
 * An AUTHENTICATED browser lifecycle E2E needs a logged-in session, which this
 * passwordless (magic-link/OTP) app has no harness for in the E2E tier yet;
 * that harness is its own reviewed increment, tracked in docs/asset-management.md.
 *
 * Determinism (Ch.18 flake policy): the real GoTrue is up in CI, so a logged-
 * out visit is a clean "no user" (not the fail-safe pass-through of a genuinely-
 * unreachable auth), and the middleware redirect fires exactly as in production.
 */

// A well-formed-but-nonexistent token: proves the redirect happens BEFORE any
// resolution, so a real-shaped scan discloses nothing to an anonymous caller.
const FAKE_TOKEN = "e2eFakeToken000000000000";

test.describe("asset QR — the scan resolver sits behind the auth wall", () => {
  test("a logged-out scan of /a/<token> is sent to /login, destination preserved, nothing painted", async ({
    page,
  }) => {
    await page.goto(`/a/${FAKE_TOKEN}`);
    // Redirect AND the round-tripped destination, in one assertion.
    await expect(page).toHaveURL(
      new RegExp(`/login\\?next=%2Fa%2F${FAKE_TOKEN}`),
    );
    // The scan landing never paints for an anonymous caller…
    await expect(page.getByRole("link", { name: /view asset/i })).toHaveCount(0);
    // …they land on the sign-in page instead.
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });
});

test.describe("asset QR — the in-app scanner entry sits behind the auth wall", () => {
  test("a logged-out visit to /assets/scan is sent to /login, scanner never paints", async ({
    page,
  }) => {
    await page.goto("/assets/scan");
    await expect(page).toHaveURL(/\/login\?next=%2Fassets%2Fscan/);
    await expect(
      page.getByRole("heading", { name: "Scan an asset" }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });
});
