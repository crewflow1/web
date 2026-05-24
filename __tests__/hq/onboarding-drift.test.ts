import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Sync HQ /admin/onboarding's pct with the customer dashboard's live
 * computeProgress(). Before this fix the HQ row read the operator-set
 * `organizations.onboarding_percent` integer which drifted as the
 * customer made progress.
 *
 * Pin the two invariants that matter:
 *   1. The service imports + USES `computeProgress` from the shared
 *      checklist module.
 *   2. The merged OnboardingRow's `onboarding_percent` is sourced
 *      from the live map, falling back to the stored column only if
 *      the live derivation failed.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const SVC = read("server/services/hq-onboarding-snapshot.ts");

describe("HQ onboarding drift hotfix", () => {
  it("imports the shared checklist module (single source of truth)", () => {
    expect(SVC).toMatch(/from "@\/lib\/onboarding\/checklist"/);
    expect(SVC).toMatch(/computeProgress/);
    expect(SVC).toMatch(/OnboardingSnapshot/);
  });

  it("builds a live progress map per org via buildHqChecklistProgress", () => {
    expect(SVC).toMatch(/async function buildHqChecklistProgress/);
    expect(SVC).toMatch(/livePctByOrg/);
  });

  it("ONE query per dependent table — does not fan out per org", () => {
    // The batched approach keeps round-trips O(1). Look for the five
    // .in("org_id", ids) calls inside the helper.
    const helperBlock =
      SVC.match(
        /async function buildHqChecklistProgress[\s\S]*?return out;\s*\}/,
      )?.[0] ?? "";
    const inCalls = (helperBlock.match(/\.in\("org_id", ids\)/g) ?? []).length;
    expect(inCalls).toBeGreaterThanOrEqual(5);
  });

  it("OnboardingRow.onboarding_percent prefers the live map", () => {
    expect(SVC).toMatch(
      /onboarding_percent:[\s\S]*livePct[\s\S]*Number\(o\.onboarding_percent/,
    );
  });

  it("falls back to the stored column when the live derivation is missing", () => {
    expect(SVC).toMatch(/typeof livePct === "number"/);
  });

  it("migration_percent stays operator-set (separate concern)", () => {
    // Migration % is a different concept (operator's judgement) — leave it.
    expect(SVC).toMatch(/migration_percent:\s*Number\(o\.migration_percent/);
  });
});
