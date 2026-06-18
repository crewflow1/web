import { describe, it, expect } from "vitest";
import { emptyStatusCounts, emptyTaskStatusCounts } from "@/lib/sales/model";
import {
  aiHealth,
  assembleCeoBoard,
  engineHealth,
  growthHealth,
  learningHealth,
  revenueHealth,
  supportHealth,
  type CeoInput,
} from "@/lib/hq/ceo";

/**
 * CrewFlow HQ — CEO Dashboard pure-logic tests (CEO Directive 004, Phase 8).
 *
 * The CEO board is assembled from a plain `CeoInput` by `assembleCeoBoard`,
 * so these tests pin the honest health rules (real departments report
 * direction; nascent AI functions report "foundation" until they log real
 * volume — never a faked green light), the headline figure each department
 * leads with, and the board contract: a five-card vitals band and the ten
 * departments in order.
 */

function baseInput(over: Partial<CeoInput> = {}): CeoInput {
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
    openSupportTickets: 0,
    aiEmployeesActive: 0,
    aiEmployeesTotal: 0,
    learningsTotal: 0,
    learningsActive: 0,
    learningsPromoted: 0,
    ...over,
  };
}

describe("ceo — health rules (honest by construction)", () => {
  it("revenue health reflects direction, foundation before any MRR", () => {
    expect(revenueHealth(0, { pct: 0, direction: "flat" }).tone).toBe(
      "foundation",
    );
    expect(revenueHealth(500, { pct: 12, direction: "up" })).toEqual({
      tone: "healthy",
      label: "Growing",
    });
    expect(revenueHealth(500, { pct: 0, direction: "flat" })).toEqual({
      tone: "healthy",
      label: "Stable",
    });
    expect(revenueHealth(500, { pct: -8, direction: "down" })).toEqual({
      tone: "attention",
      label: "Declining",
    });
  });

  it("growth health needs a paying base, then tracks the change", () => {
    expect(growthHealth(5, 0).tone).toBe("foundation");
    expect(growthHealth(5, 10)).toEqual({ tone: "healthy", label: "Growing" });
    expect(growthHealth(0, 10)).toEqual({ tone: "steady", label: "Holding" });
    expect(growthHealth(-3, 10)).toEqual({
      tone: "attention",
      label: "Contracting",
    });
  });

  it("support health: clear queue healthy, light steady, backlog attention", () => {
    expect(supportHealth(0)).toEqual({ tone: "healthy", label: "All clear" });
    expect(supportHealth(3)).toEqual({ tone: "steady", label: "Steady" });
    expect(supportHealth(11)).toEqual({ tone: "attention", label: "Backlog" });
  });

  it("engine health is foundation at zero volume, live once it logs work", () => {
    expect(engineHealth(0)).toEqual({ tone: "foundation", label: "Foundation" });
    expect(engineHealth(1)).toEqual({ tone: "healthy", label: "Live" });
  });

  it("ai health flags failing tasks, else needs an employed roster", () => {
    expect(aiHealth(11, 0)).toEqual({ tone: "healthy", label: "Operational" });
    expect(aiHealth(11, 2)).toEqual({
      tone: "attention",
      label: "Tasks failing",
    });
    expect(aiHealth(0, 0).tone).toBe("foundation");
  });

  it("learning health: live patterns healthy, drafts steady, empty foundation", () => {
    expect(learningHealth(6, 6)).toEqual({ tone: "healthy", label: "Learning" });
    expect(learningHealth(0, 3)).toEqual({
      tone: "steady",
      label: "Drafts only",
    });
    expect(learningHealth(0, 0).tone).toBe("foundation");
  });
});

describe("ceo — board contract", () => {
  it("leads with the five company vitals", () => {
    const board = assembleCeoBoard(baseInput());
    expect(board.vitals.map((v) => v.key)).toEqual([
      "mrr",
      "arr",
      "active_customers",
      "pipeline_value",
      "win_rate",
    ]);
  });

  it("renders the ten departments in order with unique keys", () => {
    const board = assembleCeoBoard(baseInput());
    expect(board.departments.map((d) => d.key)).toEqual([
      "finance",
      "customers",
      "pipeline",
      "sales",
      "marketing",
      "research",
      "ai",
      "learning",
      "support",
      "growth",
    ]);
    expect(new Set(board.departments.map((d) => d.key)).size).toBe(10);
  });

  it("every department carries a drill-in link and a health signal", () => {
    const board = assembleCeoBoard(baseInput());
    for (const d of board.departments) {
      expect(d.href.startsWith("/admin/")).toBe(true);
      expect(d.health.tone).toBeTruthy();
      expect(d.headline.label.length).toBeGreaterThan(0);
    }
  });
});

describe("ceo — headline + vitals figures", () => {
  const board = assembleCeoBoard(
    baseInput({
      mrrGbp: 500,
      mrrPrevGbp: 400,
      activeCustomers: 12,
      customerGrowthPct: 8,
      pipelineValueGbp: 6000,
      statusCounts: { ...emptyStatusCounts(), won: 2, lost: 1 },
      emailsSent30d: 40,
      linkedinMessages30d: 5,
      instagramMessages30d: 3,
      companiesResearched: 9,
      aiEmployeesActive: 11,
      aiEmployeesTotal: 12,
      aiTasks: { ...emptyTaskStatusCounts(), running: 2, failed: 1 },
      learningsTotal: 6,
      learningsActive: 6,
      learningsPromoted: 2,
      openSupportTickets: 4,
    }),
  );
  const dept = new Map(board.departments.map((d) => [d.key, d]));
  const vital = new Map(board.vitals.map((v) => [v.key, v]));

  it("derives ARR and win rate on the vitals band", () => {
    expect(vital.get("mrr")?.value).toBe(500);
    expect(vital.get("arr")?.value).toBe(6000); // 500 × 12
    expect(vital.get("pipeline_value")?.value).toBe(6000);
    // won 2 of 3 total companies → 66.7%.
    expect(vital.get("win_rate")?.value).toBe(66.7);
  });

  it("each department leads with its own headline figure", () => {
    expect(dept.get("finance")?.headline.value).toBe(500);
    expect(dept.get("customers")?.headline.value).toBe(12);
    expect(dept.get("pipeline")?.headline.value).toBe(6000);
    expect(dept.get("sales")?.headline.value).toBe(40);
    // marketing headline sums every social channel (5 + 3 + 0).
    expect(dept.get("marketing")?.headline.value).toBe(8);
    expect(dept.get("research")?.headline.value).toBe(9);
    expect(dept.get("ai")?.headline.value).toBe(11);
    expect(dept.get("learning")?.headline.value).toBe(6);
    expect(dept.get("support")?.headline.value).toBe(4);
    expect(dept.get("growth")?.headline.value).toBe(8);
  });

  it("reports live + attention health where the data earns it", () => {
    expect(dept.get("finance")?.health).toEqual({
      tone: "healthy",
      label: "Growing",
    });
    expect(dept.get("ai")?.health).toEqual({
      tone: "attention",
      label: "Tasks failing",
    });
    expect(dept.get("learning")?.health.tone).toBe("healthy");
    expect(dept.get("research")?.health.tone).toBe("healthy");
  });
});

describe("ceo — empty window is honest, never a false green", () => {
  const board = assembleCeoBoard(baseInput());
  const dept = new Map(board.departments.map((d) => [d.key, d]));

  it("nascent AI engines read foundation at zero", () => {
    for (const key of ["pipeline", "sales", "marketing", "research", "learning"]) {
      expect(dept.get(key)?.health.tone).toBe("foundation");
    }
  });

  it("an empty support queue is healthy, not foundation", () => {
    expect(dept.get("support")?.health).toEqual({
      tone: "healthy",
      label: "All clear",
    });
  });

  it("vitals collapse to zero without throwing", () => {
    const vital = new Map(board.vitals.map((v) => [v.key, v]));
    expect(vital.get("arr")?.value).toBe(0);
    expect(vital.get("win_rate")?.value).toBe(0);
  });
});
