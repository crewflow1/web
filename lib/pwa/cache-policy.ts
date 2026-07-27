/**
 * PWA cache policy (Programme F) — the pure request classifier that governs what
 * the service worker may cache. This is the security core: get it wrong and a
 * shared tablet leaks one user's private data to another. It is unit-tested here
 * AND mirrored verbatim inside public/sw.js (a security test asserts the worker
 * enforces these rules), because a service worker can't import bundled modules.
 *
 * STRICT ALLOWLIST — the default is NEVER CACHE. Only Class A/B are cacheable.
 */

export type RequestClass =
  | "static"     // A — Next hashed immutable assets → cache-first
  | "icon"       // B — PWA icons / public shell assets → cache-first (bounded)
  | "navigation" // C — document navigations → network-first, fall back to /offline
  | "private"    // D — authenticated/API/Supabase/private HTML → NETWORK ONLY, never cached
  | "blueprint"  // E — blueprint bytes → owned by Programme E IndexedDB, SW never caches
  | "passthrough"; // everything else → network, not cached

/** The versioned cache namespace. Bump on any precache/asset-strategy change so
 *  `activate` can delete every older CrewFlow cache and no user is trapped. */
export const CACHE_VERSION = "v1";
export const CACHE_PREFIX = "crewflow-pwa";
export const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
export const SHELL_CACHE = `${CACHE_PREFIX}-shell-${CACHE_VERSION}`;
/** A CrewFlow PWA cache this version must NOT delete on activate. */
export const CURRENT_CACHES = [STATIC_CACHE, SHELL_CACHE];

/** The offline application-shell route (public, precached, no auth). */
export const OFFLINE_URL = "/offline";
/** Assets precached at install so the shell renders with no network. */
export const PRECACHE_URLS = [OFFLINE_URL, "/manifest.webmanifest", "/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];

/** Same-origin paths that are safe public shell assets (Class B). */
function isIconOrShellAsset(pathname: string): boolean {
  return (
    pathname === OFFLINE_URL ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/icon.svg" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/icons/") ||
    // pdf.js render worker — a PUBLIC static asset (no auth, no user data). The
    // offline drawing viewer cannot paint without it, so it is a Class B shell asset.
    pathname === "/pdf.worker.min.mjs"
  );
}

/**
 * Classify a request. `sameOrigin` = the request URL is same-origin as the app.
 * Cross-origin (Supabase storage/signed URLs, telemetry) is always private/passthrough
 * — never cached — so a signed URL can never enter CacheStorage.
 */
export function classifyRequest(input: { pathname: string; sameOrigin: boolean; mode: string; method: string }): RequestClass {
  const { pathname, sameOrigin, mode, method } = input;

  // Only GET is ever considered for caching.
  if (method !== "GET") return "private";

  // Cross-origin (incl. Supabase REST/storage + signed URLs + telemetry) — never cached.
  if (!sameOrigin) return "private";

  // D — authenticated / API / private HTML routes. NETWORK ONLY, never cached.
  //     Broad, deny-by-default over every private surface in the app.
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/jobs/") ||        // includes /jobs/*/blueprints/f/* (blueprint bytes) — see E
    pathname.startsWith("/invoices") || pathname.startsWith("/quotes") ||
    pathname.startsWith("/customers") || pathname.startsWith("/suppliers") ||
    pathname.startsWith("/finances") || pathname.startsWith("/payroll") ||
    pathname.startsWith("/staff") || pathname.startsWith("/portal") ||
    pathname.startsWith("/admin") || pathname.startsWith("/dashboard") ||
    pathname.startsWith("/documents") || pathname.startsWith("/reports") ||
    pathname.startsWith("/site-reports") || pathname.startsWith("/diary") ||
    pathname.startsWith("/toolbox") || pathname.startsWith("/snags") ||
    pathname.startsWith("/assets") || pathname.startsWith("/onboarding")
  ) {
    // E — blueprint bytes are a sub-case of /jobs/*; explicitly named so the
    //     intent is testable. Programme E's IndexedDB owns these; SW never caches.
    if (/^\/jobs\/[^/]+\/blueprints\/f\//.test(pathname)) return "blueprint";
    return "private";
  }

  // A — Next hashed immutable assets. Safe to cache-first (filename changes on deploy).
  if (pathname.startsWith("/_next/static/")) return "static";

  // B — safe public PWA shell assets.
  if (isIconOrShellAsset(pathname)) return "icon";

  // C — top-level document navigations (marketing/login/public) → network-first → /offline.
  if (mode === "navigate") return "navigation";

  // Everything else same-origin (e.g. /_next/image, misc GET) — pass through, don't cache.
  return "passthrough";
}

/** True only for classes the worker is permitted to write to CacheStorage. */
export function isCacheable(cls: RequestClass): boolean {
  return cls === "static" || cls === "icon";
}
