import { defineConfig, devices } from "@playwright/test";

/**
 * Visual-regression MECHANISM (minimal, maintainable) — chromium only.
 *
 * This establishes the pattern and ships ONE example; it is intentionally NOT
 * wired into the main CI e2e gate (gate 6). Committed baselines are platform-
 * specific — a macOS (darwin) baseline will not byte-match CI's Linux chromium —
 * so Playwright's default platform-suffixed snapshot names let each environment
 * own its baseline. Generate baselines in the environment that will assert them:
 *
 *   npm run test:e2e:visual -- --update-snapshots   # (re)generate baselines
 *   npm run test:e2e:visual                          # assert against baselines
 *
 * Spec files end in `.visual.ts` (NOT `.spec.ts`), so the default-testMatch main
 * Playwright config and the `__tests__/**` vitest configs never pick them up.
 * Baselines live next to the spec in `e2e/<spec>.visual.ts-snapshots/`.
 * Start with one; grow deliberately — do not mass-generate snapshots.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /\.visual\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: { baseURL },
  expect: {
    // Disable animations and allow a tiny sub-pixel/AA tolerance so the gate
    // fails on real layout/colour regressions, not on rendering noise.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled", scale: "css" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
