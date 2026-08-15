import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Public API v1 jobs read (Train K / Mission 9) — trust-boundary pins.
 *
 * A public, key-authenticated data plane. These source-assertions freeze the
 * properties that keep it safe: dark-by-flag (404 when off, not 401/403), the
 * read:jobs scope gate, org-pinning to the KEY'S org (never client input), the
 * explicit DTO allowlist with no cost/PII/internal fields, the no-cross-org
 * oracle by-id read, and the shared api_v1 rate limit. If any of these erode,
 * a test here goes red rather than the leak shipping silently.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const FLAG = codeOf(read("lib/public-api/flag.ts"));
const GUARD = codeOf(read("lib/public-api/guard.ts"));
const DTO = codeOf(read("lib/public-api/jobs.ts"));
const LIST = codeOf(read("app/api/v1/jobs/route.ts"));
const BYID = codeOf(read("app/api/v1/jobs/[id]/route.ts"));

// ---------------------------------------------------------------------------
// 1. Dark by default — the flag, and 404 (not 401/403) when off
// ---------------------------------------------------------------------------

describe("feature flag — server-only, default OFF, gates the surface", () => {
  it("is a SERVER-ONLY flag (never a NEXT_PUBLIC_* one that would ship to the client)", () => {
    const env = read("lib/env.ts");
    expect(env).toMatch(/FEATURE_PUBLIC_API_JOBS: z\.enum\(\["true", "false"\]\)\.default\("false"\)/);
    expect(env).not.toMatch(/NEXT_PUBLIC_FEATURE_PUBLIC_API_JOBS/);
    // flag helper imports server-only and reads the server flag.
    expect(FLAG).toMatch(/server-only/);
    expect(FLAG).toMatch(/env\.FEATURE_PUBLIC_API_JOBS === "true"/);
  });

  it("the guard checks the flag FIRST and returns 404 (dark), not a 401/403 that would out the endpoint", () => {
    const flagIdx = GUARD.indexOf("isPublicApiJobsEnabled()");
    const authIdx = GUARD.indexOf("resolveApiKey(");
    expect(flagIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(flagIdx); // flag gate precedes auth
    expect(GUARD).toMatch(/if \(!isPublicApiJobsEnabled\(\)\) return \{ ok: false, response: notFound\(\) \}/);
    expect(GUARD).toMatch(/status: 404/);
  });
});

// ---------------------------------------------------------------------------
// 2. Auth + scope + rate limit — the ordered gate
// ---------------------------------------------------------------------------

describe("guard — resolve → scope → rate limit, in order", () => {
  it("resolves via the single authority and 401s on null", () => {
    expect(GUARD).toMatch(/resolveApiKey\(request\.headers\.get\("authorization"\)\)/);
    expect(GUARD).toMatch(/if \(!key\) return \{ ok: false, response: unauthorized\(\) \}/);
    expect(GUARD).toMatch(/status: 401/);
  });

  it("requires the read:jobs scope and 403s without it", () => {
    expect(GUARD).toMatch(/hasScope\(key\.scopes, "read:jobs"\)/);
    expect(GUARD).toMatch(/status: 403/);
  });

  it("rate-limits with DEFAULT_LIMITS.api_v1 keyed by the KEY ID (shared budget with /me)", () => {
    expect(GUARD).toMatch(
      /enforceIdentified\(\s*"api_v1",\s*key\.keyId,\s*DEFAULT_LIMITS\.api_v1,?\s*\)/,
    );
  });

  it("scope is checked AFTER auth and BEFORE the rate-limit spend", () => {
    const auth = GUARD.indexOf("resolveApiKey(");
    const scope = GUARD.indexOf("hasScope(");
    const limit = GUARD.indexOf("enforceIdentified(");
    expect(auth).toBeLessThan(scope);
    expect(scope).toBeLessThan(limit);
  });
});

// ---------------------------------------------------------------------------
// 3. The DTO — explicit allowlist, no leakage, no raw spread
// ---------------------------------------------------------------------------

describe("public DTO — explicit projection, no internal/PII/cost fields", () => {
  it("pins the exact allowlisted column set", () => {
    const arr = /JOB_DTO_COLUMNS = \[([\s\S]*?)\] as const/.exec(DTO);
    expect(arr, "JOB_DTO_COLUMNS not found").not.toBeNull();
    const cols = [...arr![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(cols).toEqual([
      "id",
      "status",
      "scheduled_date",
      "site_postcode",
      "created_at",
      "updated_at",
    ]);
  });

  it("the projection is field-by-field — no spread of a raw row", () => {
    expect(DTO).toMatch(/function toPublicJobDto/);
    expect(DTO).not.toMatch(/\.\.\.row/);
    expect(DTO).not.toMatch(/\.\.\.data/);
  });

  it("no forbidden field name appears anywhere in the DTO's projected shape", () => {
    // These must never be part of the allowlist or the mapping's output keys.
    const projection =
      /function toPublicJobDto[\s\S]*?\n\}/.exec(DTO)?.[0] ?? DTO;
    for (const forbidden of [
      "ai_summary",
      "notes",
      "assigned_to",
      "customer_id",
      "org_id",
      "photos",
      "recurring",
      "site_address_line1",
      "site_city",
      "cost",
      "margin",
      "price",
      "portal_token",
    ]) {
      expect(projection, `projection emits ${forbidden}`).not.toMatch(
        new RegExp(`\\b${forbidden}\\b\\s*:`),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Org pinning — every read scoped to the KEY'S org, never client input
// ---------------------------------------------------------------------------

describe("org pinning — reads are bound to key.orgId, never a client-supplied org", () => {
  it("the list read pins .eq(\"org_id\", key.orgId) and never selects '*'", () => {
    expect(LIST).toMatch(/\.eq\("org_id", guard\.key\.orgId\)/);
    expect(LIST).toMatch(/\.select\(JOB_DTO_SELECT\)/);
    expect(LIST).not.toMatch(/select\(\s*["'`]\s*\*\s*["'`]\s*\)/);
    // the org id is NEVER read from the query string.
    expect(LIST).not.toMatch(/searchParams\.get\("org/);
  });

  it("the by-id read goes through loadJobForOrg with key.orgId (no ad-hoc query)", () => {
    expect(BYID).toMatch(/loadJobForOrg<JobRowForDto>\(\s*admin,\s*id,\s*guard\.key\.orgId,\s*JOB_DTO_SELECT,?\s*\)/);
    expect(BYID).not.toMatch(/select\(\s*["'`]\s*\*\s*["'`]\s*\)/);
  });

  it("uses a stable, deterministic order (created_at then id) so pages cannot overlap/skip", () => {
    expect(LIST).toMatch(/\.order\("created_at", \{ ascending: false \}\)/);
    expect(LIST).toMatch(/\.order\("id", \{ ascending: false \}\)/);
  });

  it("reads are LOUD — a failed query throws readFailure, never an empty page", () => {
    expect(LIST).toMatch(/if \(error\) throw readFailure\(/);
  });
});

// ---------------------------------------------------------------------------
// 5. No cross-org oracle — a guessed other-org id is 404, never 403-with-info
// ---------------------------------------------------------------------------

describe("no cross-org oracle on the by-id read", () => {
  it("returns 404 on a null load (other-org and missing are indistinguishable)", () => {
    expect(BYID).toMatch(/if \(!row\) return notFound\(\)/);
    expect(BYID).toMatch(/status: 404/);
  });

  it("relies on loadJobForOrg, which pins BOTH id and org_id (the two-eq no-oracle shape)", () => {
    const loader = read("lib/jobs/load.ts");
    expect(loader).toMatch(/\.eq\("id", jobId\)\s*\.eq\("org_id", orgId\)/);
  });
});

// ---------------------------------------------------------------------------
// 6. Envelope shape — data + pagination meta, dark surface count preserved
// ---------------------------------------------------------------------------

describe("response envelope + surface accounting", () => {
  it("returns { data, pagination:{page,per_page,has_more} }", () => {
    expect(LIST).toMatch(/data: page/);
    expect(LIST).toMatch(/pagination: \{[\s\S]*?page:[\s\S]*?per_page:[\s\S]*?has_more[\s\S]*?\}/);
    expect(BYID).toMatch(/data: toPublicJobDto\(row\)/);
  });

  it("readiness endpoint count matches the real /api/v1 route file count (9 — probe + jobs pair + customers pair + invoices/quotes + leads + openapi)", async () => {
    const { getApiKeysReadiness } = await import("@/lib/integrations/readiness");
    expect(getApiKeysReadiness().endpoints).toBe(9);
  });
});
