import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyRequest, isCacheable } from "@/lib/pwa/cache-policy";
import { shouldReloadOnControllerChange } from "@/lib/pwa/sw-lifecycle";

/**
 * PWA service worker — security source-contracts (§37/§51). The worker must NEVER
 * write private/authenticated/blueprint/signed-URL responses to CacheStorage. The
 * runtime behaviour is proven in a real browser in e2e/pwa-offline.spec.ts; these
 * lock the rules at the source.
 */

const root = join(__dirname, "..", "..");
const sw = readFileSync(join(root, "public/sw.js"), "utf8");
const manifest = readFileSync(join(root, "app/manifest.ts"), "utf8");
const signOut = readFileSync(join(root, "app/(app)/_components/sign-out-button.tsx"), "utf8");
const swRegister = readFileSync(join(root, "app/(app)/_components/sw-register.tsx"), "utf8");
const offlineControls = readFileSync(join(root, "app/(app)/jobs/[id]/blueprints/_offline-controls.tsx"), "utf8");

describe("cache policy — deny by default", () => {
  it("only static + icon are cacheable; private/blueprint/navigation/passthrough are NOT", () => {
    expect(isCacheable("static")).toBe(true);
    expect(isCacheable("icon")).toBe(true);
    for (const c of ["private", "blueprint", "navigation", "passthrough"] as const) expect(isCacheable(c)).toBe(false);
  });
  it("blueprint bytes + api + supabase are never cacheable", () => {
    expect(isCacheable(classifyRequest({ pathname: "/jobs/x/blueprints/f/v", sameOrigin: true, mode: "cors", method: "GET" }))).toBe(false);
    expect(isCacheable(classifyRequest({ pathname: "/api/x", sameOrigin: true, mode: "cors", method: "GET" }))).toBe(false);
    expect(isCacheable(classifyRequest({ pathname: "/x", sameOrigin: false, mode: "cors", method: "GET" }))).toBe(false); // cross-origin (Supabase/signed URL)
  });
});

describe("sw.js — worker source enforces the allowlist", () => {
  it("only writes cache for same-origin static + shell assets", () => {
    // the single caches.put is gated on isStaticAsset/isShellAsset + res.type === "basic"
    expect(sw).toMatch(/isStaticAsset\(url\.pathname\)\s*\|\|\s*isShellAsset\(url\.pathname\)/);
    expect(sw).toMatch(/res\.type === "basic"/);
    // exactly one cache write path
    expect((sw.match(/\.put\(/g) ?? []).length).toBe(1);
  });
  it("navigations are network-first with an OFFLINE shell fallback — never cached", () => {
    expect(sw).toMatch(/request\.mode === "navigate"/);
    expect(sw).toMatch(/fetch\(request\)\.catch/);
    expect(sw).toMatch(/match\(OFFLINE_URL\)/);
  });
  it("never handles signed URLs / tokens (no credential caching)", () => {
    // credential-handling identifiers that must never appear as CODE (comments
    // legitimately describe what is NOT cached, so match specific API/token forms)
    expect(sw).not.toMatch(/createSignedUrl|\?token=|access_token|refresh_token/);
    // no blanket "cache every GET"
    expect(sw).not.toMatch(/caches\.open\([^)]*\)\.then\(\s*\(?c\)?\s*=>\s*c\.put\(request\)\s*\)/);
  });
  it("versioned caches + activate cleanup of old crewflow-pwa caches", () => {
    expect(sw).toMatch(/CACHE_VERSION\s*=\s*"v\d+"/);
    expect(sw).toMatch(/startsWith\(CACHE_PREFIX\)\s*&&\s*!CURRENT_CACHES\.includes/);
    expect(sw).toMatch(/caches\.delete/);
  });
  it("does NOT skipWaiting on its own — waits for the app's SKIP_WAITING (no mid-session swap)", () => {
    expect(sw).toMatch(/type === "SKIP_WAITING"/);
    // install must not CALL self.skipWaiting() (a comment mentioning it is fine)
    const install = sw.slice(sw.indexOf('addEventListener("install"'), sw.indexOf('addEventListener("activate"'));
    expect(install).not.toMatch(/self\.skipWaiting\(\)/);
  });
});

describe("manifest + logout", () => {
  it("manifest ships PNG 192/512 + a maskable icon", () => {
    expect(manifest).toMatch(/icon-192\.png/);
    expect(manifest).toMatch(/icon-512\.png/);
    expect(manifest).toMatch(/maskable/);
  });
  it("logout clears the offline identity marker + IndexedDB before signOut", () => {
    expect(signOut).toMatch(/clearAll\(\);\s*clearOfflineIdentity\(\)/);
    expect(signOut.indexOf("clearOfflineIdentity")).toBeLessThan(signOut.indexOf("await signOut()"));
  });
});

describe("service-worker lifecycle — first install is silent, only user-accepted updates reload", () => {
  it("reloads ONLY on a user-accepted update, never on the first-install claim", () => {
    expect(shouldReloadOnControllerChange(false, false)).toBe(false); // first-install claim → no reload
    expect(shouldReloadOnControllerChange(true, false)).toBe(true); // user clicked Refresh → reload once
    expect(shouldReloadOnControllerChange(true, true)).toBe(false); // single-fire guard holds
    expect(shouldReloadOnControllerChange(false, true)).toBe(false);
  });

  it("SwRegister gates the controllerchange reload behind a user-intent ref (no unconditional reload)", () => {
    expect(swRegister).toMatch(/controllerchange/);
    // the reload must be gated by the pure policy on a user-intent ref, not fire unconditionally
    expect(swRegister).toMatch(/shouldReloadOnControllerChange\(\s*userAcceptedUpdate\.current/);
    expect(swRegister).toMatch(/const\s+userAcceptedUpdate\s*=\s*useRef\(false\)/);
    // the ref is armed BEFORE asking the SW to skip waiting (so the update reload still fires)
    expect(swRegister).toMatch(/userAcceptedUpdate\.current\s*=\s*true[\s\S]*?SKIP_WAITING/);
  });

  it("the download flow warms the OFFLINE SHELL's own /_next/static chunks, claim-first and verified", () => {
    // This test previously pinned `document.querySelectorAll("script[src], link[href]")`
    // — scraping THIS document's tags. That was the bug: it can only ever cache the
    // blueprints route's chunks, never /offline's own page chunk, so the shell was
    // served offline but could not HYDRATE ("Checking…" forever). The contract is now
    // the correct mechanism, so the old approach cannot silently return.
    expect(offlineControls).toMatch(/_next\/static/);
    // 1. fetch the shell ROUTE and parse the assets IT references (not this document's)
    expect(offlineControls).toMatch(/fetch\(\s*["'`]\/offline["'`]/);
    expect(offlineControls).not.toMatch(/script\[src\], link\[href\]/);
    // 2. router.prefetch is fire-and-forget (returns nothing awaitable) — it must not
    //    be how the shell is warmed.
    expect(offlineControls).not.toMatch(/router\.prefetch\(\s*["'`]\/offline["'`]/);
    // 3. claim BEFORE warming: clients.claim() only routes FUTURE fetches, so a warm
    //    started while uncontrolled is never cached.
    const claimIdx = offlineControls.search(/serviceWorker\.controller/);
    const warmIdx = offlineControls.search(/fetch\(\s*["'`]\/offline["'`]/);
    expect(claimIdx).toBeGreaterThan(-1);
    expect(warmIdx).toBeGreaterThan(claimIdx);
    // 4. VERIFY the cache actually holds it before claiming offline-readiness.
    expect(offlineControls).toMatch(/caches\.match\(/);
    expect(offlineControls).toMatch(/data-offline-shell-ready/);
  });
});
