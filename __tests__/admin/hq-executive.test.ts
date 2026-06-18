import { describe, it, expect } from "vitest";
import { emptyStatusCounts, emptyTaskStatusCounts } from "@/lib/sales/model";
import {
  arrFromMrr,
  assembleExecutiveSections,
  demoRate,
  formatExec,
  formatGbpCompact,
  replyRate,
  trend,
  type ExecutiveInput,
} from "@/lib/hq/executive";

/**
 * CrewFlow HQ — Executive Command Centre pure-logic tests
 * (CEO Directive 004, Phase 2).
 *
 * The control centre's entire card layout is assembled from a plain
 * `ExecutiveInput` by `assembleExecutiveSections`, so these tests pin the
 * derivations (ARR, trend, reply/demo rates), the shared formatting
 * (count-up + SSR use the SAME `formatExec`), and the contract of the
 * directive's card set — six sections, ~27 cards, the WhatsApp channel
 * flagged as a foundation placeholder, real cards never flagged.
 */

function baseInput(over: Partial<ExecutiveInput> = {}): ExecutiveInput {
  return {
    mrrGbp: 0,
    mrrPrevGbp: 0,
    revenueThisMonthGbp: 0,
    revenuePrevMonthGbp: 0,
    activeCustomers: 0,
    trials: 0,
    newCustomersThisMonth: 0,
    customerGrowthPct: 0,
    pipelineValueGbp: 0,
    wonValueGbp: 0,
    totalCompanies: 0,
    bookedDemos: 0,
    activeDemos: 0,
    statusCounts: emptyStatusCounts(),
    coldCallsToday: 0,
    emailsSent30d: 0,
    linkedinMessages30d: 0,
    instagramMessages30d: 0,
    whatsappMessages30d: 0,
    aiTasks: emptyTaskStatusCounts(),
    companiesResearched: 0,
    companiesQualified: 0,
    companiesRejected: 0,
    companiesEnriched: 0,
    ...over,
  };
}

describe("executive — derivations", () => {
  it("arrFromMrr is MRR × 12, floored at zero", () => {
    expect(arrFromMrr(500)).toBe(6000);
    expect(arrFromMrr(0)).toBe(0);
    expect(arrFromMrr(-100)).toBe(0);
    expect(arrFromMrr(Number.NaN)).toBe(0);
  });

  it("trend reports signed direction + magnitude vs a baseline", () => {
    expect(trend(150, 100)).toEqual({ pct: 50, direction: "up" });
    expect(trend(80, 100)).toEqual({ pct: -20, direction: "down" });
    expect(trend(100, 100)).toEqual({ pct: 0, direction: "flat" });
  });

  it("trend treats growth from a zero baseline as +100% up, zero as flat", () => {
    expect(trend(10, 0)).toEqual({ pct: 100, direction: "up" });
    expect(trend(0, 0)).toEqual({ pct: 0, direction: "flat" });
  });

  it("reply + demo rates derive from the pipeline status counts", () => {
    const counts = {
      ...emptyStatusCounts(),
      contacted: 4, // contactedOrBeyond also includes the later stages
      replied: 3,
      demo_booked: 2,
      won: 1,
    };
    // contactedOrBeyond = 4+3+2+1 = 10; replied+ = 3+2+1 = 6; demo+ = 2+1 = 3.
    expect(replyRate(counts)).toBe(60);
    expect(demoRate(counts)).toBe(30);
  });

  it("rates are zero (never NaN) when nobody has been contacted", () => {
    expect(replyRate(emptyStatusCounts())).toBe(0);
    expect(demoRate(emptyStatusCounts())).toBe(0);
  });
});

describe("executive — formatting (shared by SSR + the client counter)", () => {
  it("formats GBP compactly above £100k / £1M, full below", () => {
    expect(formatGbpCompact(0)).toBe("£0");
    expect(formatGbpCompact(6000)).toBe("£6,000");
    expect(formatGbpCompact(120_000)).toBe("£120k");
    expect(formatGbpCompact(1_800_000)).toBe("£1.8M");
  });

  it("formatExec routes by token and rounds mid-animation values", () => {
    expect(formatExec(1234.7, "int")).toBe("1,235");
    expect(formatExec(12.54, "pct")).toBe("12.5%");
    expect(formatExec(500, "gbp")).toBe("£500");
  });
});

describe("executive — section assembly contract", () => {
  it("builds the six directive sections in order", () => {
    const sections = assembleExecutiveSections(baseInput());
    expect(sections.map((s) => s.key)).toEqual([
      "revenue",
      "pipeline",
      "rates",
      "outreach",
      "ai",
      "research",
    ]);
  });

  it("exposes ~27 cards with unique keys", () => {
    const cards = assembleExecutiveSections(baseInput()).flatMap((s) => s.cards);
    expect(cards.length).toBe(27);
    expect(new Set(cards.map((c) => c.key)).size).toBe(cards.length);
  });

  it("flags ONLY WhatsApp as a foundation placeholder (no live source)", () => {
    const cards = assembleExecutiveSections(baseInput()).flatMap((s) => s.cards);
    const foundation = cards.filter((c) => c.foundation);
    expect(foundation.map((c) => c.key)).toEqual(["whatsapp"]);
  });

  it("surfaces real figures on the headline revenue + pipeline cards", () => {
    const sections = assembleExecutiveSections(
      baseInput({
        mrrGbp: 500,
        pipelineValueGbp: 6000,
        totalCompanies: 12,
        aiTasks: { ...emptyTaskStatusCounts(), running: 2, failed: 1 },
      }),
    );
    const byKey = new Map(
      sections.flatMap((s) => s.cards).map((c) => [c.key, c]),
    );
    expect(byKey.get("mrr")?.value).toBe(500);
    expect(byKey.get("arr")?.value).toBe(6000);
    expect(byKey.get("pipeline_value")?.value).toBe(6000);
    expect(byKey.get("total_companies")?.value).toBe(12);
    expect(byKey.get("ai_running")?.value).toBe(2);
    expect(byKey.get("ai_failed")?.value).toBe(1);
  });
});
