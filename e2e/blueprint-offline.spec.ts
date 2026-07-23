import { test, expect } from "@playwright/test";

/**
 * Blueprint Offline Read (Programme E) — boundary + a REAL authenticated journey
 * via the #409 harness. Proves the actual viewer renders a drawing from locally
 * cached bytes when byte delivery fails, shows OFFLINE COPY, and disables editing.
 *
 * The offline trigger is a Playwright ROUTE BLOCK of the same-origin serve route
 * (`/jobs/*​/blueprints/f/*`) — the app shell, pdf.js worker and auth stay served,
 * so this isolates OFFLINE DOCUMENT DATA (Programme E) from the OFFLINE APP SHELL
 * (a service worker / PWA = Programme F). No service worker is involved.
 */

const JOB = "00000000-0000-0000-0000-000000000000";
const F_ROUTE = "**/jobs/**/blueprints/f/**";

test.describe("blueprint offline — stays behind the auth wall", () => {
  test("a logged-out visitor never sees the Download-for-offline control", async ({ page }) => {
    await page.goto(`/jobs/${JOB}/blueprints`);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: /Download for offline/ })).toHaveCount(0);
  });
});

test.describe("blueprint offline — authenticated download → offline open → remove", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  test(
    "download → available offline → block network → viewer renders from cache → OFFLINE COPY → editing disabled → remove",
    async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      // The test deliberately aborts the /f/ serve route, so Chromium logs network
      // failures ("Failed to load resource: net::ERR_FAILED"). Those are expected;
      // real app errors (which our loader swallows into the graceful fallback) are not.
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const t = m.text();
        if (t.includes("/blueprints/f/") || t.includes("ERR_FAILED") || t.includes("Failed to load resource")) return;
        errors.push(t);
      });

      await page.goto(`/jobs/${JOB}/blueprints`);

      // 1. Download the current revision for offline use
      await page.getByRole("button", { name: /Download for offline/ }).first().click();
      await expect(page.locator("[data-offline-available]").first()).toBeVisible();

      // the bytes really landed in IndexedDB (not just a UI flag)
      const cachedCount = await page.evaluate(async () => {
        const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("crewflow-blueprints-offline"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        return await new Promise<number>((res) => { const c = db.transaction("drawings").objectStore("drawings").count(); c.onsuccess = () => res(c.result); });
      });
      expect(cachedCount).toBeGreaterThan(0);

      // 2. Kill byte delivery — shell + worker stay served
      await page.route(F_ROUTE, (r) => r.abort());

      // 3. Open the viewer → it renders from the cached bytes
      await page.getByRole("button", { name: "View" }).first().click();
      const dialog = page.getByRole("dialog", { name: /Drawing viewer/ });
      await expect(dialog.locator("canvas[data-rendered-page]")).toBeVisible();

      // 4. OFFLINE COPY indicator + editing disabled (§16, §26)
      await expect(dialog.locator("[data-offline-copy]")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "+ Add pin" })).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "✎ Markup" })).toBeDisabled();
      await page.keyboard.press("Escape");

      // 5. Restore network + remove the offline copy
      await page.unroute(F_ROUTE);
      await page.getByRole("button", { name: "Remove" }).first().click();
      await expect(page.locator("[data-offline-available]")).toHaveCount(0);

      // 6. With it removed, blocking the route again yields the honest error card (no fake render)
      await page.route(F_ROUTE, (r) => r.abort());
      await page.getByRole("button", { name: "View" }).first().click();
      await expect(page.getByRole("dialog", { name: /Drawing viewer/ }).getByText(/Couldn.t render this drawing/)).toBeVisible();

      expect(errors, `unexpected errors: ${errors.join(" | ")}`).toEqual([]);
    },
  );

  test("Sign out purges the offline cache — shared-device gate (§19)", async ({ page }) => {
    const count = async () =>
      page.evaluate(async () => {
        const names = await indexedDB.databases?.();
        if (names && !names.some((d) => d.name === "crewflow-blueprints-offline")) return 0;
        const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("crewflow-blueprints-offline"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        return await new Promise<number>((res) => { const c = db.transaction("drawings").objectStore("drawings").count(); c.onsuccess = () => res(c.result); c.onerror = () => res(0); });
      });

    await page.goto(`/jobs/${JOB}/blueprints`);
    await page.getByRole("button", { name: /Download for offline/ }).first().click();
    await expect(page.locator("[data-offline-available]").first()).toBeVisible();
    expect(await count(), "cached before logout").toBeGreaterThan(0);

    // the REAL sign-out control (purges offline cache before the server action)
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);

    // User A's cached drawing bytes are gone — a next user on this shared device sees nothing
    expect(await count(), "offline cache purged on logout").toBe(0);
  });
});
