import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config — gate 6 of the mandatory pipeline (Directive #004, E2E).
 *
 * The E2E tier boots the REAL Next.js production build (`next start`) against
 * the REAL Supabase local stack in CI and drives a real browser — no mocks,
 * no stubs. It proves the cross-cutting invariants an actual request hits:
 * the auth redirect contract (logged-out → /login, destination preserved),
 * the baseline security response headers, and that the public + auth surfaces
 * render. Feature-flow specs attach here as Phase 0+ surfaces land.
 *
 * Determinism (Ch.18 flake policy — "a re-run that goes green is not a pass"):
 *   - retries: 0 everywhere. A flaky E2E is a defect to fix, never to paper
 *     over with a retry that masks a real race.
 *   - workers: 1 in CI so specs can't race on the single shared Postgres.
 *   - forbidOnly in CI so a stray `test.only` can never silently narrow the run.
 */
const PORT = 3000;
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  /**
   * Authenticated-E2E harness (task #25): seeds a deterministic org/user/job/
   * blueprint + real PDF into the local Supabase and writes a Playwright
   * storageState (e2e/.auth/owner.json). Specs opt in with
   * `test.use({ storageState: "e2e/.auth/owner.json" })`; the logged-out
   * boundary specs stay anonymous (no project-level storageState). CI-safe:
   * Node-only, service-role key already in the e2e job env, no app/auth change.
   */
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "off",
    /**
     * Service workers OFF by default (Programme F is a cross-cutting PWA layer,
     * not part of most features). The SW registers on every authenticated page
     * and performs a one-time reload when it first CLAIMS the page — correct PWA
     * behaviour, and load-bearing for the offline flow, but it races any spec that
     * navigates then immediately interacts/evaluates (axe scans, multi-step forms,
     * pdf.js canvas dialogs) with "Execution context was destroyed". Scoping the SW
     * to the specs that actually exercise it removes that interference at the source
     * (not a retry mask); the PWA specs (pwa-offline, blueprint-offline,
     * pwa-first-install-no-reload) re-enable it with `serviceWorkers: "allow"`.
     * The SW is invisible to the accessibility tree and to online feature
     * flows, so nothing under test loses coverage.
     */
    serviceWorkers: "block",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  /**
   * Playwright starts the app itself and waits for it to answer on `url`.
   * `next start` serves the production build (created in the CI step just
   * before `npm run test:e2e`), so the headers + redirects under test are the
   * PRODUCTION code paths, not `next dev`'s relaxed ones. The spawned server
   * inherits this process's env (the Supabase connection mapped in CI).
   */
  webServer: {
    command: "npm run start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
