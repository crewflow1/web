import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ Customer-Success AI — trust-boundary invariants (hermetic source scan).
 *
 * Pins:
 *   1. The page AND the aggregator gate on requireHqPage — HQ-only, never
 *      tenant auth. A non-allowlisted caller must 404 before seeing any figure.
 *   2. The customer-success-narrative path is DARK: the service constructs NO
 *      model SDK, reads NO vendor credential, and imports no @/lib/ai/* module,
 *      so the dark path cannot spend money. It also adds NO governor registry key
 *      (an unwired permission is drift the governance-closure ratchet rejects).
 *   3. The pure layer is clock- and Supabase-free (takes an injected `now`).
 *   4. Registered in the HQ nav.
 *   5. NO TENANT BLEND: the aggregator reads CrewFlow's OWN demo_requests capture
 *      and the global analytics snapshot, never the tenant-scoped `leads` product
 *      table (summing that cross-tenant on an HQ surface is the #456 leak class),
 *      and selects only lean columns (status/created_at) — no lead PII.
 *   6. THE GOVERNANCE-CLOSURE RATCHET STAYS GREEN: none of the three new files
 *      introduces an ungoverned inference entry point — no SDK construction, no
 *      bare-credential gate, no `isAiConfigured()`, no door opener
 *      (getTextProvider / getVisionProvider).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip comments so prose documenting a removal can't satisfy or trip a pin. */
function codeOf(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const PAGE = read("app/admin/customer-success-ai/page.tsx");
const SERVICE = read("server/services/hq-customer-success.ts");
const PURE = read("lib/hq/customer-success.ts");
const LAYOUT = read("app/admin/layout.tsx");

const SERVICE_CODE = codeOf(SERVICE);
const PURE_CODE = codeOf(PURE);
const PAGE_CODE = codeOf(PAGE);

describe("Customer-Success AI — super-admin gated (HQ-only)", () => {
  it("the page imports and awaits requireHqPage", () => {
    expect(PAGE).toMatch(/import\s*\{[^}]*requireHqPage[^}]*\}\s*from\s*"@\/server\/auth\/hq"/);
    expect(PAGE).toMatch(/await\s+requireHqPage\(\)/);
  });

  it("the aggregator re-gates on requireHqPage before reading any source", () => {
    expect(SERVICE).toMatch(/import\s*\{[^}]*requireHqPage[^}]*\}\s*from\s*"@\/server\/auth\/hq"/);
    expect(SERVICE).toMatch(/await\s+requireHqPage\(\)/);
    // The gate precedes the first data read (Promise.all fan-out).
    const idxGate = SERVICE_CODE.indexOf("await requireHqPage()");
    const idxRead = SERVICE_CODE.indexOf("Promise.all");
    expect(idxGate).toBeGreaterThan(-1);
    expect(idxRead).toBeGreaterThan(idxGate);
  });

  it("the parent /admin layout also gates on requireHqPage (defence in depth)", () => {
    expect(LAYOUT).toMatch(/await\s+requireHqPage\(\)/);
  });
});

describe("Customer-Success AI — the narrative is dark, constructs no model SDK", () => {
  it("the narrative loader returns null (dark stub)", () => {
    expect(SERVICE).toMatch(/loadCustomerSuccessNarrative/);
    expect(SERVICE).toMatch(/return\s+null\s*;/);
  });

  it("the service imports no AI/governor/model module and constructs no SDK", () => {
    expect(SERVICE_CODE).not.toMatch(/@anthropic-ai\/sdk|from\s*"openai"|new\s+Anthropic\(|new\s+OpenAI\(/);
    expect(SERVICE_CODE).not.toMatch(/from\s*"@\/lib\/ai\//);
  });
});

describe("Customer-Success AI — no tenant blend, no lead PII", () => {
  it("the aggregator reads CrewFlow's own demo_requests, not the tenant leads table", () => {
    expect(SERVICE_CODE).toMatch(/\.from\(\s*["']demo_requests["']/);
    // The tenant-scoped product `leads` table must never be read on this HQ
    // surface (cross-tenant blend = the #456 leak class).
    expect(SERVICE_CODE).not.toMatch(/\.from\(\s*["']leads["']/);
    expect(SERVICE_CODE).not.toMatch(/from\s*"@\/lib\/leads\//);
  });

  it("the demo-request read selects only lean columns (no name/email/phone PII)", () => {
    const selectMatch = SERVICE_CODE.match(/\.select\(\s*["']([^"']*)["']/);
    expect(selectMatch).not.toBeNull();
    const cols = selectMatch![1];
    expect(cols).toContain("status");
    expect(cols).toContain("created_at");
    expect(cols).not.toMatch(/\bname\b|\bemail\b|\bphone\b|\bcompany\b|\bnotes\b/);
  });

  it("the org posture comes from the shared analytics snapshot, not a direct tenant read", () => {
    // The health/adoption posture reuses buildAnalyticsSnapshot — the same
    // global HQ read the Marketing and Product boards use — rather than querying
    // any tenant-scoped product table directly.
    expect(SERVICE_CODE).toMatch(/buildAnalyticsSnapshot/);
    // No direct tenant product tables on this HQ surface.
    for (const table of ["jobs", "quotes", "invoices", "customers", "tickets"]) {
      expect(SERVICE_CODE, `must not read tenant table ${table}`).not.toMatch(
        new RegExp(`\\.from\\(\\s*["']${table}["']`),
      );
    }
  });
});

describe("Customer-Success AI — contributes NOTHING to the governance-closure ratchet", () => {
  const CODES: ReadonlyArray<[string, string]> = [
    ["page", PAGE_CODE],
    ["service", SERVICE_CODE],
    ["pure", PURE_CODE],
  ];

  it("no file constructs a vendor SDK or reads a vendor credential", () => {
    for (const [name, code] of CODES) {
      expect(code, `${name} must not construct a vendor SDK`).not.toMatch(
        /@anthropic-ai\/sdk|\bnew\s+Anthropic\b|\bnew\s+OpenAI\b|import\(\s*["']openai["']\s*\)|from\s+["']openai["']/,
      );
      expect(code, `${name} must not read a vendor credential`).not.toMatch(
        /process\.env\.(?:ANTHROPIC_API_KEY|OPENAI_API_KEY)\b/,
      );
    }
  });

  it("no file gates on a bare credential or opens a model door", () => {
    for (const [name, code] of CODES) {
      expect(code, `${name} must not call isAiConfigured()`).not.toMatch(/\bisAiConfigured\s*\(/);
      expect(code, `${name} must not open a model door`).not.toMatch(
        /\bgetTextProvider\s*\(|\bgetVisionProvider\s*\(/,
      );
    }
  });

  it("no file registers a governor feature key (unwired permission = drift)", () => {
    for (const [name, code] of CODES) {
      expect(code, `${name} must not touch the governor registry`).not.toMatch(
        /invokeWithGovernor|featureDefinition|AI_FEATURES/,
      );
    }
  });
});

describe("Customer-Success AI — the pure layer is clock- and Supabase-free", () => {
  it("takes an injected `now` and never touches Date.now or the DB", () => {
    expect(PURE).toMatch(/computeCustomerSuccessBoard\([^)]*now:\s*Date/);
    expect(PURE_CODE).not.toMatch(/Date\.now\(/);
    expect(PURE_CODE).not.toMatch(/from\s*"@\/lib\/supabase|createAdminClient/);
  });
});

describe("Customer-Success AI — wired into the HQ nav", () => {
  it("the admin nav links to /admin/customer-success-ai", () => {
    expect(LAYOUT).toMatch(/href:\s*"\/admin\/customer-success-ai"/);
  });
});
