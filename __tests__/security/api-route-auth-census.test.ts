import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * API route authentication census (final launch audit, 2026-11-17).
 *
 * Every route handler under app/** (route.ts / route.tsx, inside or outside
 * app/api) must sit behind a recognised
 * authentication primitive — a user session, the cron bearer, a public-API key,
 * a provider signature, or a public-link token — OR be named in PUBLIC_BY_DESIGN
 * with the reason it is safe to call anonymously. A new route that has none of
 * these fails here, so an unauthenticated endpoint cannot ship by accident.
 *
 * This is a presence census, not a proof of correct authorisation: the dynamic
 * evidence (anonymous / wrong-role / cross-tenant calls against a production
 * build) lives in docs/security/FINAL-LAUNCH-AUDIT.md and scripts/security/.
 */

const ROOT = join(__dirname, "..", "..");
const APP = join(ROOT, "app");

const PRIMITIVES = {
  session: /\b(requireOrgContext|requireUser|requireCapability(?:Api)?|requireHq(?:Api|Page)?|requireSuperAdmin|isSuperAdmin|auth\.getUser)\s*\(/,
  cron: /\bisCronAuthorised\s*\(/,
  apiKey: /\b(guardPublic(?:Api|Jobs)Request|resolveApiKey)\s*\(/,
  signature: /\b(constructEvent(?:Async)?|verify[A-Za-z]*Signature|provider\.verify|timingSafeEqual)\s*\(/,
  token: /\b(loadCustomerByPortalToken|loadWorkerSession)\s*\(/,
  scim: /\bauthenticateScim\s*\(/,
} satisfies Record<string, RegExp>;

/** Auth enforced one call away, in a named service — each entry names it. */
const DELEGATED: Record<string, RegExp> = {
  // getBlueprintVersionUrl() → requireOrgContext() + active-org pin (server/services/blueprints.ts)
  "(app)/jobs/[id]/blueprints/f/[versionId]/route.ts": /\bgetBlueprintVersionUrl\s*\(/,
  // public quote PDF: the unguessable quote public_token IS the credential
  "q/[token]/pdf/route.ts": /\.eq\("public_token", token\)/,
};

/** Anonymous by design — each entry states why that is safe. */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  "api/health/route.ts": "liveness JSON: readiness booleans only, no tenant data, no secrets",
  "api/demo/route.ts": "marketing demo-request form; rate limited",
  "api/public/lead/route.ts": "per-company public enquiry form; org resolved server-side from slug, rate limited, held-org refusal",
  "api/v1/openapi.json/route.ts": "static OpenAPI document for the public API",
  "api/dev/test-login/route.ts": "allow-listed to preview/next-dev only; 404 in production and when VERCEL_ENV is unset",
  "api/integrations/calendar/[provider]/webhook/route.ts": "dark; per-channel secret verified constant-time in the calendar-pull service",
  "api/sso/oidc/[orgId]/start/route.ts": "dark (FEATURE_ENTERPRISE_SSO); starts an IdP redirect, grants nothing",
  "api/sso/oidc/[orgId]/callback/route.ts": "dark; id_token signature/claims validated before any session is minted",
  "api/sso/saml/[orgId]/acs/route.ts": "dark; SAML assertion signature + conditions validated before any session is minted",
  "api/sso/saml/[orgId]/metadata/route.ts": "dark; public SP metadata by protocol",
  "api/og/route.tsx": "Open Graph image renderer for marketing pages; text from query params only, no data access, no fetch",
  "auth/callback/route.ts": "Supabase auth code / OTP exchange; redirect target restricted to same-origin paths",
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : /^route\.tsx?$/.test(e) ? [p] : [];
  });
}

const routes = walk(APP).map((abs) => ({ rel: relative(APP, abs), src: readFileSync(abs, "utf8") }));

describe("route handler authentication census", () => {
  it("finds the route handlers (sanity)", () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it("every route handler uses an authentication primitive or is public by design", () => {
    const unguarded = routes
      .filter((r) => !PUBLIC_BY_DESIGN[r.rel])
      .filter((r) => !(DELEGATED[r.rel] && DELEGATED[r.rel]!.test(r.src)))
      .filter((r) => !Object.values(PRIMITIVES).some((re) => re.test(r.src)))
      .map((r) => r.rel);
    expect(unguarded, "add an auth primitive (or a reasoned PUBLIC_BY_DESIGN entry)").toEqual([]);
  });

  it("every cron route checks the cron bearer before doing work", () => {
    const crons = routes.filter((r) => r.rel.startsWith("api/cron/"));
    expect(crons.length).toBeGreaterThan(40);
    const missing = crons.filter((r) => !PRIMITIVES.cron.test(r.src)).map((r) => r.rel);
    expect(missing).toEqual([]);
  });

  it("every provider webhook verifies a signature", () => {
    const hooks = routes.filter((r) => r.rel.startsWith("api/webhooks/"));
    const missing = hooks.filter((r) => !PRIMITIVES.signature.test(r.src)).map((r) => r.rel);
    expect(missing).toEqual([]);
  });

  it("the public-by-design list has no stale entries", () => {
    const present = new Set(routes.map((r) => r.rel));
    expect([...Object.keys(PUBLIC_BY_DESIGN), ...Object.keys(DELEGATED)].filter((k) => !present.has(k))).toEqual([]);
  });
});
