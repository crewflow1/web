import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * P11 — Product AI genuinely PROPOSES to the Decision Centre.
 *
 * The product board already reads real demand (feature_request / support
 * tickets, category-grouped). The `product_proposal` path converts its TOP
 * demand themes into DRAFT hq_decisions proposals via the existing
 * decision-autoproposal machinery. Pinned:
 *
 *   1. THE PURE MAPPER (mapDemandThemesToProposals): deterministic thresholds
 *      (≥ PROPOSAL_MIN_OPEN_TICKETS open, top PROPOSAL_MAX_THEMES), a stable
 *      idempotency key per category, in-batch dedupe, and EVIDENCE in every
 *      field — the deterministic scoring rationale (open/total/share) written
 *      into the proposal itself. Revenue impact is HONEST: no source, stated.
 *   2. THE SWEEP: seeded feature-request rows → a draft decision is opened
 *      through openDeterministicProposal (the ONE decisions authority) with
 *      those evidence fields; `exists` outcomes count as idempotent skips;
 *      an unreadable demand source is an honest empty sweep, never a guess.
 */

const { openMock, ticketsMock } = vi.hoisted(() => ({
  openMock: vi.fn(),
  ticketsMock: vi.fn(),
}));

// The two board readers hq-product folds (analytics degraded → adoption null).
vi.mock("@/server/services/hq-support-snapshot", () => ({
  listFeatureSignalRowsForHq: ticketsMock,
}));
vi.mock("@/server/services/hq-analytics-snapshot", () => ({
  buildAnalyticsSnapshot: async () => null,
}));
// The ONE decisions authority — spied, never a real DB.
vi.mock("@/server/services/hq-decisions", () => ({
  openDeterministicProposal: openMock,
}));
// Import-safety: the narrative helper pulls the provider door + governor, the
// SDK pulls the memory facet/embeddings, auth pulls next/navigation.
vi.mock("@/server/services/hq-narrative", () => ({
  generateHqBoardNarrative: async () => null,
}));
vi.mock("@/lib/ai/embeddings", () => ({ getEmbeddingProvider: vi.fn() }));
vi.mock("@/server/auth/hq", () => ({ requireHqPage: vi.fn() }));

import {
  mapDemandThemesToProposals,
  PROPOSAL_MIN_OPEN_TICKETS,
  PROPOSAL_MAX_THEMES,
  type ProductTheme,
} from "@/lib/hq/product";
import { sweepProductDemandProposals } from "@/server/services/hq-product";

function theme(over: Partial<ProductTheme> = {}): ProductTheme {
  return { category: "feature_request", label: "Feature request", total: 10, open: 5, ...over };
}

beforeEach(() => {
  openMock.mockReset();
  ticketsMock.mockReset();
});

describe("mapDemandThemesToProposals — pure, deterministic, evidence-bearing", () => {
  it("maps a qualifying theme with the deterministic rationale in every field", () => {
    const [p] = mapDemandThemesToProposals([theme()], 20);
    expect(p).toBeDefined();
    expect(p!.title).toBe("Customer demand: Feature request");
    expect(p!.problem).toMatch(/5 open tickets \(of 10 all-time\)/);
    expect(p!.problem).toMatch(/open=5, total=10, share=50%/); // the scoring rationale
    expect(p!.demand).toMatch(/5 open \/ 10 total/);
    expect(p!.revenueImpact).toMatch(/No revenue-attribution source exists/); // honest
    expect(p!.recommendation).toMatch(/build \/ defer \/ decline/);
    expect(p!.sourceSignalKey).toBe("product_demand:feature_request");
  });

  it("applies the open-ticket floor: below PROPOSAL_MIN_OPEN_TICKETS no proposal", () => {
    const themes = [theme({ open: PROPOSAL_MIN_OPEN_TICKETS - 1 })];
    expect(mapDemandThemesToProposals(themes, 10)).toEqual([]);
    const at = mapDemandThemesToProposals([theme({ open: PROPOSAL_MIN_OPEN_TICKETS })], 10);
    expect(at).toHaveLength(1);
  });

  it("caps at the top PROPOSAL_MAX_THEMES themes and dedupes by category", () => {
    const themes = [
      theme({ category: "a", label: "A", open: 9 }),
      theme({ category: "a", label: "A dup", open: 9 }),
      theme({ category: "b", label: "B", open: 8 }),
      theme({ category: "c", label: "C", open: 7 }),
      theme({ category: "d", label: "D", open: 6 }),
    ];
    const out = mapDemandThemesToProposals(themes, 50);
    expect(out).toHaveLength(PROPOSAL_MAX_THEMES);
    expect(out.map((p) => p.sourceSignalKey)).toEqual([
      "product_demand:a",
      "product_demand:b",
      "product_demand:c",
    ]);
  });

  it("same themes in → identical proposals out (pure)", () => {
    const themes = [theme(), theme({ category: "bug", label: "Bug report", open: 4, total: 6 })];
    expect(mapDemandThemesToProposals(themes, 16)).toEqual(
      mapDemandThemesToProposals(themes, 16),
    );
  });
});

describe("sweepProductDemandProposals — seeded demand rows open a DRAFT decision", () => {
  it("seeded feature-request rows → openDeterministicProposal called with evidence fields", async () => {
    // Four open feature requests + one closed bug: one qualifying theme.
    const now = new Date().toISOString();
    ticketsMock.mockResolvedValue([
      { category: "feature_request", status: "open", created_at: now },
      { category: "feature_request", status: "open", created_at: now },
      { category: "feature_request", status: "in_progress", created_at: now },
      { category: "feature_request", status: "open", created_at: now },
      { category: "bug", status: "closed", created_at: now },
    ]);
    openMock.mockResolvedValue("created");

    const sweep = await sweepProductDemandProposals();

    expect(sweep.demandRead).toBe(true);
    expect(sweep.evaluated).toBe(1);
    expect(sweep.created).toBe(1);
    expect(sweep.errors).toBe(0);
    expect(openMock).toHaveBeenCalledTimes(1);
    const arg = openMock.mock.calls[0]![0];
    expect(arg.title).toMatch(/Customer demand/);
    expect(arg.sourceSignalKey).toBe("product_demand:feature_request");
    // The draft decision carries the deterministic evidence, not bare prose.
    expect(arg.problem).toMatch(/4 open tickets \(of 4 all-time\)/);
    expect(arg.demand).toMatch(/4 open \/ 4 total/);
    expect(arg.revenueImpact).toMatch(/No revenue-attribution source/);
    expect(sweep.proposals).toEqual([
      {
        sourceSignalKey: "product_demand:feature_request",
        title: arg.title,
        outcome: "created",
      },
    ]);
  });

  it("an existing proposal is an idempotent skip, never an error", async () => {
    const now = new Date().toISOString();
    ticketsMock.mockResolvedValue([
      { category: "feature_request", status: "open", created_at: now },
      { category: "feature_request", status: "open", created_at: now },
      { category: "feature_request", status: "open", created_at: now },
    ]);
    openMock.mockResolvedValue("exists");
    const sweep = await sweepProductDemandProposals();
    expect(sweep.created).toBe(0);
    expect(sweep.skipped_existing).toBe(1);
    expect(sweep.errors).toBe(0);
  });

  it("an unreadable demand source is an HONEST empty sweep — nothing proposed on a guess", async () => {
    ticketsMock.mockRejectedValue(new Error("read failed"));
    const sweep = await sweepProductDemandProposals();
    expect(sweep.demandRead).toBe(false);
    expect(sweep.evaluated).toBe(0);
    expect(openMock).not.toHaveBeenCalled();
  });

  it("below-floor demand proposes nothing", async () => {
    const now = new Date().toISOString();
    ticketsMock.mockResolvedValue([
      { category: "feature_request", status: "open", created_at: now },
    ]);
    const sweep = await sweepProductDemandProposals();
    expect(sweep.evaluated).toBe(0);
    expect(openMock).not.toHaveBeenCalled();
  });
});
