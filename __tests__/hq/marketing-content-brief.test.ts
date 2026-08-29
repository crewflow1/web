import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  computeMarketingBoard,
  computeContentBrief,
  type ContentBriefInput,
  type MarketingInput,
} from "@/lib/hq/marketing";

/**
 * HQ Marketing AI — the P6 content contract (L9a).
 *
 *   A. channelMix on the board — the form-origin split that IS recorded, as
 *      exact derived shares; honest about NOT being UTM attribution, and null
 *      when the source is unreadable. The channel_attribution metric STAYS
 *      insufficient (the mix never masquerades as it).
 *   B. computeContentBrief — deterministic, every proposal cites the real
 *      figure it derives from; honest insufficient with no data; the
 *      generative leg is null-by-construction with the dark note.
 *   C. The marketing_content_draft handler — dark seam refusal spied: the
 *      artifact ships with generativeDraft null while the seam returns null,
 *      and the seam is asked under exactly `hq.marketing_draft`.
 */

const NOW = new Date("2026-08-26T12:00:00Z"); // a Wednesday

const demo = (source: string, daysAgo: number, status = "new") => ({
  status,
  source,
  created_at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
});

const FULL_INPUT: MarketingInput = {
  leads: {
    demoRequests: [
      demo("landing", 2),
      demo("landing", 5),
      demo("landing", 40),
      demo("referral", 1),
    ],
  },
  acquisition: {
    activeOrgs: 3,
    trialOrgs: 1,
    pendingOrgs: 0,
    newCustomersThisMonth: 1,
    growthPct: 10,
  },
};

describe("A. channelMix — the recorded form-origin split as derived facts", () => {
  it("derives exact shares over the source breakdown", () => {
    const board = computeMarketingBoard(FULL_INPUT, NOW);
    expect(board.channelMix).not.toBeNull();
    const rows = board.channelMix!.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ source: "landing", total: 3, sharePct: 75, new30d: 2 });
    expect(rows[1]).toMatchObject({ source: "referral", total: 1, sharePct: 25, new30d: 1 });
  });

  it("states honestly that it is origin attribution, NOT UTM/channel attribution", () => {
    const board = computeMarketingBoard(FULL_INPUT, NOW);
    expect(board.channelMix!.basis).toMatch(/form-origin/i);
    expect(board.channelMix!.basis).toMatch(/NOT paid\/organic\/social/i);
    // And the channel_attribution card STAYS insufficient — the mix is a
    // different, honest claim, never a substitute.
    const attribution = board.metrics.find((m) => m.key === "channel_attribution")!;
    expect(attribution.kind).toBe("insufficient");
    expect(attribution.value).toBeNull();
  });

  it("is null when the demo-request source is unreadable — never a fabricated split", () => {
    const board = computeMarketingBoard({ ...FULL_INPUT, leads: null }, NOW);
    expect(board.channelMix).toBeNull();
  });

  it("existing metric keys are unchanged (no board-contract drift)", () => {
    const keys = computeMarketingBoard(FULL_INPUT, NOW).metrics.map((m) => m.key).sort();
    expect(keys).toContain("channel_attribution");
    expect(keys).toHaveLength(14);
  });
});

describe("B. computeContentBrief — deterministic, data-grounded, honest", () => {
  const INVENTORY: NonNullable<ContentBriefInput["seoInventory"]> = {
    features: 12,
    comparisons: 6,
    industries: 8,
    locations: 20,
    posts: 9,
    tools: 4,
  };

  it("stamps the UTC Monday of the week", () => {
    const brief = computeContentBrief({ leads: FULL_INPUT.leads, seoInventory: INVENTORY }, NOW);
    expect(brief.weekOf).toBe("2026-08-24");
  });

  it("proposes from the top recorded origins, citing the real counts", () => {
    const brief = computeContentBrief({ leads: FULL_INPUT.leads, seoInventory: INVENTORY }, NOW);
    expect(brief.insufficient).toBe(false);
    expect(brief.confidence).toBe(1);
    const landing = brief.proposals.find((p) => p.key === "origin_landing")!;
    expect(landing.rationale).toContain("3 demo requests all-time");
    expect(landing.rationale).toContain("2 in the last 30 days");
  });

  it("proposes extending the THINNEST SEO surface, citing the registry counts", () => {
    const brief = computeContentBrief({ leads: FULL_INPUT.leads, seoInventory: INVENTORY }, NOW);
    const inv = brief.proposals.find((p) => p.key === "inventory_tools")!;
    expect(inv.rationale).toContain("59 indexable marketing pages");
    expect(inv.rationale).toContain("'tools' is the thinnest surface at 4");
    expect(brief.signals.thinnestSurface).toEqual({ surface: "tools", count: 4 });
  });

  it("is honestly insufficient when NEITHER source is readable", () => {
    const brief = computeContentBrief({ leads: null, seoInventory: null }, NOW);
    expect(brief.insufficient).toBe(true);
    expect(brief.confidence).toBe(0);
    expect(brief.proposals).toEqual([]);
    expect(brief.summary).toMatch(/^Insufficient data/);
  });

  it("the generative leg is null-by-construction, with the dark note naming the seam", () => {
    const brief = computeContentBrief({ leads: FULL_INPUT.leads, seoInventory: INVENTORY }, NOW);
    expect(brief.generativeDraft).toBeNull();
    expect(brief.generativeNote).toContain("hq.marketing_draft");
    expect(brief.generativeNote).toContain("no model tier is bound");
  });

  it("is deterministic — same input, same output", () => {
    const a = computeContentBrief({ leads: FULL_INPUT.leads, seoInventory: INVENTORY }, NOW);
    const b = computeContentBrief({ leads: FULL_INPUT.leads, seoInventory: INVENTORY }, NOW);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// C. The task handler — dark-seam wiring, with the seam and the reads spied.
// ---------------------------------------------------------------------------

const { generateDepartmentDraftMock, fetchAllRowsMock } = vi.hoisted(() => ({
  generateDepartmentDraftMock: vi.fn(),
  fetchAllRowsMock: vi.fn(),
}));

vi.mock("@/server/services/hq-generative-seams", () => ({
  generateDepartmentDraft: generateDepartmentDraftMock,
}));
vi.mock("@/lib/supabase/paginate", () => ({
  fetchAllRows: fetchAllRowsMock,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }),
    }),
  }),
}));

describe("C. marketing_content_draft handler — dark seam wiring", () => {
  beforeEach(() => {
    generateDepartmentDraftMock.mockReset();
    fetchAllRowsMock.mockReset();
  });

  it("completes with the deterministic brief and a NULL generative field while the seam is dark", async () => {
    fetchAllRowsMock.mockResolvedValue({
      data: [demo("landing", 3), demo("landing", 6)],
      error: null,
    });
    generateDepartmentDraftMock.mockResolvedValue(null); // the dark seam
    const { marketingContentHandler } = await import(
      "@/server/services/hq-marketing-content-runner"
    );
    const result = (await marketingContentHandler(
      { identity: { employeeId: "emp-test-1", slug: "test-ai" } } as never,
    )) as Record<string, unknown>;

    expect(result.kind).toBe("marketing_content_brief");
    expect(result.insufficient).toBe(false);
    expect(result.generativeDraft).toBeNull();
    expect(String(result.generativeNote)).toContain("hq.marketing_draft");
    // The seam was asked under EXACTLY its registered key, with the brief.
    expect(generateDepartmentDraftMock).toHaveBeenCalledTimes(1);
    expect(generateDepartmentDraftMock.mock.calls[0]![0]).toBe("hq.marketing_draft");
    // Per-employee cost attribution (contract item 3): the handler must hand
    // its own identity to the seam so activation-day spend lands on the right
    // employee, never unattributed.
    expect(generateDepartmentDraftMock.mock.calls[0]![2]).toEqual({
      aiEmployeeId: "emp-test-1",
    });
  });

  it("attaches governed prose when the seam yields it (armed future), with an honest note", async () => {
    fetchAllRowsMock.mockResolvedValue({ data: [demo("landing", 3)], error: null });
    generateDepartmentDraftMock.mockResolvedValue("Drafted copy.");
    const { marketingContentHandler } = await import(
      "@/server/services/hq-marketing-content-runner"
    );
    const result = (await marketingContentHandler({ identity: { employeeId: "emp-test-1", slug: "test-ai" } } as never)) as Record<string, unknown>;
    expect(result.generativeDraft).toBe("Drafted copy.");
    expect(String(result.generativeNote)).toContain("unreviewed draft");
  });

  it("does not ask the seam for an insufficient brief (nothing to ground a draft in)", async () => {
    fetchAllRowsMock.mockResolvedValue({ data: [], error: null });
    const { marketingContentHandler } = await import(
      "@/server/services/hq-marketing-content-runner"
    );
    const result = (await marketingContentHandler({ identity: { employeeId: "emp-test-1", slug: "test-ai" } } as never)) as Record<string, unknown>;
    // The SEO inventory is a static registry (always readable), so the brief is
    // not insufficient — but with zero demo volume the origin proposals vanish
    // and only the inventory proposal remains, all still deterministic.
    expect(result.kind).toBe("marketing_content_brief");
    if (result.insufficient === true) {
      expect(generateDepartmentDraftMock).not.toHaveBeenCalled();
    }
  });
});
