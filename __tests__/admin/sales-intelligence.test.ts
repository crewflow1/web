import { describe, it, expect } from "vitest";
import {
  buildIntelligenceProfile,
  computeLikelihoodToBuy,
  computeRelationshipScore,
  intelligenceCompleteness,
  relationshipBand,
} from "@/lib/sales/intelligence";
import type { SalesCompany, SalesTimelineEvent } from "@/lib/sales/model";

/**
 * CrewFlow HQ — AI Company Intelligence derived-signal tests
 * (CEO Directive 004, Phase 4).
 *
 * The company detail page renders the relationship score, the
 * likelihood-to-buy composite, its reasoning factors, and the profile
 * completeness entirely from these pure functions, so the tests pin the
 * directive's derived intelligence fields: nothing is invented, a missing
 * signal drops out of the blend, and a company with no contact history
 * scores null rather than zero.
 */

// Fixed "now" so the recency maths are deterministic across machines.
const NOW = "2026-06-17T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function company(over: Partial<SalesCompany> = {}): SalesCompany {
  return {
    id: "c1",
    name: "Acme Construction",
    summary: "",
    website: null,
    domain: null,
    industry: null,
    employee_count: null,
    annual_turnover_gbp: null,
    location: null,
    region: null,
    county: null,
    country: "United Kingdom",
    primary_email: null,
    primary_phone: null,
    linkedin_url: null,
    instagram_url: null,
    facebook_url: null,
    companies_house_url: null,
    companies_house_number: null,
    website_technology: [],
    crm_score: null,
    ai_qualification_score: null,
    estimated_deal_value_gbp: null,
    status: "new",
    source: "manual",
    assigned_to_email: null,
    tags: [],
    last_researched_at: null,
    revenue_estimate_gbp: null,
    growth_score: null,
    construction_sector: null,
    software_used: [],
    estimated_software_spend_gbp: null,
    fleet_size: null,
    staff_size: null,
    website_quality_score: null,
    marketing_quality_score: null,
    hiring_activity_score: null,
    digital_maturity_score: null,
    enrichment: null,
    created_by_id: null,
    created_by_email: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function event(over: Partial<SalesTimelineEvent> = {}): SalesTimelineEvent {
  return {
    id: Math.random().toString(36).slice(2),
    company_id: "c1",
    contact_id: null,
    event_type: "email",
    direction: "outbound",
    subject: null,
    body: "",
    outcome: null,
    occurred_at: NOW,
    actor_email: "rep@crewflow.uk",
    ai_employee_id: null,
    source: "manual",
    metadata: null,
    memory_id: null,
    created_at: NOW,
    ...over,
  };
}

describe("intelligence — computeRelationshipScore", () => {
  it("reads strength from real communication touches", () => {
    const timeline: SalesTimelineEvent[] = [
      // Internal/lifecycle noise — must NOT count as a touch.
      event({ event_type: "note", direction: "internal" }),
      event({ event_type: "created", direction: "internal" }),
      event({ event_type: "scored", direction: "internal" }),
      // Two outbound emails + one inbound reply (most recent, 2 days ago).
      event({ event_type: "email", direction: "outbound", occurred_at: "2026-06-10T09:00:00.000Z" }),
      event({ event_type: "email", direction: "outbound", occurred_at: "2026-06-12T09:00:00.000Z" }),
      event({ event_type: "email", direction: "inbound", occurred_at: "2026-06-15T12:00:00.000Z" }),
    ];
    const rel = computeRelationshipScore(timeline, { nowMs: NOW_MS });
    // 40 recency (2d) + 8 frequency (3 touches) + 10 two-way (1 inbound) + 0 depth.
    expect(rel.score).toBe(58);
    expect(rel.band).toBe("engaged");
    expect(rel.touches).toBe(3);
    expect(rel.inbound).toBe(1);
    expect(rel.outbound).toBe(2);
    expect(rel.twoWay).toBe(true);
    expect(rel.daysSinceLastTouch).toBe(2);
    expect(rel.lastTouchAt).toBe("2026-06-15T12:00:00.000Z");
  });

  it("returns a null score (not zero) when there has been no contact", () => {
    const rel = computeRelationshipScore(
      [event({ event_type: "note", direction: "internal" })],
      { nowMs: NOW_MS },
    );
    expect(rel.score).toBeNull();
    expect(rel.band).toBe("none");
    expect(rel.touches).toBe(0);
    expect(rel.twoWay).toBe(false);
  });

  it("rewards depth (a completed demo) and recency", () => {
    const rel = computeRelationshipScore(
      [
        event({ event_type: "call", direction: "outbound", occurred_at: "2026-06-16T09:00:00.000Z" }),
        event({ event_type: "demo_completed", direction: "outbound", occurred_at: "2026-06-17T09:00:00.000Z" }),
      ],
      { nowMs: NOW_MS },
    );
    // 40 recency (<1d) + 5 frequency (2) + 0 two-way + 10 depth (2 deep) = 55.
    expect(rel.score).toBe(55);
    expect(relationshipBand(rel.score)).toBe("engaged");
  });
});

describe("intelligence — computeLikelihoodToBuy", () => {
  it("blends the present signals into one explainable composite", () => {
    const c = company({
      ai_qualification_score: 72,
      growth_score: 60,
      digital_maturity_score: 40,
      status: "contacted",
    });
    const likely = computeLikelihoodToBuy(c, 58);
    // 0.34·72 + 0.22·50 + 0.22·58 + 0.22·60 = 61.44 → 61.
    expect(likely.score).toBe(61);
    expect(likely.band).toBe("high");
    expect(likely.factors).toHaveLength(4);

    const qualification = likely.factors.find((f) => f.key === "qualification");
    expect(qualification?.tone).toBe("positive");
    const enrichment = likely.factors.find((f) => f.key === "enrichment");
    expect(enrichment?.value).toBe(50); // mean of growth 60 + digital 40
    const momentum = likely.factors.find((f) => f.key === "momentum");
    expect(momentum?.value).toBe(60); // "contacted"
  });

  it("falls back to pipeline momentum alone for an un-enriched lead", () => {
    const likely = computeLikelihoodToBuy(company({ status: "new" }), null);
    expect(likely.score).toBe(30); // momentum-only
    expect(likely.band).toBe("low");
    expect(likely.factors).toHaveLength(1);
    expect(likely.factors[0]?.key).toBe("momentum");
  });

  it("marks a disqualified company's momentum as a negative factor", () => {
    const likely = computeLikelihoodToBuy(company({ status: "disqualified" }), null);
    expect(likely.score).toBe(0);
    expect(likely.factors[0]?.tone).toBe("negative");
  });
});

describe("intelligence — intelligenceCompleteness", () => {
  it("measures how much of the profile is actually enriched", () => {
    const c = company({
      industry: "Construction",
      employee_count: 50,
      website: "https://acme.example",
      primary_email: "hello@acme.example",
      ai_qualification_score: 72,
      growth_score: 60,
      digital_maturity_score: 40,
    });
    const done = intelligenceCompleteness(c);
    expect(done.total).toBe(19);
    expect(done.present).toBe(7);
    expect(done.pct).toBe(37); // round(7 / 19 * 100)
    expect(done.missing).toContain("Fleet size");
  });

  it("reports an empty profile as zero coverage", () => {
    const done = intelligenceCompleteness(company());
    expect(done.present).toBe(0);
    expect(done.pct).toBe(0);
    expect(done.missing).toHaveLength(19);
  });
});

describe("intelligence — buildIntelligenceProfile", () => {
  it("assembles relationship, likelihood and completeness in one pass", () => {
    const c = company({
      ai_qualification_score: 72,
      growth_score: 60,
      digital_maturity_score: 40,
      status: "contacted",
    });
    const timeline: SalesTimelineEvent[] = [
      event({ event_type: "email", direction: "outbound", occurred_at: "2026-06-10T09:00:00.000Z" }),
      event({ event_type: "email", direction: "outbound", occurred_at: "2026-06-12T09:00:00.000Z" }),
      event({ event_type: "email", direction: "inbound", occurred_at: "2026-06-15T12:00:00.000Z" }),
    ];
    const profile = buildIntelligenceProfile({ company: c, timeline, nowMs: NOW_MS });
    expect(profile.relationship.score).toBe(58);
    // Likelihood consumes the derived relationship score (58) as engagement.
    expect(profile.likelihood.score).toBe(61);
    expect(profile.likelihood.band).toBe("high");
    expect(profile.completeness.total).toBe(19);
  });
});
