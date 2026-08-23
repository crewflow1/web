import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ Finance AI — trust-boundary invariants (hermetic source scan).
 *
 * Pins:
 *   1. The page AND the aggregator gate on requireHqPage — HQ-only, never
 *      tenant auth. A non-allowlisted caller must 404 before seeing any figure.
 *   2. The board narrative is GOVERNED but DARK BY DEFAULT: the aggregator
 *      delegates to the shared HQ narrative helper (server/services/hq-narrative.ts)
 *      under the registered `hq.finance_narrative` key. It constructs NO raw model
 *      SDK and opens no model door itself — the door + governor live in the helper
 *      — so with no tier bound it returns null and cannot spend money. A raw SDK
 *      on this surface still fails this test loudly.
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

describe("Finance AI — narrative is GOVERNED (fail-closed), constructs no raw SDK", () => {
  it("the narrative loader delegates to the shared governed helper", () => {
    expect(SERVICE).toMatch(/loadFinanceNarrative/);
    // The governed call the earlier dark stub anticipated: it goes through the
    // shared HQ narrative helper under its registered key, never a raw client.
    expect(SERVICE).toMatch(/generateHqBoardNarrative\(\s*"hq\.finance_narrative"/);
    expect(SERVICE).toMatch(/@\/server\/services\/hq-narrative/);
  });

  it("the service constructs no raw model SDK and opens no model door directly", () => {
    // No raw provider SDKs.
    expect(SERVICE).not.toMatch(/@anthropic-ai\/sdk|from\s*"openai"|new\s+Anthropic\(|new\s+OpenAI\(/);
    // The provider door + governor live in the shared helper (server/services/
    // hq-narrative.ts), never on this aggregator surface itself.
    expect(SERVICE).not.toMatch(/from\s*"@\/lib\/ai\//);
    expect(SERVICE).not.toMatch(/\bgetTextProvider\s*\(|\bgetVisionProvider\s*\(/);
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
    expect(read("app/admin/_nav/hq-nav-model.ts")).toMatch(/href:\s*"\/admin\/finance"/);
  });
});
