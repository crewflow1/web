import { describe, it, expect } from "vitest";
import { scoreCompany, type ResearchScoreInput } from "@/lib/research/score";
import {
  emptyIntelligence,
  type CompanyIntelligence,
  type DecisionMaker,
} from "@/lib/research/model";

/**
 * Research AI — transparent company score (CEO Directive 005, Phase 6).
 *
 * "Every score must include reasoning. No black box." The composite blends
 * ONLY the factors that have real evidence; unknown factors are listed (so the
 * gap is visible) but excluded from the maths, and confidence reports the share
 * of weight that was actually known. These pin that honesty contract.
 */

function intel(overrides: Partial<CompanyIntelligence> = {}): CompanyIntelligence {
  return { ...emptyIntelligence(), ...overrides };
}

function input(overrides: Partial<ResearchScoreInput> = {}): ResearchScoreInput {
  return {
    intelligence: emptyIntelligence(),
    decisionMakers: [],
    detectedTechnologies: [],
    location: null,
    relationshipScore: null,
    ...overrides,
  };
}

describe("scoreCompany — always ten transparent factors", () => {
  it("returns all ten factors, each with a value, weight, detail and known flag", () => {
    const score = scoreCompany(input());
    expect(score.factors).toHaveLength(10);
    for (const f of score.factors) {
      expect(typeof f.label).toBe("string");
      expect(f.detail).toBeTruthy(); // reasoning is mandatory — never a black box
      expect(f.weight).toBeGreaterThan(0);
      expect(typeof f.known).toBe("boolean");
    }
  });

  it("weights sum to 1.0 across the directive's ten factors", () => {
    const score = scoreCompany(input());
    const total = score.factors.reduce((sum, f) => sum + f.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});

describe("scoreCompany — thin profile is honest, not a confident guess", () => {
  it("blends only the always-observable factors and reports low confidence", () => {
    const score = scoreCompany(input());

    // buying_intent, technology and decision_maker_access are observable even
    // at zero evidence, so the composite is non-null but low-confidence.
    const known = score.factors.filter((f) => f.known).map((f) => f.key).sort();
    expect(known).toEqual([
      "buying_intent",
      "decision_maker_access",
      "technology",
    ]);

    // 30*0.12 + 42*0.08 + 30*0.08 = 9.36 over knownWeight 0.28 → 33
    expect(score.overall).toBe(33);
    // knownWeight 0.28 of total 1.0
    expect(score.confidence).toBe(28);
    expect(score.band).toBe("cold");
  });

  it("zeroes the value of every unknown factor and marks it neutral", () => {
    const score = scoreCompany(input());
    for (const f of score.factors) {
      if (!f.known) {
        expect(f.value).toBe(0);
        expect(f.tone).toBe("neutral");
      }
    }
  });
});

describe("scoreCompany — strong-fit company", () => {
  it("scores a high-confidence ICP match across all ten known factors", () => {
    const dms: DecisionMaker[] = [
      {
        fullName: "Jane Doe",
        title: "Managing Director",
        seniority: "director",
        email: "jane@buildco.co.uk",
        linkedinUrl: null,
        confidence: 80,
        reasoning: null,
      },
    ];
    const score = scoreCompany(
      input({
        intelligence: intel({
          constructionSector: "Groundworks",
          revenueEstimateGbp: 1_500_000,
          employeeEstimate: 30,
          digitalMaturityScore: 75,
          growthScore: 80,
          buyingSignals: ["requested a demo", "comparing software", "budget approved"],
          softwareUsed: ["Xero", "Sage"],
          locations: ["London"],
        }),
        decisionMakers: dms,
        detectedTechnologies: ["WordPress", "Google Analytics", "Stripe"],
        relationshipScore: 65,
      }),
    );

    expect(score.factors.every((f) => f.known)).toBe(true);
    expect(score.confidence).toBe(100);
    expect(score.overall).toBe(83);
    expect(score.band).toBe("hot");
  });
});

describe("scoreCompany — confidence tracks evidence breadth", () => {
  it("rises as more factors become known", () => {
    const thin = scoreCompany(input());
    const richer = scoreCompany(
      input({
        intelligence: intel({
          constructionSector: "Roofing",
          employeeEstimate: 25,
          locations: ["Manchester"],
        }),
      }),
    );
    expect(richer.confidence).toBeGreaterThan(thin.confidence);
  });
});
