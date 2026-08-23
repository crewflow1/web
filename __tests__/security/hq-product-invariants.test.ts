import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ Product AI — trust-boundary invariants (hermetic source scan).
 *
 * Pins:
 *   1. The page AND the aggregator gate on requireHqPage — HQ-only, never tenant
 *      auth. A non-allowlisted caller must 404 before seeing any figure.
 *   2. The product-narrative path is GOVERNED but DARK BY DEFAULT: the aggregator
 *      delegates to the shared HQ narrative helper
 *      (server/services/hq-narrative.ts) under the registered
 *      `hq.product_narrative` key. The aggregator itself constructs NO model SDK,
 *      reads NO vendor credential, and opens no model door — the door + governor
 *      live in the helper — so with no tier bound it returns null and cannot
 *      spend money.
 *   3. The pure layer is clock- and Supabase-free (takes an injected `now`).
 *   4. The lean product-signal reader exposes NO PII — id/category/status/
 *      created_at only, never subject/body/priority.
 *   5. Registered in the HQ nav.
 *   6. THE GOVERNANCE-CLOSURE RATCHET STAYS GREEN: none of the new Product files
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

const PAGE = read("app/admin/product-ai/page.tsx");
const SERVICE = read("server/services/hq-product.ts");
const PURE = read("lib/hq/product.ts");
const READER = read("server/services/hq-support-snapshot.ts");
const LAYOUT = read("app/admin/layout.tsx");

const SERVICE_CODE = codeOf(SERVICE);
const PURE_CODE = codeOf(PURE);
const PAGE_CODE = codeOf(PAGE);
const READER_CODE = codeOf(READER);

describe("Product AI — super-admin gated (HQ-only)", () => {
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

describe("Product AI — the narrative is GOVERNED (fail-closed), constructs no raw SDK", () => {
  it("the narrative loader delegates to the shared governed helper", () => {
    expect(SERVICE).toMatch(/loadProductNarrative/);
    // Wired through the shared HQ narrative helper under its registered key —
    // the service never reaches a model itself. Dark until a tier is bound.
    expect(SERVICE).toMatch(/generateHqBoardNarrative\(\s*"hq\.product_narrative"/);
    expect(SERVICE).toMatch(/@\/server\/services\/hq-narrative/);
  });

  it("the service constructs no raw model SDK and opens no model door directly", () => {
    expect(SERVICE_CODE).not.toMatch(/@anthropic-ai\/sdk|from\s*"openai"|new\s+Anthropic\(|new\s+OpenAI\(/);
    // The provider door + governor live in the shared helper, not on this surface.
    expect(SERVICE_CODE).not.toMatch(/from\s*"@\/lib\/ai\//);
    expect(SERVICE_CODE).not.toMatch(/\bgetTextProvider\s*\(|\bgetVisionProvider\s*\(/);
  });
});

describe("Product AI — contributes NOTHING to the governance-closure ratchet", () => {
  const CODES: ReadonlyArray<[string, string]> = [
    ["page", PAGE_CODE],
    ["service", SERVICE_CODE],
    ["pure", PURE_CODE],
  ];

  it("no Product file constructs a vendor SDK or reads a vendor credential", () => {
    for (const [name, code] of CODES) {
      expect(code, `${name} must not construct a vendor SDK`).not.toMatch(
        /@anthropic-ai\/sdk|\bnew\s+Anthropic\b|\bnew\s+OpenAI\b|import\(\s*["']openai["']\s*\)|from\s+["']openai["']/,
      );
      expect(code, `${name} must not read a vendor credential`).not.toMatch(
        /process\.env\.(?:ANTHROPIC_API_KEY|OPENAI_API_KEY)\b/,
      );
    }
  });

  it("no Product file gates on a bare credential or opens a model door", () => {
    for (const [name, code] of CODES) {
      expect(code, `${name} must not call isAiConfigured()`).not.toMatch(/\bisAiConfigured\s*\(/);
      expect(code, `${name} must not open a model door`).not.toMatch(
        /\bgetTextProvider\s*\(|\bgetVisionProvider\s*\(/,
      );
    }
  });

  it("no Product file registers a governor feature key (unwired permission = drift)", () => {
    for (const [name, code] of CODES) {
      expect(code, `${name} must not touch the governor registry`).not.toMatch(
        /invokeWithGovernor|featureDefinition|AI_FEATURES/,
      );
    }
  });
});

describe("Product AI — the pure layer is clock- and Supabase-free", () => {
  it("takes an injected `now` and never touches Date.now or the DB", () => {
    expect(PURE).toMatch(/computeProductBoard\([^)]*now:\s*Date/);
    expect(PURE_CODE).not.toMatch(/Date\.now\(/);
    expect(PURE_CODE).not.toMatch(/from\s*"@\/lib\/supabase|createAdminClient/);
  });
});

describe("Product AI — the lean signal reader exposes NO PII", () => {
  it("selects only id/category/status/created_at — never subject, body, or priority", () => {
    // The reader's select list is the id+category+status+created_at tuple.
    expect(READER).toMatch(/listFeatureSignalRowsForHq/);
    const idx = READER.indexOf("listFeatureSignalRowsForHq");
    // Look at the reader body (from its declaration to the end of file).
    const body = READER.slice(idx);
    const selectMatch = body.match(/\.select\(\s*\[([^\]]*)\]\.join/);
    expect(selectMatch, "reader must select an explicit column list").not.toBeNull();
    const cols = selectMatch![1];
    expect(cols).toMatch(/"id"/);
    expect(cols).toMatch(/"category"/);
    expect(cols).toMatch(/"status"/);
    expect(cols).toMatch(/"created_at"/);
    expect(cols).not.toMatch(/subject|body|message/i);
  });

  it("the pure ticket row type carries no free-text field", () => {
    // ProductTicketRow is category/status/created_at only.
    expect(PURE_CODE).not.toMatch(/subject\s*:/);
    expect(PURE_CODE).not.toMatch(/\bbody\s*:/);
  });
});

describe("Product AI — wired into the HQ nav", () => {
  it("the admin nav links to /admin/product-ai", () => {
    expect(read("app/admin/_nav/hq-nav-model.ts")).toMatch(/href:\s*"\/admin\/product-ai"/);
  });
});
