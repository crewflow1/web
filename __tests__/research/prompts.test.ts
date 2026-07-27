import { describe, it, expect } from "vitest";
import {
  CREWFLOW_MODULES,
  analysisHasContent,
  extractJson,
  parseAnalysis,
  parseSalesPrep,
  salesPrepHasContent,
  type ParsedAnalysis,
} from "@/lib/research/prompts";
import { emptyIntelligence } from "@/lib/research/model";

/**
 * Research AI — prompt parse + coercion layer (CEO Directive 005, Phases 2–5).
 *
 * The contract is enforced twice: the prompt forbids invention, then every
 * parser re-validates so a hallucinated string where a number belongs, an
 * "unknown" sentinel, a fake decision-maker, an invalid email, or a
 * non-CrewFlow module degrades to the honest null / drop rather than persisting
 * fabricated data. "Draft only" — nothing here ever sends.
 */

describe("extractJson", () => {
  it("parses bare JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips ```json fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("strips bare ``` fences", () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers a JSON object embedded in prose", () => {
    expect(extractJson('Sure, here you go: {"a":1} hope that helps')).toEqual({
      a: 1,
    });
  });

  it("returns null for unrecoverable input", () => {
    expect(extractJson("no json at all")).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});

describe("parseAnalysis — grounded reads", () => {
  it("lifts a well-formed profile and decision maker", () => {
    const parsed = parseAnalysis(
      JSON.stringify({
        intelligence: {
          overview: "A groundworks contractor",
          industry: "Construction",
          services: ["Groundworks", "Drainage"],
          painPoints: ["manual admin"],
          employeeEstimate: 40,
          confidence: 70,
        },
        decisionMakers: [
          {
            fullName: "Jane Doe",
            title: "Managing Director",
            seniority: "director",
            email: "jane@acme.co.uk",
            linkedinUrl: "https://www.linkedin.com/in/jane",
            confidence: 85,
          },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    const p = parsed!;
    expect(p.intelligence.overview).toBe("A groundworks contractor");
    expect(p.intelligence.industry).toBe("Construction");
    expect(p.intelligence.services).toEqual(["Groundworks", "Drainage"]);
    expect(p.intelligence.employeeEstimate).toBe(40);
    expect(p.intelligence.confidence).toBe(70);
    expect(p.decisionMakers).toHaveLength(1);
    expect(p.decisionMakers[0]!.fullName).toBe("Jane Doe");
    expect(p.decisionMakers[0]!.seniority).toBe("director");
    expect(p.decisionMakers[0]!.email).toBe("jane@acme.co.uk");
  });

  it("never trusts the model for the deterministic scores", () => {
    const parsed = parseAnalysis(
      JSON.stringify({
        intelligence: { websiteQualityScore: 99, digitalMaturityScore: 88 },
        decisionMakers: [],
      }),
    );
    // These are computed deterministically and must stay null from the parse.
    expect(parsed!.intelligence.websiteQualityScore).toBeNull();
    expect(parsed!.intelligence.digitalMaturityScore).toBeNull();
  });

  it("coerces sentinels, bad numbers and invalid fields to honest nulls", () => {
    const parsed = parseAnalysis(
      JSON.stringify({
        intelligence: {
          overview: "unknown",
          industry: "N/A",
          employeeEstimate: -5,
          confidence: "not a number",
        },
        decisionMakers: [
          { title: "MD" }, // no name → not a decision maker
          { fullName: "Real Person", seniority: "chief", email: "nope" },
        ],
      }),
    );
    const p = parsed!;
    expect(p.intelligence.overview).toBeNull();
    expect(p.intelligence.industry).toBeNull();
    expect(p.intelligence.employeeEstimate).toBeNull();
    expect(p.intelligence.confidence).toBeNull();
    // the nameless DM is dropped; the bad seniority + email are coerced
    expect(p.decisionMakers).toHaveLength(1);
    expect(p.decisionMakers[0]!.fullName).toBe("Real Person");
    expect(p.decisionMakers[0]!.seniority).toBe("unknown");
    expect(p.decisionMakers[0]!.email).toBeNull();
  });

  it("returns null when there is no recoverable JSON", () => {
    expect(parseAnalysis("the model refused")).toBeNull();
  });
});

describe("parseSalesPrep — draft only, real modules only", () => {
  it("keeps only genuine CrewFlow modules and coerces drafts to strings", () => {
    const parsed = parseSalesPrep(
      JSON.stringify({
        brief: {
          recommendedModules: ["Job Management", "Fake Module", "AI Receptionist"],
          coldCallOpener: "Hi, calling about your job admin",
          valueProposition: "One system for the whole crew",
        },
        drafts: { coldEmail: "Dear Jane,…" },
      }),
    );
    expect(parsed).not.toBeNull();
    const s = parsed!;
    expect(s.brief.recommendedModules).toEqual(["Job Management", "AI Receptionist"]);
    expect(s.brief.recommendedModules).not.toContain("Fake Module");
    expect(s.drafts.coldEmail).toBe("Dear Jane,…");
    // missing drafts degrade to empty strings, never undefined
    expect(s.drafts.linkedinMessage).toBe("");
    expect(s.drafts.voicemailScript).toBe("");
  });

  it("only ever recommends modules from the published product list", () => {
    const allowed = new Set(CREWFLOW_MODULES.map((m) => m.toLowerCase()));
    const parsed = parseSalesPrep(
      JSON.stringify({
        brief: { recommendedModules: [...CREWFLOW_MODULES, "Invented Module"] },
        drafts: {},
      }),
    );
    for (const m of parsed!.brief.recommendedModules) {
      expect(allowed.has(m.toLowerCase())).toBe(true);
    }
  });

  it("returns null when there is no recoverable JSON", () => {
    expect(parseSalesPrep("nope")).toBeNull();
  });
});

describe("content guards", () => {
  it("analysisHasContent is false for an empty profile, true once grounded", () => {
    const empty: ParsedAnalysis = {
      intelligence: emptyIntelligence(),
      decisionMakers: [],
    };
    expect(analysisHasContent(empty)).toBe(false);
    expect(
      analysisHasContent({
        intelligence: { ...emptyIntelligence(), overview: "A real builder" },
        decisionMakers: [],
      }),
    ).toBe(true);
  });

  it("salesPrepHasContent reflects whether any usable draft/brief exists", () => {
    const empty = parseSalesPrep("{}");
    expect(empty).not.toBeNull();
    expect(salesPrepHasContent(empty!)).toBe(false);

    const withDraft = parseSalesPrep(
      JSON.stringify({ brief: {}, drafts: { coldEmail: "Dear Jane,…" } }),
    );
    expect(salesPrepHasContent(withDraft!)).toBe(true);
  });
});
