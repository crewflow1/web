import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ Finance AI — trust-boundary invariants (hermetic source scan).
 *
 * Pins:
 *   1. The page AND the aggregator gate on requireHqPage — HQ-only, never
 *      tenant auth. A non-allowlisted caller must 404 before seeing any figure.
 *   2. The board narrative is DARK: the service constructs NO model SDK and
 *      imports no AI/governor module, so the dark path cannot spend money. If a
 *      governed call is ever added it must go through invokeWithGovernor, not a
 *      raw SDK — this test fails loudly the moment a raw SDK is introduced.
 *   3. Registered in the HQ nav.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const PAGE = read("app/admin/finance/page.tsx");
const SERVICE = read("server/services/hq-finance.ts");
const LAYOUT = read("app/admin/layout.tsx");

describe("Finance AI — super-admin gated (HQ-only)", () => {
  it("the page imports and awaits requireHqPage", () => {
    expect(PAGE).toMatch(/import\s*\{[^}]*requireHqPage[^}]*\}\s*from\s*"@\/server\/auth\/hq"/);
    expect(PAGE).toMatch(/await\s+requireHqPage\(\)/);
  });

  it("the aggregator re-gates on requireHqPage before reading any figure", () => {
    expect(SERVICE).toMatch(/import\s*\{[^}]*requireHqPage[^}]*\}\s*from\s*"@\/server\/auth\/hq"/);
    expect(SERVICE).toMatch(/await\s+requireHqPage\(\)/);
  });

  it("the parent /admin layout also gates on requireHqPage (defence in depth)", () => {
    expect(LAYOUT).toMatch(/await\s+requireHqPage\(\)/);
  });
});

describe("Finance AI — narrative is dark, constructs no model SDK", () => {
  it("the narrative loader returns null (dark stub)", () => {
    expect(SERVICE).toMatch(/loadFinanceNarrative/);
    // The declared return path is null — no generated prose ships today.
    expect(SERVICE).toMatch(/return\s+null\s*;/);
  });

  it("the service imports no AI/governor/model module and constructs no SDK", () => {
    // No raw provider SDKs.
    expect(SERVICE).not.toMatch(/@anthropic-ai\/sdk|from\s*"openai"|new\s+Anthropic\(|new\s+OpenAI\(/);
    // No AI module imports at all on this dark surface — a governed call, when
    // it lands, must be added deliberately (and this pin updated to require
    // invokeWithGovernor rather than a raw client).
    expect(SERVICE).not.toMatch(/from\s*"@\/lib\/ai\//);
  });
});

describe("Finance AI — absent sources are honest literal nulls (no fabricated figures)", () => {
  // Strip block + line comments so prose that mentions a field name can neither
  // satisfy nor defeat the match — we assert on real code only.
  const CODE = SERVICE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  // The five "…Gbp" inputs the schema has nowhere to read today. Each MUST be
  // passed as a literal `null` so its metric returns `insufficient`. If someone
  // swaps a `null` for `0` or wires a wrong proxy (e.g. MRR-as-cash), a
  // fabricated figure would surface silently — these assertions fail instead.
  const ABSENT_SOURCE_FIELDS = [
    "costOfRevenueGbp",
    "cashCollectedGbp",
    "cashBalanceGbp",
    "monthlyBurnGbp",
    "acquisitionSpendGbp",
  ] as const;

  for (const field of ABSENT_SOURCE_FIELDS) {
    it(`passes ${field} as a literal null, never 0 or a proxy figure`, () => {
      const assignment = CODE.match(new RegExp(`${field}\\s*:\\s*([A-Za-z0-9_.]+)`));
      expect(assignment, `${field} must be assigned in the FinanceInput`).not.toBeNull();
      // The assigned token must be exactly `null` — not 0, not `mrr`, not any proxy.
      expect(assignment![1]).toBe("null");
    });
  }
});

describe("Finance AI — wired into the HQ nav", () => {
  it("the admin nav links to /admin/finance", () => {
    expect(LAYOUT).toMatch(/href:\s*"\/admin\/finance"/);
  });
});
