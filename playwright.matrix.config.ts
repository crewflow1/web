import { defineConfig, devices } from "@playwright/test";

/**
 * Cross-browser matrix — WebKit + Firefox, on the engine-portable critical spec.
 *
 * chromium runs the FULL suite in the main config (`playwright.config.ts`, CI
 * gate 6). This supplementary config proves the first-customer critical journeys
 * (`e2e/cross-browser-critical.spec.ts` — deliberately dependency-light: no
 * storageState, no seeded data) render identically on the other two engines.
 *
 * Run locally (install engines once with `npx playwright install webkit firefox
 * chromium`):
 *   npm run build && npm run test:e2e:cross-browser
 *
 * Repaired: `testDir` and `webServer.cwd` were previously hardcoded to a sibling
 * worktree absolute path (`/Users/moetalibi/Code/web-audit/...`), so the config
 * could not run in any other checkout or in CI. They are now relative to this
 * config's directory, and `reuseExistingServer` mirrors the main config
 * (reuse locally, never in CI). No test behaviour is changed.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /cross-browser-critical\.spec\.ts/,
  use: { baseURL },
  projects: [
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: {
    command: "npm run start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
