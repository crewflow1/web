import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Active-org scoping — the SITE-COMPLIANCE domain (inductions, visitor log,
 * muster + its exports).
 *
 * THE INVARIANT: RLS's `current_org_ids()` / `is_org_member()` admit EVERY org
 * the viewer belongs to, never just the ACTIVE org. So a read or write with no
 * org predicate lets a dual-org member working in company A see or mutate
 * company B's inductions/visitors, or export B's muster. Every read carries
 * `.eq("org_id", …)`, every by-id write is org-pinned + count-gated, and the
 * PDF/CSV routes re-read the site through the pinned loadSiteForOrg.
 *
 * Pinned on SOURCE (the documented convention of sites-active-org-scoping.test.ts)
 * because these are Server Actions / RSC / route handlers coupled to
 * createClient + requireOrgContext + cookies, which the repo has no mock harness
 * for. The RUNTIME proof against a real dual-org user lives in
 * __tests__/integration/rls/site-compliance-isolation.test.ts.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

function fn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("site-compliance reads — every query carries the org predicate", () => {
  const SRC = src("app/(app)/site-compliance/_data.ts");

  it("listInductionsForSite pins org AND site", () => {
    const F = fn(SRC, "listInductionsForSite");
    expect(F).toMatch(/\.eq\("org_id", orgId\)/);
    expect(F).toMatch(/\.eq\("site_id", siteId\)/);
    // Paged via fetchAllRows with a unique id tiebreak (F-1).
    expect(F).toMatch(/fetchAllRows/);
    expect(F).toMatch(/\.order\("id", \{ ascending: true \}\)/);
  });

  it("listVisitorsForSite pins org AND site and pages", () => {
    const F = fn(SRC, "listVisitorsForSite");
    expect(F).toMatch(/\.eq\("org_id", orgId\)/);
    expect(F).toMatch(/\.eq\("site_id", siteId\)/);
    expect(F).toMatch(/fetchAllRows/);
  });

  it("listOpenTimeEntries pins the org (presence read never blends tenants)", () => {
    const F = fn(SRC, "listOpenTimeEntries");
    expect(F).toMatch(/\.eq\("org_id", orgId\)/);
    expect(F).toMatch(/\.is\("ended_at", null\)/);
  });

  it("loadComplianceCounts pins both count reads to the org", () => {
    const F = fn(SRC, "loadComplianceCounts");
    expect(F.match(/\.eq\("org_id", orgId\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("reads are LOUD — a rejected query throws rather than showing empty", () => {
    expect(SRC).toMatch(/throw readFailure\(/);
  });
});

describe("site-compliance writes — every mutation is org-scoped", () => {
  const ACTIONS = src("app/(app)/site-compliance/actions.ts");

  it("recordInduction derives the site through the ACTIVE-org loadSiteForOrg and stamps org_id from ctx", () => {
    const F = fn(ACTIONS, "recordInduction");
    expect(F).toMatch(/loadSiteForOrg[\s\S]*?ctx\.org\.id/);
    expect(F).toMatch(/org_id: ctx\.org\.id/);
    // The site name is only knowable if the site is in the active org, so a
    // missing/foreign site is a hard stop before any insert.
    expect(F).toMatch(/if \(!site\)/);
  });

  it("signInVisitor confirms the site is in the active org and stamps org_id from ctx", () => {
    const F = fn(ACTIONS, "signInVisitor");
    expect(F).toMatch(/loadSiteForOrg[\s\S]*?ctx\.org\.id/);
    expect(F).toMatch(/org_id: ctx\.org\.id/);
    expect(F).toMatch(/if \(!site\)/);
  });

  it("signOutVisitor scopes the UPDATE by org_id and is count-gated", () => {
    const F = fn(ACTIONS, "signOutVisitor");
    expect(F).toMatch(/\.eq\("id", visitorId\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/if \(!count\)/);
    // Idempotent: only an on-site visitor can be signed out.
    expect(F).toMatch(/\.is\("signed_out_at", null\)/);
  });
});

describe("muster export routes — pinned to the active org", () => {
  for (const p of [
    "app/api/site-compliance/[siteId]/muster/pdf/route.ts",
    "app/api/site-compliance/[siteId]/muster/csv/route.ts",
  ]) {
    it(`${p} re-reads the site through loadSiteForOrg(ctx.org.id) and 404s a foreign/missing site`, () => {
      const S = src(p);
      expect(S).toMatch(/loadSiteForOrg[\s\S]*?ctx\.org\.id/);
      expect(S).toMatch(/if \(!site\)[\s\S]*?404/);
      // Node runtime (react-pdf / streaming) + no-store.
      expect(S).toMatch(/runtime = "nodejs"/);
    });
  }
});
