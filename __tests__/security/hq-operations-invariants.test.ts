import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ Operations AI — trust-boundary invariants (hermetic source scan).
 *
 * Pins:
 *   1. The page AND the aggregator gate on requireHqPage — HQ-only, never
 *      tenant auth. A non-allowlisted caller must 404 before seeing any figure.
 *   2. The operations-narrative path is GOVERNED but DARK BY DEFAULT: the
 *      aggregator delegates to the shared HQ narrative helper
 *      (server/services/hq-narrative.ts) under the registered
 *      `hq.operations_narrative` key. The aggregator itself constructs NO model
 *      SDK, reads NO vendor credential, and opens no model door — the door +
 *      governor live in the helper — so with no tier bound it returns null and
 *      cannot spend money.
 *   3. The pure layer is clock- and Supabase-free (takes an injected `now`).
 *   4. Registered in the HQ nav.
 *   5. THE GOVERNANCE-CLOSURE RATCHET STAYS GREEN: none of the three new
 *      Operations files introduces an ungoverned inference entry point — no SDK
 *      construction, no bare-credential gate, no `isAiConfigured()`, no door
 *      opener (getTextProvider / getVisionProvider). The estate-wide ratchet in
 *      ai-governance-closure.test.ts derives its zero from source; these pins
 *      prove the Operations surface contributes nothing to that count.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip comments so prose documenting a removal can't satisfy or trip a pin. */
function codeOf(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const PAGE = read("app/admin/operations-ai/page.tsx");
const SERVICE = read("server/services/hq-operations.ts");
const PURE = read("lib/hq/operations.ts");
const LAYOUT = read("app/admin/layout.tsx");

const SERVICE_CODE = codeOf(SERVICE);
const PURE_CODE = codeOf(PURE);
const PAGE_CODE = codeOf(PAGE);

describe("Operations AI — super-admin gated (HQ-only)", () => {
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

describe("Operations AI — the narrative is GOVERNED (fail-closed), constructs no raw SDK", () => {
  it("the narrative loader delegates to the shared governed helper", () => {
    expect(SERVICE).toMatch(/loadOperationsNarrative/);
    // Wired through the shared HQ narrative helper under its registered key —
    // the service never reaches a model itself. Dark until a tier is bound.
    expect(SERVICE).toMatch(/generateHqBoardNarrative\(\s*"hq\.operations_narrative"/);
    expect(SERVICE).toMatch(/@\/server\/services\/hq-narrative/);
  });

  it("the service constructs no raw model SDK and opens no model door directly", () => {
    expect(SERVICE_CODE).not.toMatch(/@anthropic-ai\/sdk|from\s*"openai"|new\s+Anthropic\(|new\s+OpenAI\(/);
    // The provider door + governor live in the shared helper, not on this surface.
    expect(SERVICE_CODE).not.toMatch(/from\s*"@\/lib\/ai\//);
    expect(SERVICE_CODE).not.toMatch(/\bgetTextProvider\s*\(|\bgetVisionProvider\s*\(/);
  });
});

describe("Operations AI — contributes NOTHING to the governance-closure ratchet", () => {
  const CODES: ReadonlyArray<[string, string]> = [
    ["page", PAGE_CODE],
    ["service", SERVICE_CODE],
    ["pure", PURE_CODE],
  ];

  it("no Operations file constructs a vendor SDK or reads a vendor credential", () => {
    for (const [name, code] of CODES) {
      expect(code, `${name} must not construct a vendor SDK`).not.toMatch(
        /@anthropic-ai\/sdk|\bnew\s+Anthropic\b|\bnew\s+OpenAI\b|import\(\s*["']openai["']\s*\)|from\s+["']openai["']/,
      );
      expect(code, `${name} must not read a vendor credential`).not.toMatch(
        /process\.env\.(?:ANTHROPIC_API_KEY|OPENAI_API_KEY)\b/,
      );
    }
  });

  it("no Operations file gates on a bare credential or opens a model door", () => {
    for (const [name, code] of CODES) {
      expect(code, `${name} must not call isAiConfigured()`).not.toMatch(/\bisAiConfigured\s*\(/);
      expect(code, `${name} must not open a model door`).not.toMatch(
        /\bgetTextProvider\s*\(|\bgetVisionProvider\s*\(/,
      );
    }
  });

  it("no Operations file registers a governor feature key (unwired permission = drift)", () => {
    for (const [name, code] of CODES) {
      expect(code, `${name} must not touch the governor registry`).not.toMatch(
        /invokeWithGovernor|featureDefinition|AI_FEATURES/,
      );
    }
  });
});

describe("Operations AI — the pure layer is clock- and Supabase-free", () => {
  it("takes an injected `now` and never touches Date.now or the DB", () => {
    expect(PURE).toMatch(/computeOperationsBoard\([^)]*now:\s*Date/);
    expect(PURE_CODE).not.toMatch(/Date\.now\(/);
    expect(PURE_CODE).not.toMatch(/from\s*"@\/lib\/supabase|createAdminClient/);
  });
});

describe("Operations AI — wired into the HQ nav", () => {
  it("the admin nav links to /admin/operations-ai", () => {
    expect(LAYOUT).toMatch(/href:\s*"\/admin\/operations-ai"/);
  });
});
