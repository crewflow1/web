/*
 * CrewFlow PWA service worker (Programme F) — offline application shell.
 *
 * SECURITY: strict allowlist. Only Next hashed static assets and public PWA
 * shell assets (icons, manifest, /offline) are ever written to CacheStorage.
 * Authenticated navigations, /api/*, Supabase, signed URLs and blueprint bytes
 * are NEVER cached — blueprint document bytes are owned by Programme E's
 * IndexedDB, not this worker. Navigations are network-first and only fall back
 * to the precached public /offline shell when the network genuinely fails, so no
 * private HTML is ever stored or replayed across users.
 *
 * This mirrors lib/pwa/cache-policy.ts (a service worker can't import bundled
 * modules); __tests__/security/pwa-worker.test.ts asserts the rules below.
 *
 * UPDATE/ROLLBACK: cache names are versioned (CACHE_VERSION). A new worker
 * INSTALLS then WAITS (it does NOT skipWaiting on its own) so users are never
 * swapped mid-drawing; the app shows "New version — Refresh" and posts
 * SKIP_WAITING on user action. `activate` deletes every older crewflow-pwa-*
 * cache, so a bad version is fully replaced by shipping a bumped worker — no
 * user has to clear storage by hand.
 */

const CACHE_VERSION = "v1";
const CACHE_PREFIX = "crewflow-pwa";
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const SHELL_CACHE = `${CACHE_PREFIX}-shell-${CACHE_VERSION}`;
const CURRENT_CACHES = [STATIC_CACHE, SHELL_CACHE];
const OFFLINE_URL = "/offline";
const PRECACHE_URLS = [OFFLINE_URL, "/manifest.webmanifest", "/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  // Precache the public offline shell + icons. Do NOT skipWaiting — wait for the
  // app's explicit SKIP_WAITING so we never replace code mid-session.
  // Precache each shell asset independently (allSettled) so a single 404 can't
  // wipe the whole precache — the /offline shell must survive.
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(u))),
    ).catch(() => {}),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith(CACHE_PREFIX) && !CURRENT_CACHES.includes(n))
          .map((n) => caches.delete(n)), // old-version cleanup — no user trapped on a stale cache
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// ---------------------------------------------------------------------
// Web Push (RFC 8291). Payloads are encrypted end-to-end by the server
// (lib/notifications/push.ts) and delivered here decrypted by the browser.
// We only ever render fields the user has ALREADY been shown in-app (title,
// body) and deep-link to a same-origin RELATIVE path the server validated.
// ---------------------------------------------------------------------
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "CrewFlow";
  const url =
    typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//")
      ? data.url
      : "/notifications";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target =
    event.notification.data && typeof event.notification.data.url === "string"
      ? event.notification.data.url
      : "/notifications";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus an existing same-origin tab and navigate it, else open a new one.
      for (const client of all) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try { await client.navigate(target); } catch { /* cross-doc nav guard */ }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});

function sameOrigin(url) {
  try { return new URL(url).origin === self.location.origin; } catch { return false; }
}
function isStaticAsset(pathname) {
  return pathname.startsWith("/_next/static/");
}
function isShellAsset(pathname) {
  return (
    pathname === OFFLINE_URL || pathname === "/manifest.webmanifest" ||
    pathname === "/icon.svg" || pathname === "/favicon.ico" || pathname.startsWith("/icons/") ||
    // pdf.js render worker — a PUBLIC static asset (no auth, no user data) that the
    // offline drawing viewer cannot render without. Cache-first so a drawing saved
    // for offline is genuinely viewable with no network.
    pathname === "/pdf.worker.min.mjs"
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never touch non-GET

  const url = new URL(request.url);

  // Navigations: network-first; on genuine failure serve the public offline shell.
  // Authenticated HTML is fetched but NEVER cached — only the safe /offline page is served on failure.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(OFFLINE_URL)) || Response.error();
      }),
    );
    return;
  }

  // Only same-origin static + shell assets are cacheable (Class A/B).
  if (sameOrigin(request.url) && (isStaticAsset(url.pathname) || isShellAsset(url.pathname))) {
    event.respondWith(
      caches.match(request).then((hit) => {
        if (hit) return hit;
        return fetch(request).then((res) => {
          // only cache OK, basic (same-origin) responses
          if (res && res.ok && res.type === "basic") {
            const clone = res.clone();
            const cacheName = isStaticAsset(url.pathname) ? STATIC_CACHE : SHELL_CACHE;
            caches.open(cacheName).then((c) => c.put(request, clone)).catch(() => {});
          }
          return res;
        }).catch(() => caches.match(request).then((h) => h || Response.error()));
      }),
    );
    return;
  }

  // Everything else — private/api/supabase/signed-url/blueprint-bytes/passthrough:
  // NETWORK ONLY. Never written to CacheStorage.
});
