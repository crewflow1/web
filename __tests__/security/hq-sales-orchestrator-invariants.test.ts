import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ Sales-Orchestrator AI — trust-boundary invariants (hermetic source scan).
 *
 * Pins:
 *   1. The page AND the aggregator gate on requireHqPage — HQ-only, never
 *      tenant auth. A non-allowlisted caller must 404 before seeing any figure.
 *   2. The orchestrator-narrative path is DARK: the service constructs NO model
 *      SDK, reads NO vendor credential, and imports no @/lib/ai/* module, so the
 *      dark path cannot spend money. It also adds NO governor registry key (an
 *      unwired permission is drift the governance-closure ratchet rejects).
 *   3. The pure layer is clock- and Supabase-free (takes an injected `now`).
 *   4. Registered in the HQ nav.
 *   5. NO TENANT BLEND (#456): the aggregator reads only CrewFlow's OWN HQ-global
 *      sales tables (hq_sales_companies, hq_ai_tasks, hq_sales_timeline_events),
 *      never a tenant-scoped product table, and selects only lean columns
 *      (status + timestamps, event_type/direction) — no company/contact PII.
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

const PAGE = read("app/admin/sales-orchestrator-ai/page.tsx");
const SERVICE = read("server/services/hq-sales-orchestrator.ts");
const PURE = read("lib/hq/sales-orchestrator.ts");
const LAYOUT = read("app/admin/layout.tsx");

const SERVICE_CODE = codeOf(SERVICE);
const PURE_CODE = codeOf(PURE);
const PAGE_CODE = codeOf(PAGE);

describe("Sales-Orchestrator AI — super-admin gated (HQ-only)", () => {
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

describe("Sales-Orchestrator AI — the narrative is dark, constructs no model SDK", () => {
  it("the narrative loader returns null (dark stub)", () => {
    expect(SERVICE).toMatch(/loadSalesOrchestratorNarrative/);
    expect(SERVICE).toMatch(/return\s+null\s*;/);
  });

  it("the service imports no AI/governor/model module and constructs no SDK", () => {
    expect(SERVICE_CODE).not.toMatch(/@anthropic-ai\/sdk|from\s*"openai"|new\s+Anthropic\(|new\s+OpenAI\(/);
    expect(SERVICE_CODE).not.toMatch(/from\s*"@\/lib\/ai\//);
  });
});

describe("Sales-Orchestrator AI — no tenant blend, HQ-global sales sources only", () => {
  it("the aggregator reads CrewFlow's own HQ-global sales tables", () => {
    expect(SERVICE_CODE).toMatch(/\.from\(\s*["']hq_sales_companies["']/);
    expect(SERVICE_CODE).toMatch(/\.from\(\s*["']hq_ai_tasks["']/);
    expect(SERVICE_CODE).toMatch(/\.from\(\s*["']hq_sales_timeline_events["']/);
  });

  it("no tenant-scoped product table is read on this HQ surface (#456 leak class)", () => {
    for (const table of ["leads", "jobs", "quotes", "invoices", "customers", "tickets", "organizations"]) {
      expect(SERVICE_CODE, `must not read tenant table ${table}`).not.toMatch(
        new RegExp(`\\.from\\(\\s*["']${table}["']`),
      );
    }
    expect(SERVICE_CODE).not.toMatch(/from\s*"@\/lib\/leads\//);
  });

  it("the pipeline read selects only lean columns (no company/contact PII)", () => {
    const selectMatch = SERVICE_CODE.match(/\.select\(\s*["']([^"']*)["']/);
    expect(selectMatch).not.toBeNull();
    const cols = selectMatch![1];
    expect(cols).toContain("status");
    expect(cols).toContain("created_at");
    expect(cols).not.toMatch(/\bname\b|\bemail\b|\bphone\b|\bnotes\b|\bsummary\b/);
  });
});

describe("Sales-Orchestrator AI — contributes NOTHING to the governance-closure ratchet", () => {
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

describe("Sales-Orchestrator AI — the pure layer is clock- and Supabase-free", () => {
  it("takes an injected `now` and never touches Date.now or the DB", () => {
    expect(PURE).toMatch(/computeSalesOrchestratorBoard\([^)]*now:\s*Date/);
    expect(PURE_CODE).not.toMatch(/Date\.now\(/);
    expect(PURE_CODE).not.toMatch(/from\s*"@\/lib\/supabase|createAdminClient/);
  });
});

describe("Sales-Orchestrator AI — wired into the HQ nav", () => {
  it("the admin nav links to /admin/sales-orchestrator-ai", () => {
    expect(LAYOUT).toMatch(/href:\s*"\/admin\/sales-orchestrator-ai"/);
  });
});
