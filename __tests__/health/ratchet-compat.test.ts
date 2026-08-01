import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * RATCHET COMPAT — the health suite must not evade the anti-composite-score
 * doctrine by writing a blended score in its sibling directory.
 *
 * The intelligence ratchet (__tests__/intelligence/source-assertions.test.ts)
 * greps lib/intelligence/** for `overallScore` / `healthScore` / `compositeScore`
 * / `weightedScore` and fails if one appears. lib/health/** exists precisely so
 * the health suite sits OUTSIDE that directory — so this test re-applies the same
 * grep to lib/health/**, closing the obvious loophole (move the blend one folder
 * over). It ALSO re-asserts the intelligence ratchet still holds, so the two
 * directories can never disagree about the rule.
 */

const ROOT = resolve(__dirname, "..", "..");
const FORBIDDEN = /overallScore|healthScore|compositeScore|weightedScore/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("composite-score ratchet — lib/health", () => {
  it("no module in lib/health carries a blended overall/health/composite score", () => {
    const files = tsFiles(resolve(ROOT, "lib", "health"));
    expect(files.length).toBeGreaterThanOrEqual(3); // company-health, customer-ltv, subcontractor-score
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, `${f} must not define a composite score`).not.toMatch(FORBIDDEN);
    }
  });

  it("the existing lib/intelligence ratchet still passes", () => {
    const dir = resolve(ROOT, "lib", "intelligence");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) {
      const text = readFileSync(resolve(dir, f), "utf8");
      expect(text, `${f} must not define a composite score`).not.toMatch(FORBIDDEN);
    }
  });

  it("the company-health UI surfaces text with every band colour (never colour alone)", () => {
    // The banner renders HEALTH_BAND_LABEL words next to the colour pill — pin
    // that the label map exists and is textual, so a colour-only regression
    // would need to also delete these words and fail loudly.
    const src = readFileSync(resolve(ROOT, "lib", "health", "company-health.ts"), "utf8");
    expect(src).toContain("HEALTH_BAND_LABEL");
    expect(src).toMatch(/insufficient:\s*"Not enough data"/);
  });
});
