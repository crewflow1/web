import { describe, it, expect } from "vitest";
import {
  classifyRequest, isCacheable, CACHE_VERSION, CURRENT_CACHES, OFFLINE_URL, PRECACHE_URLS,
} from "@/lib/pwa/cache-policy";

const req = (pathname: string, over: Partial<{ sameOrigin: boolean; mode: string; method: string }> = {}) =>
  classifyRequest({ pathname, sameOrigin: true, mode: "cors", method: "GET", ...over });

describe("classifyRequest — the cache allowlist (deny by default)", () => {
  it("classifies Next hashed static assets as cacheable static", () => {
    expect(req("/_next/static/chunks/main-abc.js")).toBe("static");
    expect(isCacheable("static")).toBe(true);
  });
  it("classifies PWA icons + shell assets as cacheable icon", () => {
    for (const p of ["/icon.svg", "/favicon.ico", "/manifest.webmanifest", "/icons/icon-192.png", OFFLINE_URL]) {
      expect(req(p), p).toBe("icon");
    }
    expect(isCacheable("icon")).toBe(true);
  });
  it("classifies the public pdf.js worker as a cacheable shell asset (offline viewer needs it)", () => {
    expect(req("/pdf.worker.min.mjs")).toBe("icon");
    expect(isCacheable(req("/pdf.worker.min.mjs"))).toBe(true);
  });
  it("classifies top-level navigations as navigation (network-first, NOT cached)", () => {
    expect(req("/", { mode: "navigate" })).toBe("navigation");
    expect(req("/login", { mode: "navigate" })).toBe("navigation");
    expect(isCacheable("navigation")).toBe(false);
  });

  it("NEVER caches private/authenticated surfaces (network-only)", () => {
    for (const p of [
      "/api/jobs", "/auth/callback", "/invoices", "/quotes", "/customers", "/suppliers",
      "/finances", "/payroll", "/staff", "/portal/x", "/admin/research", "/dashboard",
      "/documents", "/reports", "/site-reports", "/diary", "/toolbox", "/snags", "/assets", "/onboarding",
    ]) {
      expect(req(p, { mode: "navigate" }), p).toBe("private");
      expect(isCacheable("private")).toBe(false);
    }
  });

  it("NEVER caches blueprint bytes — Programme E IndexedDB owns them", () => {
    expect(req("/jobs/abc/blueprints/f/ver-1")).toBe("blueprint");
    expect(isCacheable("blueprint")).toBe(false);
    // the blueprints register page is private too
    expect(req("/jobs/abc/blueprints", { mode: "navigate" })).toBe("private");
  });

  it("NEVER caches cross-origin (Supabase / signed URLs / telemetry)", () => {
    expect(req("/storage/v1/object/sign/x", { sameOrigin: false })).toBe("private");
    expect(req("/anything", { sameOrigin: false, mode: "navigate" })).toBe("private");
    expect(isCacheable("private")).toBe(false);
  });

  it("NEVER caches non-GET", () => {
    expect(req("/_next/static/x.js", { method: "POST" })).toBe("private");
    expect(req("/icon.svg", { method: "HEAD" })).toBe("private");
  });

  it("passes through other same-origin GETs without caching", () => {
    expect(req("/_next/image?url=x")).toBe("passthrough");
    expect(isCacheable("passthrough")).toBe(false);
  });
});

describe("cache versioning", () => {
  it("exposes a versioned namespace + a current-caches allowlist for activate cleanup", () => {
    expect(CACHE_VERSION).toBeTruthy();
    expect(CURRENT_CACHES.every((c) => c.includes(CACHE_VERSION))).toBe(true);
    expect(CURRENT_CACHES.length).toBeGreaterThanOrEqual(2);
  });
  it("precaches the offline shell + icons", () => {
    expect(PRECACHE_URLS).toContain(OFFLINE_URL);
    expect(PRECACHE_URLS.some((u) => u.includes("icon-192"))).toBe(true);
  });
});
