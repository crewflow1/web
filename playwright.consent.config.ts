import { defineConfig, devices } from "@playwright/test";
import { ARMED_TRACKER_ENV } from "./e2e/_consent-harness";

/**
 * Playwright config — the ARMED consent network proof.
 *
 *   npx playwright test --config playwright.consent.config.ts
 *
 * The default E2E tier (playwright.config.ts) runs e2e/consent-network.spec.ts
 * too, but against a build with NO tracker IDs — there the spec can only prove
 * the baseline ("nothing third-party loads, the banner stays dormant"). The
 * consent gates themselves are only exercised when a tracker is configured, so
 * this config boots its OWN dev server with DUMMY tracker IDs
 * (e2e/_consent-harness.ts — `.invalid` hosts that cannot resolve) and sets
 * E2E_CONSENT_ARMED so the spec runs its full reject / accept / withdraw /
 * customise matrix. A missing gate then fires a real request at the dummy
 * host, which the spec intercepts — nothing leaves the machine.
 *
 * Why a dev server and not `next start`: NEXT_PUBLIC_* values are inlined at
 * BUILD time, so arming a production build means a second full `next build`
 * with different public env — and both builds write the same `.next`. `next
 * dev` reads the env at boot. The consent code path is identical in both.
 * For the same reason this must not share a `.next` with a concurrent
 * production-build E2E run (run it as its own job / step).
 *
 * Service workers are blocked (as in the default config) so that every request
 * is page-initiated and therefore both recorded and intercepted.
 */
const PORT = Number(process.env.CONSENT_E2E_PORT ?? 3101);
const baseURL = `http://localhost:${PORT}`;

// Read by the spec (same process tree) to switch on the armed assertions.
process.env.E2E_CONSENT_ARMED = "1";
process.env.PLAYWRIGHT_BASE_URL = baseURL;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /consent-network\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  // `next dev` compiles each route on first hit.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "off",
    serviceWorkers: "block",
    navigationTimeout: 120_000,
    /**
     * posthog-js refuses to capture events when `navigator.webdriver` is true
     * (its bot filter), which would leave the "tracking really starts / really
     * stops" assertions looking only at its config fetches. Dropping the
     * automation flag makes the SDK behave exactly as it does for a real
     * visitor, so real `$pageview` batches are what the spec sees gated.
     */
    launchOptions: { args: ["--disable-blink-features=AutomationControlled"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: baseURL,
    // Never reuse by default: a server already on this port may have been
    // started WITHOUT the dummy tracker IDs, which would turn the proof into a
    // no-op. CONSENT_E2E_REUSE_SERVER=1 is for local iteration against a server
    // you started yourself with ARMED_TRACKER_ENV; the spec still fails loudly
    // if the banner (i.e. the armed env) is missing.
    reuseExistingServer: process.env.CONSENT_E2E_REUSE_SERVER === "1",
    timeout: 240_000,
    env: { ...(process.env as Record<string, string>), ...ARMED_TRACKER_ENV },
  },
});
