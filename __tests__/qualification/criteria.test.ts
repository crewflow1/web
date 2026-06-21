import { describe, it, expect } from "vitest";
import {
  DISQUALIFY_FLOOR,
  EVIDENCE_FLOOR,
  QUALIFY_THRESHOLD,
  qualifyCompany,
  sectorOf,
  territoryOf,
  type QualificationInput,
} from "@/lib/qualification/criteria";

/**
 * Lead Qualification Engine — the deterministic rubric (Module 3).
 *
 * A qualify/disqualify verdict gates a company's place in the pipeline, so it
 * must be reconstructable from named rules — never an opaque model call. These
 * pin the rules: the territory HARD gate, the fit score as arbiter, evidence as
 * a guard against thin data, and the honest confidence (share of known weight).
 */

function input(overrides: Partial<QualificationInput> = {}): QualificationInput {
  return {
    score: null,
    evidence: null,
    researched: false,
    country: null,
    location: null,
    sector: null,
    industry: null,
    decisionMakers: 0,
    reachableDecisionMakers: 0,
    ...overrides,
  };
}

/** A fully-known, in-territory, strong-fit lead. */
function qualified(overrides: Partial<QualificationInput> = {}): QualificationInput {
  return input({
    score: 75,
    evidence: 50,
    researched: true,
    country: "United Kingdom",
    location: "Leeds",
    sector: "Groundworks",
    decisionMakers: 2,
    reachableDecisionMakers: 1,
    ...overrides,
  });
}

describe("qualifyCompany — exposed thresholds", () => {
  it("pins the qualification bar, disqualify floor and evidence floor", () => {
    expect(QUALIFY_THRESHOLD).toBe(60);
    expect(DISQUALIFY_FLOOR).toBe(30);
    expect(EVIDENCE_FLOOR).toBe(25);
  });
});

describe("qualifyCompany — always five transparent criteria", () => {
  it("returns the five weighted criteria, each with reasoning + honesty flags", () => {
    const v = qualifyCompany(qualified());
    expect(v.criteria).toHaveLength(5);
    expect(v.criteria.map((c) => c.key).sort()).toEqual([
      "decision_maker_access",
      "evidence",
      "fit_score",
      "sector",
      "territory",
    ]);
    for (const c of v.criteria) {
      expect(typeof c.label).toBe("string");
      expect(c.detail).toBeTruthy(); // reasoning is mandatory — never a black box
      expect(c.weight).toBeGreaterThan(0);
      expect(typeof c.known).toBe("boolean");
    }
  });

  it("weights sum to 1.0", () => {
    const v = qualifyCompany(qualified());
    const total = v.criteria.reduce((sum, c) => sum + c.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("a fully-known lead reports 100% confidence; an empty one is low + honest", () => {
    expect(qualifyCompany(qualified()).confidence).toBe(100);

    const empty = qualifyCompany(input());
    // Only decision-maker access is observable at zero evidence (count is a
    // real, known answer) → 0.1 of total weight → 10% confidence.
    expect(empty.confidence).toBe(10);
    const known = empty.criteria.filter((c) => c.known).map((c) => c.key);
    expect(known).toEqual(["decision_maker_access"]);
    for (const c of empty.criteria) {
      if (!c.known) expect(c.passed).toBeNull();
    }
  });
});

describe("qualifyCompany — qualified path", () => {
  it("qualifies a strong, in-territory, well-evidenced lead", () => {
    const v = qualifyCompany(qualified({ score: 75 }));
    expect(v.decision).toBe("qualified");
    expect(v.recommendedStatus).toBe("qualified");
    expect(v.tier).toBe("warm");
    expect(v.score).toBe(75);
    expect(v.rationale[0]).toMatch(/strong fit/i);
    expect(v.summary).toMatch(/qualified/i);
  });

  it("qualifies exactly at the bar (score = QUALIFY_THRESHOLD)", () => {
    expect(qualifyCompany(qualified({ score: QUALIFY_THRESHOLD })).decision).toBe("qualified");
  });

  it("tier reflects the fit band independent of the decision", () => {
    expect(qualifyCompany(qualified({ score: 88 })).tier).toBe("hot");
  });
});

describe("qualifyCompany — territory is a hard gate", () => {
  it("disqualifies a confidently-overseas lead REGARDLESS of a strong fit", () => {
    const v = qualifyCompany(
      qualified({ score: 90, evidence: 80, country: "France", location: "Paris" }),
    );
    expect(v.decision).toBe("disqualified");
    expect(v.recommendedStatus).toBe("disqualified");
    // The fit tier is still hot — decision and tier are orthogonal.
    expect(v.tier).toBe("hot");
    expect(v.summary).toMatch(/outside the uk/i);
  });

  it("does not misread 'Ukraine' as the UK (word-boundary matching)", () => {
    const v = qualifyCompany(qualified({ score: 90, country: "Ukraine", location: "Kyiv" }));
    expect(v.decision).toBe("disqualified");
  });

  it("unknown territory NEVER hard-fails — it just lowers confidence", () => {
    // Country blank, location a bare park name with no UK signal → unknown.
    const v = qualifyCompany(
      qualified({ score: 70, country: "", location: "Riverside Business Park" }),
    );
    expect(v.decision).toBe("qualified"); // not disqualified
    const territory = v.criteria.find((c) => c.key === "territory")!;
    expect(territory.known).toBe(false);
    expect(v.confidence).toBe(80); // territory's 0.2 weight is excluded
  });
});

describe("qualifyCompany — disqualified by poor fit", () => {
  it("disqualifies a clear miss below the floor", () => {
    const v = qualifyCompany(qualified({ score: 20 }));
    expect(v.decision).toBe("disqualified");
    expect(v.recommendedStatus).toBe("disqualified");
    expect(v.tier).toBe("cold");
  });

  it("disqualifies just below the floor; holds at the floor", () => {
    expect(qualifyCompany(qualified({ score: DISQUALIFY_FLOOR - 1 })).decision).toBe("disqualified");
    expect(qualifyCompany(qualified({ score: DISQUALIFY_FLOOR })).decision).toBe("review");
  });
});

describe("qualifyCompany — held for review", () => {
  it("holds a marginal fit between the floor and the bar", () => {
    const v = qualifyCompany(qualified({ score: 48 }));
    expect(v.decision).toBe("review");
    expect(v.recommendedStatus).toBeNull();
    expect(v.tier).toBe("cool");
  });

  it("holds just below the bar", () => {
    expect(qualifyCompany(qualified({ score: QUALIFY_THRESHOLD - 1 })).decision).toBe("review");
  });

  it("holds a strong score on a near-empty profile (evidence guard)", () => {
    const v = qualifyCompany(qualified({ score: 80, evidence: EVIDENCE_FLOOR - 1 }));
    expect(v.decision).toBe("review");
    expect(v.recommendedStatus).toBeNull();
    expect(v.rationale[0]).toMatch(/enriched|verify/i);
  });

  it("qualifies once evidence clears the floor", () => {
    expect(qualifyCompany(qualified({ score: 80, evidence: EVIDENCE_FLOOR })).decision).toBe(
      "qualified",
    );
  });

  it("holds an unscored lead — no basis to qualify", () => {
    const v = qualifyCompany(input({ country: "United Kingdom" }));
    expect(v.decision).toBe("review");
    expect(v.recommendedStatus).toBeNull();
    expect(v.score).toBeNull();
    expect(v.criteria.find((c) => c.key === "fit_score")!.known).toBe(false);
  });
});

describe("territoryOf — country is authoritative, conservative on noise", () => {
  it("reads UK nations + the GB/UK abbreviations", () => {
    expect(territoryOf("United Kingdom", null)).toBe("uk");
    expect(territoryOf("UK", null)).toBe("uk");
    expect(territoryOf("England", null)).toBe("uk");
    expect(territoryOf("Scotland", null)).toBe("uk");
    expect(territoryOf(null, "Cardiff, Wales")).toBe("uk");
  });

  it("treats a non-empty, non-UK country as overseas", () => {
    expect(territoryOf("France", null)).toBe("overseas");
    expect(territoryOf("Ireland", "Dublin")).toBe("overseas");
    expect(territoryOf("United States", null)).toBe("overseas");
  });

  it("stays unknown on no signal or a bare city (no hard-fail on noise)", () => {
    expect(territoryOf(null, null)).toBe("unknown");
    expect(territoryOf("", "")).toBe("unknown");
    // A bare city with no country is deliberately NOT enough to gate on.
    expect(territoryOf(null, "Manchester")).toBe("unknown");
  });
});

describe("sectorOf — construction classification", () => {
  it("trusts an explicit construction_sector", () => {
    expect(sectorOf("Groundworks", null)).toBe("construction");
  });

  it("classifies industry text when sector is blank", () => {
    expect(sectorOf(null, "Roofing contractor")).toBe("construction");
    expect(sectorOf(null, "Civil engineering")).toBe("construction");
    expect(sectorOf(null, "Hospitality")).toBe("other");
  });

  it("is unknown with no signal", () => {
    expect(sectorOf(null, null)).toBe("unknown");
    expect(sectorOf(null, "")).toBe("unknown");
  });
});
