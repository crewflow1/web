import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  scoreLead,
  leadScoreBand,
  LEAD_SCORE_FACTOR_SPECS,
  LEAD_SCORE_HOT_MIN,
  LEAD_SCORE_WARM_MIN,
  type LeadScoreInput,
} from "@/lib/leads/score";
import {
  bucketPipelineLeads,
  type RawPipelineLead,
} from "@/app/(app)/leads/pipeline";

/**
 * Tenant lead-score rubric — the deterministic scoring engine.
 *
 * Covers: rubric math + band boundaries, the per-factor breakdown + kinds,
 * the pipeline sort/filter, recompute determinism, org-isolation (the rubric
 * is pure + org-agnostic; the read/write paths stay org-pinned), and
 * default-safety (a bare lead scores validly and nothing throws).
 *
 * Hermetic: exercises the pure rubric + pure aggregator directly — no Supabase.
 */

const AS_OF = Date.parse("2026-08-20T00:00:00.000Z");
const daysBefore = (n: number) =>
  new Date(AS_OF - n * 24 * 60 * 60 * 1000).toISOString();

function input(overrides: Partial<LeadScoreInput> = {}): LeadScoreInput {
  return {
    status: "new",
    source: "phone",
    estimatedValue: null,
    contactName: "Alex Smith",
    contactEmail: null,
    contactPhone: "07000 000000",
    lastActivityAt: daysBefore(1),
    createdAt: daysBefore(1),
    customerId: null,
    asOfMs: AS_OF,
    ...overrides,
  };
}

describe("scoreLead — rubric math", () => {
  it("blends a fully-known lead to the exact weighted total", () => {
    const s = scoreLead(
      input({
        status: "quoted",
        source: "referral",
        estimatedValue: 5000, // £2k–10k → 78
        contactName: "Alex",
        contactEmail: "a@b.co",
        contactPhone: "07000",
        lastActivityAt: daysBefore(1), // ≤3d → 90
        customerId: "c1", // linked, not repeat → 74
      }),
    );
    // 78*.25 + 82*.22 + 90*.18 + 90*.15 + 100*.12 + 74*.08 = 85.16 → 85
    expect(s.score).toBe(85);
    expect(s.band).toBe("hot");
    expect(s.confidence).toBe(100);
  });

  it("weights sum to exactly 1.0", () => {
    const total = LEAD_SCORE_FACTOR_SPECS.reduce((a, f) => a + f.weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("excludes unknown factors from the blend and reports lower confidence", () => {
    const s = scoreLead(
      input({
        status: "new", // 30
        source: "phone", // 74
        estimatedValue: null, // budget unknown
        contactName: "Alex",
        contactEmail: null,
        contactPhone: "07000", // 2/3 → 67
        lastActivityAt: null, // recency unknown
        createdAt: null,
        customerId: null, // relationship 40
      }),
    );
    // knownWeight = .22+.15+.12+.08 = .57
    // weighted = 30*.22 + 74*.15 + 67*.12 + 40*.08 = 28.94 → 28.94/.57 = 50.77 → 51
    expect(s.score).toBe(51);
    expect(s.band).toBe("warm");
    expect(s.confidence).toBe(57);
    const budget = s.factors.find((f) => f.key === "budget")!;
    const recency = s.factors.find((f) => f.key === "recency")!;
    expect(budget.known).toBe(false);
    expect(budget.value).toBe(0);
    expect(recency.known).toBe(false);
  });
});

describe("leadScoreBand — boundaries", () => {
  it("cuts hot / warm / cold at the named thresholds", () => {
    expect(leadScoreBand(100)).toBe("hot");
    expect(leadScoreBand(LEAD_SCORE_HOT_MIN)).toBe("hot"); // 67
    expect(leadScoreBand(LEAD_SCORE_HOT_MIN - 1)).toBe("warm"); // 66
    expect(leadScoreBand(LEAD_SCORE_WARM_MIN)).toBe("warm"); // 34
    expect(leadScoreBand(LEAD_SCORE_WARM_MIN - 1)).toBe("cold"); // 33
    expect(leadScoreBand(0)).toBe("cold");
  });
});

describe("scoreLead — per-factor breakdown", () => {
  it("always returns all six factors, in fixed order, each self-labelled", () => {
    const s = scoreLead(input());
    expect(s.factors.map((f) => f.key)).toEqual([
      "budget",
      "stage",
      "recency",
      "source",
      "contactability",
      "relationship",
    ]);
    // Contactability is the one exact-arithmetic factor.
    expect(s.factors.find((f) => f.key === "contactability")!.kind).toBe("derived");
    // The judgement-rule factors declare themselves heuristic.
    expect(s.factors.find((f) => f.key === "budget")!.kind).toBe("heuristic");
    expect(s.factors.find((f) => f.key === "stage")!.kind).toBe("heuristic");
    // Every factor carries a non-empty plain-English basis.
    for (const f of s.factors) expect(f.detail.length).toBeGreaterThan(0);
  });

  it("contactability is exact: 2 of 3 fields → 67, all three → 100", () => {
    const two = scoreLead(input({ contactName: "A", contactEmail: null, contactPhone: "07" }));
    expect(two.factors.find((f) => f.key === "contactability")!.value).toBe(67);
    const three = scoreLead(input({ contactName: "A", contactEmail: "a@b.co", contactPhone: "07" }));
    expect(three.factors.find((f) => f.key === "contactability")!.value).toBe(100);
  });

  it("recency bands step down as a lead goes stale", () => {
    const val = (days: number) =>
      scoreLead(input({ lastActivityAt: daysBefore(days) })).factors.find(
        (f) => f.key === "recency",
      )!.value;
    expect(val(1)).toBe(90); // ≤3d
    expect(val(5)).toBe(72); // ≤7d
    expect(val(10)).toBe(54); // ≤14d
    expect(val(20)).toBe(36); // ≤30d
    expect(val(60)).toBe(18); // stale
  });

  it("a lost lead scores stage 0 (known), a won lead 100", () => {
    expect(scoreLead(input({ status: "lost" })).factors.find((f) => f.key === "stage")!.value).toBe(0);
    expect(scoreLead(input({ status: "won" })).factors.find((f) => f.key === "stage")!.value).toBe(100);
  });
});

describe("scoreLead — recompute determinism & org isolation", () => {
  it("is a pure function: identical input + asOfMs ⇒ identical output", () => {
    const a = scoreLead(input({ estimatedValue: 12345, status: "qualified" }));
    const b = scoreLead(input({ estimatedValue: 12345, status: "qualified" }));
    expect(b).toEqual(a);
  });

  it("takes no org id — two orgs' identical leads score identically (no leakage possible)", () => {
    // The rubric reads one lead row and nothing else, so it cannot cross the
    // tenant boundary; org isolation is the read/write layer's job (asserted
    // by source below), never the rubric's.
    const orgA = scoreLead(input({ customerId: "org-a-customer" }));
    const orgB = scoreLead(input({ customerId: "org-b-customer" }));
    expect(orgB.score).toBe(orgA.score);
    expect(orgB.band).toBe(orgA.band);
  });

  it("the score cache service reads AND writes org-pinned", () => {
    const src = readFileSync(
      resolve(__dirname, "../../server/services/lead-score.ts"),
      "utf8",
    );
    const pins = src.match(/\.eq\("org_id", orgId\)/g) ?? [];
    expect(pins.length).toBeGreaterThanOrEqual(2); // one on the read, one on the write
  });

  it("every lead-mutating action refreshes the score cache", () => {
    const src = readFileSync(
      resolve(__dirname, "../../app/(app)/leads/actions.ts"),
      "utf8",
    );
    // Each scoring-input-changing action (create, update, moveLeadStage) calls
    // the recompute. (acknowledgeLead deliberately doesn't — see its comment.)
    expect((src.match(/recomputeLeadScore\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("scoreLead — default-safety", () => {
  it("scores a bare lead (only required fields) validly, never null, never throws", () => {
    const s = scoreLead({
      status: "new",
      source: "phone",
      estimatedValue: null,
      contactName: "Only Name",
      contactEmail: null,
      contactPhone: "07000",
      lastActivityAt: null,
      customerId: null,
      asOfMs: AS_OF,
    });
    expect(Number.isFinite(s.score)).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(["hot", "warm", "cold"]).toContain(s.band);
  });

  it("tolerates a null/unknown status and a garbage source without crashing", () => {
    expect(() =>
      scoreLead(input({ status: null, source: "made_up_channel" })),
    ).not.toThrow();
    const s = scoreLead(input({ status: "archived_legacy" }));
    // Unknown status is treated as a new lead, and it's still 'known'.
    expect(s.factors.find((f) => f.key === "stage")!.known).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pipeline sort + filter (the /leads list surface)
// ---------------------------------------------------------------------------

function rawLead(o: Partial<RawPipelineLead> & { id: string }): RawPipelineLead {
  return {
    status: "new",
    source: "phone",
    urgency: null,
    postcode: null,
    service: null,
    estimated_value: null,
    last_activity_at: daysBefore(1),
    customer_id: null,
    contact_name: "Alex",
    contact_email: null,
    contact_phone: "07000",
    created_at: daysBefore(1),
    customer: null,
    assigned: null,
    ...o,
  };
}

describe("bucketPipelineLeads — score sort + band filter", () => {
  it("sorts cards within a column hottest-first", () => {
    const { byStage } = bucketPipelineLeads(
      [
        rawLead({ id: "cold", status: "new", estimated_value: null }),
        rawLead({ id: "hot", status: "new", estimated_value: 50000 }),
      ],
      { asOfMs: AS_OF },
    );
    expect(byStage.new.map((c) => c.id)).toEqual(["hot", "cold"]);
    expect(byStage.new[0]!.score).toBeGreaterThan(byStage.new[1]!.score);
  });

  it("attaches a score + band to every card", () => {
    const { byStage } = bucketPipelineLeads(
      [rawLead({ id: "a", status: "quoted", estimated_value: 40000 })],
      { asOfMs: AS_OF },
    );
    const card = byStage.quoted[0]!;
    expect(typeof card.score).toBe("number");
    expect(["hot", "warm", "cold"]).toContain(card.band);
  });

  it("band filter drops non-matching leads from BOTH columns and the forecast", () => {
    const hot = rawLead({
      id: "hot",
      status: "quoted",
      estimated_value: 40000,
      source: "referral",
      contact_email: "a@b.co",
      customer_id: "c1",
      last_activity_at: daysBefore(1),
    });
    const cold = rawLead({
      id: "cold",
      status: "lost",
      estimated_value: 300,
      source: "other",
      last_activity_at: daysBefore(400),
    });

    const all = bucketPipelineLeads([hot, cold], { asOfMs: AS_OF });
    expect(all.totalValue).toBe(40300);

    const onlyHot = bucketPipelineLeads([hot, cold], { asOfMs: AS_OF, band: "hot" });
    const ids = new Set(
      Object.values(onlyHot.byStage).flat().map((c) => c.id),
    );
    expect(ids.has("hot")).toBe(true);
    expect(ids.has("cold")).toBe(false);
    expect(onlyHot.totalValue).toBe(40000); // cold's £300 excluded
  });
});
