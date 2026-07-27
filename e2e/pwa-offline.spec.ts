import { test, expect } from "@playwright/test";

/**
 * PWA offline application shell (Programme F) — REAL browser offline, no mocks.
 * Proves: the service worker registers + controls the page; with the network
 * genuinely OFF (`context.setOffline(true)`), CrewFlow boots its own offline shell
 * (not Chrome's error page); the shell lists the device's downloaded drawings and
 * opens the REAL viewer from Programme E IndexedDB; a deep-link into an
 * authenticated route while offline recovers to the shell; reconnect restores
 * normal operation.
 */

const JOB = "00000000-0000-0000-0000-000000000000";

// This IS the PWA spec — re-enable the service worker that the global config
// blocks by default (see playwright.config.ts). The offline journeys below need
// a real, registered, controlling SW.
test.use({ serviceWorkers: "allow" });

test.describe("pwa — installability assets are public", () => {
  test("manifest, service worker, and icons are served to a logged-out visitor (no 307)", async ({ request }) => {
    for (const [path, type] of [["/manifest.webmanifest", /json|manifest/], ["/sw.js", /javascript/], ["/icons/icon-192.png", /image\/png/]] as const) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
      expect(res.headers()["content-type"] ?? "", path).toMatch(type);
    }
  });
  test("the /offline shell renders for a logged-out visitor (public, precacheable)", async ({ page }) => {
    await page.goto("/offline");
    await expect(page.getByRole("heading", { name: /offline|online/i })).toBeVisible();
  });
});

test.describe("pwa — authenticated real-offline journey", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  test(
    "download → SW controls page → REAL offline → offline shell → open cached drawing → deep-link → reconnect",
    async ({ page, context }) => {
      // 1. Authenticated page registers the SW + downloads the drawing for offline.
      await page.goto(`/jobs/${JOB}/blueprints`);
      await page.getByRole("button", { name: /Download for offline/ }).first().click();
      await expect(page.locator("[data-offline-available]").first()).toBeVisible();

      // 2. Wait for the service worker to be active AND controlling this page.
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });

      // 3. REAL network offline. `context.setOffline` only cuts the PAGE thread —
      //    the service-worker thread keeps reaching the network, so it never
      //    exercises the SW's offline navigation fallback. Aborting every request at
      //    the context layer cuts BOTH threads: the page's byte fetches AND the
      //    worker's own fetch(). Nothing is served except from CacheStorage /
      //    IndexedDB — a genuine, strict offline.
      const killNetwork = (route: import("@playwright/test").Route) => route.abort("internetdisconnected");
      await context.setOffline(true);
      await context.route("**/*", killNetwork);

      // 4. Navigate — the SW serves the precached offline shell, not a network error.
      await page.goto("/offline");
      await expect(page.getByText("Drawings on this device")).toBeVisible();
      await expect(page.getByText("A-201 GA Plan").first()).toBeVisible(); // the downloaded drawing is listed

      // 5. Open it — the REAL viewer paints from Programme E IndexedDB.
      await page.getByRole("button", { name: "Open" }).first().click();
      const dialog = page.getByRole("dialog", { name: /Drawing viewer/ });
      await expect(dialog.locator("canvas[data-rendered-page]")).toBeVisible();
      await expect(dialog.locator("[data-offline-copy]")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "+ Add pin" })).toBeDisabled();
      await page.keyboard.press("Escape");

      // 6. COLD deep-link into an authenticated route while offline → recovers to the
      //    shell (§8), never Chrome's network-error screen, never an infinite spinner.
      //    Must be a route NOT visited this session: a warm URL (e.g. the blueprints
      //    page from step 1) is restored from the browser's bfcache, which bypasses the
      //    service worker and so would never exercise the offline navigation fallback.
      //    The job overview is authenticated, requires the network, and is cold here.
      await page.goto(`/jobs/${JOB}`);
      await expect(page.getByText("Drawings on this device")).toBeVisible();

      // 7. Reconnect → normal operation resumes.
      await context.unroute("**/*", killNetwork);
      await context.setOffline(false);
      await page.goto(`/jobs/${JOB}/blueprints`);
      await expect(page.getByRole("heading", { name: "Drawings" })).toBeVisible();
    },
  );
});

test.describe("pwa — the service worker cache never holds private data (§37 adversarial)", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  test(
    "after an authenticated download + browsing, CacheStorage contains ONLY allowlisted public assets",
    async ({ page }) => {
      // Exercise every surface the worker could wrongly cache: download the bytes,
      // load authenticated HTML, hit the API + the blueprint serve route + Supabase.
      await page.goto(`/jobs/${JOB}/blueprints`);
      await page.getByRole("button", { name: /Download for offline/ }).first().click();
      await expect(page.locator("[data-offline-available]").first()).toBeVisible();
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await page.goto("/dashboard");
      await page.goto(`/jobs/${JOB}/blueprints`);

      // Inspect the REAL CacheStorage the worker wrote (not the source, the runtime).
      const cached = await page.evaluate(async () => {
        const out: string[] = [];
        for (const name of await caches.keys()) {
          const cache = await caches.open(name);
          for (const req of await cache.keys()) out.push(req.url);
        }
        return out;
      });

      // Sanity: the worker IS caching (the allowlist isn't vacuously empty).
      expect(cached.length).toBeGreaterThan(0);

      const origin = new URL(page.url()).origin;
      const isAllowed = (u: string) => {
        let url: URL;
        try { url = new URL(u); } catch { return false; }
        if (url.origin !== origin) return false; // no cross-origin (Supabase/signed URLs)
        const p = url.pathname;
        return (
          p.startsWith("/_next/static/") ||
          p === "/offline" || p === "/manifest.webmanifest" ||
          p === "/icon.svg" || p === "/favicon.ico" ||
          p.startsWith("/icons/") || p === "/pdf.worker.min.mjs"
        );
      };
      // Every single cached entry must be a public, non-identifying asset.
      const leaked = cached.filter((u) => !isAllowed(u));
      expect(leaked, `SW cached non-allowlisted (potentially private) URLs: ${leaked.join(", ")}`).toEqual([]);
      // Belt-and-braces: no blueprint bytes, no API, no authenticated HTML, no tokens.
      expect(cached.some((u) => /\/blueprints\/f\/|\/api\/|access_token|\?token=|54321/.test(u))).toBe(false);
    },
  );
});
