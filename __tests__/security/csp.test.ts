import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CSP_REPORT_PATH,
  NONCE_PATTERN,
  STATIC_POLICY_PREFIXES,
  buildCsp,
  cspClassForPath,
  cspHeaderName,
  generateNonce,
  isCspClassBoundaryCrossing,
  reportingEndpointsValue,
  resolveCspMode,
  resolveCspSources,
  type CspSources,
} from "@/lib/security/csp";

/**
 * Content-Security-Policy contract (lib/security/csp.ts).
 *
 * Pins the directives that make the policy worth having, so a future edit
 * that re-adds 'unsafe-eval', drops the nonce / strict-dynamic, widens an
 * origin to a wildcard, or silently flips the default mode fails CI.
 * Browser behaviour (no violations on real pages) is proved in e2e/csp.spec.ts.
 */

const PROD_SOURCES: CspSources = resolveCspSources({
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
});
const NONCE = "AAECAwQFBgcICQoLDA0ODw==";

const directivesOf = (policy: string) => policy.split(";").map((d) => d.trim());
const find = (policy: string, name: string) =>
  directivesOf(policy).find((d) => d === name || d.startsWith(`${name} `));

const noncePolicy = buildCsp({ nonce: NONCE, sources: PROD_SOURCES, upgradeInsecureRequests: true });
const staticPolicy = buildCsp({ sources: PROD_SOURCES, upgradeInsecureRequests: true });

describe("nonce + mode helpers", () => {
  it("generateNonce: 16 CSPRNG bytes, base64, accepted by Next's nonce parser, unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = generateNonce();
      expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(n).toMatch(NONCE_PATTERN);
      // Next.js: /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/ (get-script-nonce-from-header)
      expect(`'nonce-${n}'`).toMatch(/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/);
      seen.add(n);
    }
    expect(seen.size).toBe(200);
  });

  it("buildCsp refuses a malformed nonce (cannot smuggle directives)", () => {
    for (const bad of ["", "short", "abc'; script-src *", "AAECAwQFBgcICQoLDA0ODw== 'unsafe-inline'"]) {
      expect(() => buildCsp({ nonce: bad, sources: PROD_SOURCES, upgradeInsecureRequests: false }), bad).toThrow();
    }
  });

  it("resolveCspMode: enforce by default; only an explicit report-only relaxes", () => {
    expect(resolveCspMode(undefined)).toBe("enforce");
    expect(resolveCspMode("")).toBe("enforce");
    expect(resolveCspMode("enforce")).toBe("enforce");
    expect(resolveCspMode("report_only")).toBe("enforce");
    expect(resolveCspMode("report-only")).toBe("report-only");
    expect(resolveCspMode(" REPORT-ONLY ")).toBe("report-only");
    expect(cspHeaderName("enforce")).toBe("Content-Security-Policy");
    expect(cspHeaderName("report-only")).toBe("Content-Security-Policy-Report-Only");
  });
});

describe("NONCE policy (every dynamically rendered route)", () => {
  it("script-src is nonce + strict-dynamic, with NO unsafe-inline and NO unsafe-eval", () => {
    const script = find(noncePolicy, "script-src") ?? "";
    expect(script).toContain(`'nonce-${NONCE}'`);
    expect(script).toContain("'strict-dynamic'");
    expect(script).toContain("'self'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(noncePolicy).not.toContain("'unsafe-eval'");
  });

  it("keeps only 'wasm-unsafe-eval' (pdf.js WebAssembly codecs), never string eval", () => {
    expect(find(noncePolicy, "script-src")).toContain("'wasm-unsafe-eval'");
  });
});

describe("STATIC policy (prerendered pages only)", () => {
  it("has no nonce and no strict-dynamic (prerendered HTML carries no nonce)", () => {
    const script = find(staticPolicy, "script-src") ?? "";
    expect(script).not.toContain("'nonce-");
    expect(script).not.toContain("'strict-dynamic'");
    expect(script).toBe("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(staticPolicy).not.toContain("'unsafe-eval'");
  });
});

describe("directives shared by both policies", () => {
  for (const [label, policy] of [["nonce", noncePolicy], ["static", staticPolicy]] as const) {
    it(`${label}: locks down the dangerous defaults`, () => {
      expect(find(policy, "default-src")).toBe("default-src 'self'");
      expect(find(policy, "object-src")).toBe("object-src 'none'");
      expect(find(policy, "base-uri")).toBe("base-uri 'self'");
      expect(find(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
      expect(directivesOf(policy)).toContain("upgrade-insecure-requests");
    });

    it(`${label}: form-action allows only self + the redirect targets of our forms`, () => {
      expect(find(policy, "form-action")).toBe(
        "form-action 'self' https://abcdefgh.supabase.co https://accounts.google.com " +
          "https://login.microsoftonline.com https://checkout.stripe.com https://billing.stripe.com",
      );
    });

    it(`${label}: Supabase is the EXACT project origin (https + wss), never a wildcard`, () => {
      const connect = find(policy, "connect-src") ?? "";
      expect(connect).toContain("https://abcdefgh.supabase.co");
      expect(connect).toContain("wss://abcdefgh.supabase.co");
      expect(policy).not.toContain("*.supabase.co");
      expect(find(policy, "img-src")).toContain("https://abcdefgh.supabase.co");
    });

    it(`${label}: no wildcard / scheme-wide sources anywhere`, () => {
      for (const d of directivesOf(policy)) {
        const sources = d.split(/\s+/).slice(1);
        expect(sources, d).not.toContain("*");
        expect(sources, d).not.toContain("https:");
        expect(sources, d).not.toContain("http:");
      }
    });

    it(`${label}: style-src keeps 'unsafe-inline' (documented residual: style attributes)`, () => {
      expect(find(policy, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    });

    it(`${label}: reports to the same-origin sink via report-uri AND report-to`, () => {
      expect(find(policy, "report-uri")).toBe(`report-uri ${CSP_REPORT_PATH}`);
      expect(find(policy, "report-to")).toBe("report-to csp-endpoint");
    });

    it(`${label}: workers (pdf.js, service worker) are same-origin only`, () => {
      expect(find(policy, "worker-src")).toBe("worker-src 'self' blob:");
      expect(find(policy, "frame-src")).toBe("frame-src 'self'");
    });

    it(`${label}: no Stripe.js — Stripe appears only in form-action`, () => {
      expect(policy).not.toContain("js.stripe.com");
      const nonForm = directivesOf(policy).filter((d) => !d.startsWith("form-action"));
      expect(nonForm.join(";")).not.toContain("stripe.com");
    });
  }

  it("omits upgrade-insecure-requests when not served over https", () => {
    const p = buildCsp({ nonce: NONCE, sources: PROD_SOURCES, upgradeInsecureRequests: false });
    expect(directivesOf(p)).not.toContain("upgrade-insecure-requests");
  });
});

describe("environment-derived origins", () => {
  it("analytics + monitoring are absent while dark (no key / no DSN) and the toolbar off-preview", () => {
    for (const p of [noncePolicy, staticPolicy]) {
      expect(p).not.toContain("posthog");
      expect(p).not.toContain("sentry");
      expect(p).not.toContain("vercel.live");
      expect(p).not.toContain("pusher");
    }
  });

  it("PostHog (EU cloud) is allowed once configured: api + assets CDN", () => {
    const s = resolveCspSources({
      NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
      NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
    });
    const p = buildCsp({ nonce: NONCE, sources: s, upgradeInsecureRequests: true });
    expect(find(p, "connect-src")).toContain("https://eu.i.posthog.com");
    expect(find(p, "connect-src")).toContain("https://eu-assets.i.posthog.com");
    expect(find(p, "script-src")).toContain("https://eu-assets.i.posthog.com");
  });

  it("Sentry ingest is the exact DSN origin (no key material, no region wildcard)", () => {
    const s = resolveCspSources({
      NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
      NEXT_PUBLIC_SENTRY_DSN: "https://publickey@o123.ingest.de.sentry.io/456",
    });
    const p = buildCsp({ sources: s, upgradeInsecureRequests: true });
    expect(find(p, "connect-src")).toContain("https://o123.ingest.de.sentry.io");
    expect(p).not.toContain("publickey");
    expect(p).not.toContain("*.sentry.io");
  });

  it("the Vercel toolbar is allowed only on preview deployments", () => {
    const s = resolveCspSources({ NEXT_PUBLIC_SUPABASE_URL: "https://a.supabase.co", VERCEL_ENV: "preview" });
    const p = buildCsp({ nonce: NONCE, sources: s, upgradeInsecureRequests: true });
    expect(find(p, "script-src")).toContain("https://vercel.live");
    expect(find(p, "frame-src")).toContain("https://vercel.live");
    const prod = resolveCspSources({ NEXT_PUBLIC_SUPABASE_URL: "https://a.supabase.co", VERCEL_ENV: "production" });
    expect(buildCsp({ sources: prod, upgradeInsecureRequests: true })).not.toContain("vercel.live");
  });

  it("the local stack's http Supabase gets its ws:// realtime twin", () => {
    const s = resolveCspSources({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" });
    const p = buildCsp({ sources: s, upgradeInsecureRequests: false });
    expect(find(p, "connect-src")).toContain("http://127.0.0.1:54321 ws://127.0.0.1:54321");
  });

  it("Reporting-Endpoints pairs the report-to group with the sink", () => {
    expect(reportingEndpointsValue("https://crewflow.uk")).toBe('csp-endpoint="https://crewflow.uk/api/csp-report"');
    expect(reportingEndpointsValue()).toBe('csp-endpoint="/api/csp-report"');
  });
});

describe("route classification (which policy a path gets)", () => {
  it("prerendered marketing / legal / offline paths get the static policy", () => {
    for (const p of [
      "/",
      "/pricing",
      "/features",
      "/features/job-management",
      "/blog/some-post",
      "/tools/vat-calculator",
      "/product/money",
      "/privacy",
      "/terms",
      "/reset-password",
      "/offline",
    ]) {
      expect(cspClassForPath(p), p).toBe("static");
    }
  });

  it("app, admin, portals, auth, token pages and UNKNOWN paths get the nonce policy", () => {
    for (const p of [
      "/dashboard",
      "/jobs/123",
      "/settings/billing",
      "/admin/organizations",
      "/customer-portal/tok/invoices",
      "/worker-portal/tok",
      "/q/tok",
      "/login",
      "/signup",
      "/developers",
      "/toolbox", // prefix-collision guard: not "/tools"
      "/products", // not "/product"
      "/pricing-old", // not "/pricing"
      "/totally-unknown",
    ]) {
      expect(cspClassForPath(p), p).toBe("nonce");
    }
  });

  it("every static prefix is a real top-level marketing route (no stale entries)", () => {
    const ROOT = resolve(__dirname, "../..");
    const routeFile: Record<string, string> = {
      "/blog": "app/(marketing)/blog/page.tsx",
      "/compare": "app/(marketing)/compare/page.tsx",
      "/construction-software": "app/(marketing)/construction-software/page.tsx",
      "/features": "app/(marketing)/features/page.tsx",
      "/industries": "app/(marketing)/industries/page.tsx",
      "/product": "app/(site)/product/page.tsx",
      "/pricing": "app/(site)/pricing/page.tsx",
      "/tools": "app/(marketing)/tools/page.tsx",
      "/privacy": "app/privacy/page.tsx",
      "/terms": "app/terms/page.tsx",
      "/reset-password": "app/(auth)/reset-password/page.tsx",
      "/offline": "app/offline/page.tsx",
    };
    expect([...STATIC_POLICY_PREFIXES].sort()).toEqual(Object.keys(routeFile).sort());
    for (const [prefix, file] of Object.entries(routeFile)) {
      expect(() => readFileSync(resolve(ROOT, file)), prefix).not.toThrow();
    }
  });
});

describe("CSP class boundary (static document → nonce route forces a full load)", () => {
  const base = { method: "GET", nextActionHeader: null };
  it("a soft navigation from a marketing page into the app crosses the boundary", () => {
    expect(isCspClassBoundaryCrossing({ ...base, pathname: "/login", nextUrlHeader: "/" })).toBe(true);
    expect(isCspClassBoundaryCrossing({ ...base, pathname: "/dashboard", nextUrlHeader: "/pricing" })).toBe(true);
  });
  it("same-class navigations, nonce→static, documents (no Next-Url) and actions do not", () => {
    expect(isCspClassBoundaryCrossing({ ...base, pathname: "/features", nextUrlHeader: "/" })).toBe(false);
    expect(isCspClassBoundaryCrossing({ ...base, pathname: "/jobs", nextUrlHeader: "/dashboard" })).toBe(false);
    expect(isCspClassBoundaryCrossing({ ...base, pathname: "/pricing", nextUrlHeader: "/dashboard" })).toBe(false);
    // A document request never carries Next-Url → never intercepted.
    expect(isCspClassBoundaryCrossing({ ...base, pathname: "/login", nextUrlHeader: "" })).toBe(false);
    expect(isCspClassBoundaryCrossing({ ...base, pathname: "/login", nextUrlHeader: null })).toBe(false);
    expect(
      isCspClassBoundaryCrossing({ ...base, nextActionHeader: "abc", pathname: "/login", nextUrlHeader: "/" }),
    ).toBe(false);
    expect(
      isCspClassBoundaryCrossing({ ...base, method: "POST", pathname: "/login", nextUrlHeader: "/" }),
    ).toBe(false);
  });
});

describe("middleware wiring (source pins)", () => {
  const ROOT = resolve(__dirname, "../..");
  const mw = readFileSync(resolve(ROOT, "middleware.ts"), "utf8");
  it("forwards the nonce policy on the REQUEST (Next reads it there) and stamps the response", () => {
    expect(mw).toContain("generateNonce()");
    expect(mw).toContain("[NONCE_HEADER]: csp.nonce");
    expect(mw).toMatch(/\[csp\.headerName\.toLowerCase\(\)\]: csp\.value/);
    expect(mw).toMatch(/applyCsp\(await updateSession\(request, requestId, forward\), csp\)/);
  });
  it("keeps the report sink out of the auth middleware (a 307 would drop reports)", () => {
    expect(mw).toContain("api/csp-report|");
  });
});
