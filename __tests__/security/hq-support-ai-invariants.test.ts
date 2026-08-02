import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * HQ Support AI — trust-boundary invariants (hermetic source scan).
 *
 * Pins:
 *   1. The page AND the aggregator gate on requireHqPage — HQ-only, never
 *      tenant auth. A non-allowlisted caller must 404 before seeing any figure.
 *   2. The reply-draft / narrative path is DARK: the service constructs NO model
 *      SDK and imports no AI/governor module, so the dark path cannot spend
 *      money. If a governed call is ever added it must go through
 *      invokeWithGovernor under a registered key — this test fails loudly the
 *      moment a raw SDK is introduced.
 *   3. Registered in the HQ nav.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const PAGE = read("app/admin/support-ai/page.tsx");
const SERVICE = read("server/services/hq-support-ai.ts");
const PURE = read("lib/hq/support-ai.ts");
const LAYOUT = read("app/admin/layout.tsx");

describe("Support AI — super-admin gated (HQ-only)", () => {
  it("the page imports and awaits requireHqPage", () => {
    expect(PAGE).toMatch(/import\s*\{[^}]*requireHqPage[^}]*\}\s*from\s*"@\/server\/auth\/hq"/);
    expect(PAGE).toMatch(/await\s+requireHqPage\(\)/);
  });

  it("the aggregator re-gates on requireHqPage before reading any ticket", () => {
    expect(SERVICE).toMatch(/import\s*\{[^}]*requireHqPage[^}]*\}\s*from\s*"@\/server\/auth\/hq"/);
    expect(SERVICE).toMatch(/await\s+requireHqPage\(\)/);
  });

  it("the parent /admin layout also gates on requireHqPage (defence in depth)", () => {
    expect(LAYOUT).toMatch(/await\s+requireHqPage\(\)/);
  });
});

describe("Support AI — reply drafts are dark, construct no model SDK", () => {
  it("the narrative loader returns null (dark stub)", () => {
    expect(SERVICE).toMatch(/loadSupportNarrative/);
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

describe("Support AI — the pure layer is clock- and Supabase-free", () => {
  it("takes an injected `now` and never touches Date.now or the DB", () => {
    expect(PURE).toMatch(/computeSupportBoard\([^)]*now:\s*Date/);
    expect(PURE).not.toMatch(/Date\.now\(/);
    expect(PURE).not.toMatch(/from\s*"@\/lib\/supabase|createAdminClient/);
  });
});

describe("Support AI — wired into the HQ nav", () => {
  it("the admin nav links to /admin/support-ai", () => {
    expect(LAYOUT).toMatch(/href:\s*"\/admin\/support-ai"/);
  });
});
