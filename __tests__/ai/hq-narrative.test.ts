import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * HQ board narratives — the shared governed generator (server/services/hq-narrative.ts).
 *
 * Ten super-admin boardroom surfaces each want a short prose blurb ABOVE a
 * deterministic board. This module is the ONE governed door they all reach a
 * model through. This suite pins the trust boundary in behaviour:
 *
 *   • FAIL-CLOSED, every leg: no provider (dark), unsupported vendor, no HQ
 *     budget org, a governor block, a governor duplicate, a provider throw, and an
 *     empty generation ALL return `null` — the deterministic-only board.
 *   • GOVERNED: the model is reached ONLY through `invokeWithGovernor`, under the
 *     board's OWN registered feature key, as task class `drafting`, at temperature
 *     0, and the return value is the model's prose.
 *   • ORG ISOLATION: organisation/tenant identifiers are stripped before the
 *     prompt is built, so none reaches the model.
 *
 * Every edge — the provider factory, the governor, and HQ budget attribution — is
 * MOCKED, so no model, no network, and no Supabase client is ever touched.
 */

const { getTextProviderMock, generateMock, invokeMock, hqBudgetOrgIdMock } = vi.hoisted(() => ({
  getTextProviderMock: vi.fn(),
  generateMock: vi.fn(),
  invokeMock: vi.fn(),
  hqBudgetOrgIdMock: vi.fn(),
}));

vi.mock("@/lib/ai/text", () => ({
  getTextProvider: getTextProviderMock,
  textCostUsd: () => 0.00042,
}));
vi.mock("@/lib/ai/governor", () => ({
  invokeWithGovernor: invokeMock,
  // The service gates on its OWN tier (`mid`, the `drafting` class) before
  // resolving a provider; stub it armed so the governed path is exercised. The
  // no-provider / dark legs are driven by getTextProviderMock returning null.
  isTierActivated: () => true,
}));
vi.mock("@/lib/ai/governor/attribution", () => ({
  hqBudgetOrgId: hqBudgetOrgIdMock,
}));

import { generateHqBoardNarrative } from "@/server/services/hq-narrative";
import { AI_FEATURES, featureDefinition } from "@/lib/ai/governor/registry";

/** The ten HQ board-narrative feature keys this module fans out over. */
const HQ_NARRATIVE_KEYS = [
  "hq.finance_narrative",
  "hq.cto_narrative",
  "hq.operations_narrative",
  "hq.marketing_narrative",
  "hq.product_narrative",
  "hq.customer_success_narrative",
  "hq.qa_narrative",
  "hq.executive_assistant_narrative",
  "hq.sales_orchestrator_narrative",
  "hq.support_ai_narrative",
] as const;

function fakeProvider(provider = "anthropic", model = "claude-haiku-4-5") {
  return { info: { provider, model }, generate: generateMock };
}

/** A representative board carrying a nested org identifier the aggregator would strip. */
const BOARD = {
  org_id: "ORG-SECRET-9a1f",
  headline: { activeCustomers: 12, mrrGbp: 6000 },
  nested: [{ orgId: "ORG-SECRET-9a1f", value: 3 }],
  runway: "insufficient",
};

/** Make the governor ALLOW and actually run the caller's fn (so the provider is exercised). */
function governorAllows() {
  invokeMock.mockImplementation(async (_feature, _taskClass, fn) => {
    const call = await fn();
    return { status: "ran", value: call.value, budget: "allowed", recorded: true, dark: false };
  });
}

beforeEach(() => {
  getTextProviderMock.mockReset();
  generateMock.mockReset();
  invokeMock.mockReset();
  hqBudgetOrgIdMock.mockReset();
  hqBudgetOrgIdMock.mockReturnValue("HQ-ORG-1");
});

// ---------------------------------------------------------------------
// The registry — every board key is present and correctly classed
// ---------------------------------------------------------------------

describe("HQ narrative feature keys are registered as drafting, with honest prose", () => {
  it("registers all ten board keys under task class 'drafting'", () => {
    for (const key of HQ_NARRATIVE_KEYS) {
      const def = featureDefinition(key);
      expect(def, `${key} must be registered`).not.toBeNull();
      expect(def!.taskClass, `${key} task class`).toBe("drafting");
      // degradesTo is prose for reviewers; an empty one is an unconsidered entry.
      expect(def!.degradesTo.length).toBeGreaterThan(20);
    }
  });

  it("keeps HQ attribution distinct from the tenant insights.narrative key", () => {
    expect(featureDefinition("insights.narrative")).not.toBeNull();
    for (const key of HQ_NARRATIVE_KEYS) {
      expect(key).not.toBe("insights.narrative");
      expect(AI_FEATURES[key].key).toBe(key);
    }
  });
});

// ---------------------------------------------------------------------
// Fail-closed — every degraded leg returns null
// ---------------------------------------------------------------------

describe("generateHqBoardNarrative — fails closed to null on every degraded leg", () => {
  it("returns null when no provider is configured (dark / no tier bound)", async () => {
    getTextProviderMock.mockReturnValue(null);
    const out = await generateHqBoardNarrative("hq.finance_narrative", BOARD);
    expect(out).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("returns null for an unsupported provider vendor", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider("acme", "mystery-llm"));
    const out = await generateHqBoardNarrative("hq.cto_narrative", BOARD);
    expect(out).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns null when no HQ budget org is configured (fail-closed attribution)", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider());
    hqBudgetOrgIdMock.mockReturnValue(null);
    const out = await generateHqBoardNarrative("hq.operations_narrative", BOARD);
    expect(out).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns null when the governor BLOCKS (over ceiling / reservation unavailable)", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider());
    invokeMock.mockResolvedValue({
      status: "blocked",
      budget: "blocked",
      spentPence: 10000,
      ceilingPence: 10000,
      reason: "ceiling",
    });
    const out = await generateHqBoardNarrative("hq.qa_narrative", BOARD);
    expect(out).toBeNull();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("returns null when the governor refuses a DUPLICATE", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider());
    invokeMock.mockResolvedValue({
      status: "duplicate",
      contentHash: "abc",
      reason: "recent_success",
    });
    const out = await generateHqBoardNarrative("hq.marketing_narrative", BOARD);
    expect(out).toBeNull();
  });

  it("returns null when the provider throws (never throws to the caller)", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider());
    governorAllows();
    generateMock.mockRejectedValue(new Error("429 Too Many Requests"));
    await expect(
      generateHqBoardNarrative("hq.product_narrative", BOARD),
    ).resolves.toBeNull();
  });

  it("returns null on an empty / whitespace-only generation", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider());
    governorAllows();
    generateMock.mockResolvedValue({
      text: "   \n  ",
      model: "claude-haiku-4-5",
      inputTokens: 20,
      outputTokens: 0,
    });
    await expect(
      generateHqBoardNarrative("hq.support_ai_narrative", BOARD),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------
// Happy path — governed, temperature 0, right key, org-stripped prompt
// ---------------------------------------------------------------------

describe("generateHqBoardNarrative — governed happy path", () => {
  beforeEach(() => {
    getTextProviderMock.mockReturnValue(fakeProvider());
    governorAllows();
    generateMock.mockResolvedValue({
      text: "  Twelve active customers and steady recurring revenue; runway is unknown.  ",
      model: "claude-haiku-4-5",
      inputTokens: 300,
      outputTokens: 40,
    });
  });

  it("returns the trimmed model prose when the governor permits", async () => {
    const out = await generateHqBoardNarrative("hq.finance_narrative", BOARD);
    expect(out).toBe("Twelve active customers and steady recurring revenue; runway is unknown.");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("invokes the governor with the board's OWN feature key and the 'drafting' class", async () => {
    await generateHqBoardNarrative("hq.finance_narrative", BOARD);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [feature, taskClass, fn, input] = invokeMock.mock.calls[0]!;
    expect(feature).toBe("hq.finance_narrative");
    expect(taskClass).toBe("drafting");
    expect(typeof fn).toBe("function");
    // Billed to the HQ budget org, as a system-initiated call.
    expect(input.orgId).toBe("HQ-ORG-1");
    expect(input.userId).toBeNull();
  });

  it("runs at temperature 0 with a bounded token cap and the strict guardrail system prompt", async () => {
    await generateHqBoardNarrative("hq.finance_narrative", BOARD);
    const [, opts] = generateMock.mock.calls[0]!;
    expect(opts.temperature).toBe(0);
    expect(opts.maxTokens).toBeGreaterThan(0);
    expect(opts.system).toMatch(/Do NOT invent/);
    expect(opts.system).toMatch(/Do NOT recommend/);
    expect(opts.system).toMatch(/Do NOT state any business fact/);
  });

  it("strips organisation/tenant identifiers before the board reaches the model", async () => {
    await generateHqBoardNarrative("hq.finance_narrative", BOARD);
    const [prompt] = generateMock.mock.calls[0]!;
    expect(prompt).not.toContain("ORG-SECRET-9a1f");
    expect(prompt).not.toContain("org_id");
    expect(prompt).not.toContain("orgId");
    // The real figures are still present — the narration has something to describe.
    expect(prompt).toContain("activeCustomers");
    expect(prompt).toContain("insufficient");
  });

  it("each of the ten boards routes through the governor under its own key", async () => {
    for (const key of HQ_NARRATIVE_KEYS) {
      invokeMock.mockClear();
      generateMock.mockClear();
      const out = await generateHqBoardNarrative(key, BOARD);
      expect(out, `${key} should return prose on allow`).not.toBeNull();
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock.mock.calls[0]![0], `${key} feature key`).toBe(key);
      expect(invokeMock.mock.calls[0]![1], `${key} task class`).toBe("drafting");
    }
  });
});
