import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P2 audit H-1 — lead-summary org-scope SOURCE CONTRACT.
 *
 * The behavioural test (lead-summary-org-scope.test.ts) proves the runtime
 * blocks cross-tenant reads. This file is the static tripwire: it pins the
 * security-critical *shape* of the source so a future refactor can't silently
 * drop the org filter and reopen the IDOR.
 *
 * Why a source-contract test: summariseLead reads via the service-role admin
 * client (RLS bypassed). The ONLY thing standing between a caller and another
 * tenant's PII is the explicit `org_id` filter on every query here. If someone
 * adds a third `.from(...)` read without scoping it, this test must go red.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const svc = read("server/services/lead-summary.ts");
const actionSrc = read("app/(app)/leads/actions.ts");

// The single runtime caller. Slice just this function so index-ordering
// assertions below aren't confused by .update()/requireOrgContext() calls in
// the other actions (createLead, updateLead, acknowledgeLead, ...).
const fnStart = actionSrc.indexOf(
  "export async function regenerateLeadSummary",
);
const fnEnd = actionSrc.indexOf("export async function deleteLead", fnStart);
const regenerateFn = actionSrc.slice(
  fnStart,
  fnEnd === -1 ? undefined : fnEnd,
);

describe("H-1 contract — summariseLead signature requires an org id", () => {
  it("declares both leadId and orgId as required string params", () => {
    const sig = svc.match(/export async function summariseLead\(([\s\S]*?)\)/);
    expect(sig).not.toBeNull();
    const params = sig?.[1] ?? "";
    expect(params).toMatch(/leadId:\s*string/);
    expect(params).toMatch(/orgId:\s*string/);
  });

  it("orgId is NOT optional (cannot be omitted by the caller)", () => {
    // An `orgId?: string` would let a caller skip scoping entirely.
    expect(svc).not.toMatch(/orgId\?\s*:/);
  });
});

describe("H-1 contract — every service-role read is org-scoped", () => {
  it("the leads read filters by id AND org_id", () => {
    expect(svc).toMatch(
      /\.eq\(\s*["']id["']\s*,\s*leadId\s*\)\s*\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/,
    );
  });

  it("the tenant_attachments photo-count filters by target_id AND org_id", () => {
    expect(svc).toMatch(
      /\.eq\(\s*["']target_id["']\s*,\s*leadId\s*\)\s*\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/,
    );
  });

  it("has exactly two .from() reads and at least one org_id filter for each", () => {
    // If a future read is added, fromCount climbs but orgFilters won't unless
    // the author scopes it — this asserts the 1:1 invariant holds today and
    // forces the conversation if a new unscoped query appears.
    const fromCount = (svc.match(/\.from\(/g) ?? []).length;
    const orgFilters = (svc.match(/\.eq\(\s*["']org_id["']/g) ?? []).length;
    expect(fromCount).toBe(2);
    expect(orgFilters).toBeGreaterThanOrEqual(2);
    expect(orgFilters).toBeGreaterThanOrEqual(fromCount);
  });

  it("documents the H-1 rationale in source", () => {
    expect(svc).toMatch(/H-1/);
  });
});

describe("H-1 contract — regenerateLeadSummary threads the caller's org", () => {
  it("captures ctx from requireOrgContext()", () => {
    expect(regenerateFn).toMatch(
      /const\s*\{\s*ctx\s*\}\s*=\s*await\s+requireOrgContext\(\)/,
    );
  });

  it("passes ctx.org.id into summariseLead", () => {
    expect(regenerateFn).toMatch(
      /summariseLead\(\s*id\s*,\s*ctx\.org\.id\s*\)/,
    );
  });

  it("never calls summariseLead unscoped (single-arg)", () => {
    expect(regenerateFn).not.toMatch(/summariseLead\(\s*id\s*\)/);
  });

  it("bails on a null result BEFORE persisting (no write for a foreign lead)", () => {
    const guardIdx = regenerateFn.indexOf("!result");
    const updateIdx = regenerateFn.indexOf(".update(");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(updateIdx);
  });
});
