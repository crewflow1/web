import { test, expect } from "@playwright/test";

/**
 * PWA service-worker lifecycle (Programme F) — FIRST INSTALL MUST BE SILENT.
 *
 * The service worker registers on every authenticated page and, on first install,
 * activates and clients.claim()s the page so future navigations are SW-controlled
 * and the offline shell works. That claim fires a `controllerchange`, and the app
 * MUST NOT reload the page in response — a first-install reload would flash a
 * navigation out from under a first-time visitor and lose unsaved form input.
 * (A genuine, user-accepted UPDATE reloads on the user's Refresh click — proven at
 * the unit tier in __tests__/security/pwa-worker.test.ts, since `next start` serves
 * an immutable /sw.js so a real byte-changed update can't be simulated in-browser.)
 *
 * These are REAL-browser tests with the service worker ENABLED (the global config
 * blocks SWs by default; this spec re-enables it because it is exactly what's under
 * test). Reload is detected three independent ways: a main-frame navigation counter,
 * a document-start "controller at start" canary (re-runs on any reload), and a live
 * window sentinel (wiped iff the document is replaced).
 */

test.use({ storageState: "e2e/.auth/owner.json", serviceWorkers: "allow" });

test.describe("pwa — first install must NOT reload the current page", () => {
  test("register → install → activate → claim, and the page never reloads", async ({ page }) => {
    // Runs at document-start on EVERY load, including any reload. On a clean first
    // install the live document is the original uncontrolled load → "uncontrolled";
    // a spurious post-claim reload would make it "controlled".
    await page.addInitScript(() => {
      (window as unknown as { __ctrlAtStart: string }).__ctrlAtStart =
        navigator.serviceWorker && navigator.serviceWorker.controller ? "controlled" : "uncontrolled";
    });

    await page.goto("/health-safety/new");
    await expect(page.getByRole("heading", { name: "New risk assessment" })).toBeVisible();

    // Precondition: this navigation began with NO controlling SW (a genuine first install).
    expect(await page.evaluate(() => (window as unknown as { __ctrlAtStart: string }).__ctrlAtStart)).toBe("uncontrolled");

    // Primary signal: count main-frame navigations from HERE on (a reload is one).
    let mainNavs = 0;
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) mainNavs++; });
    // Corroborating sentinel on the live window object (wiped iff the document is replaced).
    await page.evaluate(() => { (window as unknown as { __beacon: string }).__beacon = "alive"; });

    // Let the SW install, activate and CLAIM this page — the exact moment the old defect fired.
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    await page.waitForTimeout(1000); // bounded settle — any claim-triggered reload would fire well within this

    expect(mainNavs, "no main-frame navigation may occur on the first-install claim").toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __ctrlAtStart: string }).__ctrlAtStart)).toBe("uncontrolled"); // still the ORIGINAL document
    expect(await page.evaluate(() => (window as unknown as { __beacon?: string }).__beacon)).toBe("alive"); // window not replaced
    await expect(page.getByRole("heading", { name: "New risk assessment" })).toBeVisible(); // UI intact
    await expect(page.getByText("A new version of CrewFlow is available.")).toHaveCount(0); // no update prompt on first install
  });

  test("typed, unsaved form input survives the SW install + claim", async ({ page }) => {
    await page.goto("/health-safety/new");
    const title = "Working at height — scaffold erection DRAFT";
    const activity = "Strip and re-cover the flat roof to the rear elevation";
    await page.locator("#title").fill(title);
    await page.locator("#activity").fill(activity);

    let mainNavs = 0;
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) mainNavs++; });

    // The SW installs + claims while the user is mid-form (do NOT submit).
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    await page.waitForTimeout(1000);

    // The unsaved input survives — no reload cleared it.
    expect(mainNavs, "no reload may wipe the in-progress form").toBe(0);
    await expect(page.locator("#title")).toHaveValue(title);
    await expect(page.locator("#activity")).toHaveValue(activity);
  });
});
