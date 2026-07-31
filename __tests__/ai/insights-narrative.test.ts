import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Tenant AI Insights activation (Vision 2030 AI-1) — the unit tier.
 *
 * The insights layer shipped a complete deterministic engine (`lib/ai/aggregates`)
 * whose `summary` prose slot was never filled: the tenant surfaces computed the
 * aggregates directly and the only code that called a model lived in two
 * zero-caller API routes via an ad-hoc `lib/ai/llm.ts` that reached a vendor SDK
 * directly and recorded no cost. This increment activates the narrative through
 * the SHARED provider abstraction and pins the trust boundary in source:
 *
 *   • NARRATE-ONLY: the model is handed finished deterministic facts and may only
 *     describe them — never invent a number, a recommendation, or business state.
 *     Its entire output is the prose `summary`; every displayed metric still comes
 *     from the aggregates, so a hallucination cannot change a fact.
 *   • ONE MODEL DOOR: generation reaches a model solely via
 *     `lib/ai/text::getTextProvider` — no vendor SDK — so cost accounting and
 *     graceful degradation are the same seam the rest of the platform uses.
 *   • ORG ISOLATION: `org_id` is stripped before the prompt is built.
 *   • GRACEFUL: no provider / unsupported vendor / throw / empty → null, and the
 *     deterministic UI is unchanged.
 *
 * The generator's two edges are the provider factory and the cost helper — both
 * MOCKED here so every leg is exercised without a model or a network.
 */

const { getTextProviderMock, generateMock, textCostMock } = vi.hoisted(() => ({
  getTextProviderMock: vi.fn(),
  generateMock: vi.fn(),
  textCostMock: vi.fn(),
}));

vi.mock("@/lib/ai/text", () => ({
  getTextProvider: getTextProviderMock,
  textCostUsd: textCostMock,
}));

import {
  generateInsightNarrative,
  INSIGHT_NARRATIVE_SYSTEM,
} from "@/lib/ai/insight-narrative";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

function fakeProvider(provider = "anthropic", model = "claude-haiku-4-5") {
  return { info: { provider, model }, generate: generateMock };
}

/** A representative activity payload — carries org_id, like the real aggregate. */
const PAYLOAD = {
  org_id: "ORG-SECRET-8f2c",
  window_days: 30,
  summary: null,
  cache: "disabled",
  key_metrics: { total_events: 42, quote_funnel: { sent: 5, accepted: 3 } },
};

/**
 * The budget-attribution actor the generator now requires.
 *
 * Deliberately the SAME org id the payload carries, so the org-isolation test
 * below proves BOTH things at once: the identifier is stripped from the payload
 * AND the one passed for attribution does not leak into the prompt either.
 */
const ACTOR = { orgId: "ORG-SECRET-8f2c", userId: null } as const;

beforeEach(() => {
  getTextProviderMock.mockReset();
  generateMock.mockReset();
  textCostMock.mockReset();
  textCostMock.mockReturnValue(0.00042);
});

// ---------------------------------------------------------------------
// Behavioural — every leg of the generator
// ---------------------------------------------------------------------

describe("generateInsightNarrative — narrate-only generation via the abstraction", () => {
  it("returns null when no provider is configured (feature off → deterministic-only)", async () => {
    getTextProviderMock.mockReturnValue(null);
    const out = await generateInsightNarrative("activity", PAYLOAD, ACTOR);
    expect(out).toBeNull();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("returns null for an unsupported provider vendor (never narrates from an unknown model)", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider("acme", "mystery-llm"));
    const out = await generateInsightNarrative("activity", PAYLOAD, ACTOR);
    expect(out).toBeNull();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("returns null when the provider throws (graceful degradation, never throws)", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider());
    generateMock.mockRejectedValue(new Error("rate limited"));
    await expect(generateInsightNarrative("activity", PAYLOAD, ACTOR)).resolves.toBeNull();
  });

  it("returns null on an empty or whitespace-only generation", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider());
    generateMock.mockResolvedValue({
      text: "   \n  ",
      model: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 0,
    });
    await expect(generateInsightNarrative("activity", PAYLOAD, ACTOR)).resolves.toBeNull();
  });

  it("happy path — returns trimmed prose, provider-truth tokens, and cost via textCostUsd", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider());
    generateMock.mockResolvedValue({
      text: "  Your quote pipeline is converting well this month.  ",
      model: "claude-haiku-4-5",
      inputTokens: 320,
      outputTokens: 48,
    });
    const out = await generateInsightNarrative("activity", PAYLOAD, ACTOR);
    expect(out).not.toBeNull();
    expect(out!.text).toBe("Your quote pipeline is converting well this month.");
    expect(out!.provider).toBe("anthropic");
    expect(out!.model).toBe("claude-haiku-4-5");
    expect(out!.inputTokens).toBe(320);
    expect(out!.outputTokens).toBe(48);
    // Cost comes from the shared pricing helper — not recomputed here.
    expect(textCostMock).toHaveBeenCalledWith(
      { provider: "anthropic", model: "claude-haiku-4-5" },
      expect.objectContaining({ inputTokens: 320, outputTokens: 48 }),
    );
    expect(out!.costUsd).toBe(0.00042);
    expect(typeof out!.latencyMs).toBe("number");
  });

  it("applies the fixed guardrail system prompt at temperature 0 with a bounded token cap", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider());
    generateMock.mockResolvedValue({
      text: "A quiet month.",
      model: "claude-haiku-4-5",
      inputTokens: 10,
      outputTokens: 4,
    });
    await generateInsightNarrative("activity", PAYLOAD, ACTOR);
    const [, opts] = generateMock.mock.calls[0]!;
    expect(opts.system).toBe(INSIGHT_NARRATIVE_SYSTEM);
    expect(opts.temperature).toBe(0);
    expect(opts.maxTokens).toBeGreaterThan(0);
  });

  it("strips org_id — the tenant identifier never reaches the model prompt", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider());
    generateMock.mockResolvedValue({
      text: "Steady activity.",
      model: "claude-haiku-4-5",
      inputTokens: 10,
      outputTokens: 4,
    });
    await generateInsightNarrative("activity", PAYLOAD, ACTOR);
    const [prompt] = generateMock.mock.calls[0]!;
    expect(prompt).not.toContain("ORG-SECRET-8f2c");
    expect(prompt).not.toContain("org_id");
    // The real facts are still present — narration has something to describe.
    expect(prompt).toContain("total_events");
  });
});

// ---------------------------------------------------------------------
// Source-pinned architecture — the trust boundary in text
// ---------------------------------------------------------------------

describe("insights layer wiring (source-pinned architecture)", () => {
  const GENERATOR = "lib/ai/insight-narrative.ts";
  const SERVICE = "server/services/ai-insights.ts";
  const PAGE = "app/(app)/insights/page.tsx";
  const ACTIVITY_ROUTE = "app/api/ai/activity_summary/route.ts";
  const LEAD_ROUTE = "app/api/ai/lead_insights/route.ts";
  const RENDER = "app/(app)/dashboard/_insights.tsx";

  it("the generator's ONLY model door is getTextProvider — no vendor SDK", () => {
    const code = read(GENERATOR);
    expect(code).toMatch(/getTextProvider\s*\(\s*\)/);
    expect(code).not.toMatch(/@anthropic-ai\/sdk/);
    expect(code).not.toMatch(/\bnew\s+Anthropic\b/);
    expect(code).not.toMatch(/import\(\s*["']openai["']\s*\)/);
    expect(code).not.toMatch(/\bnew\s+OpenAI\b/);
  });

  it("the generator strips org_id and records cost through the shared helper", () => {
    const code = read(GENERATOR);
    expect(code).toMatch(/stripOrgId/);
    expect(code).toMatch(/org_id/);
    expect(code).toMatch(/textCostUsd/);
  });

  it("the guardrail system prompt forbids inventing numbers, recommendations, or business state", () => {
    const code = read(GENERATOR);
    expect(code).toMatch(/Do NOT invent/);
    expect(code).toMatch(/Do NOT recommend/);
    expect(code).toMatch(/Do NOT state any business fact/);
  });

  it("the service funnels through the generator, caches, and records cost to the log", () => {
    const code = read(SERVICE);
    expect(code).toMatch(/generateInsightNarrative/);
    expect(code).toMatch(/cacheGet/);
    expect(code).toMatch(/cacheSet/);
    expect(code).toMatch(/\[ai\/insights\]/);
    expect(code).toMatch(/cost_usd/);
  });

  it("the /insights page overlays the narrative but keeps the authoritative deterministic compute", () => {
    const code = read(PAGE);
    expect(code).toMatch(/resolveInsightNarrative/);
    // The deterministic aggregates remain the source of every displayed number.
    expect(code).toMatch(/computeActivitySummary/);
    expect(code).toMatch(/computeLeadInsights/);
    expect(code).toMatch(/activityWithNarrative/);
  });

  it("both AI routes resolve the summary through the ONE funnel — the retired path is gone", () => {
    for (const routePath of [ACTIVITY_ROUTE, LEAD_ROUTE]) {
      const code = read(routePath);
      expect(code, routePath).toMatch(/resolveInsightNarrative/);
      expect(code, routePath).not.toMatch(/maybeGenerateSummary/);
      expect(code, routePath).not.toMatch(/@\/lib\/ai\/llm/);
    }
  });

  it("the ad-hoc lib/ai/llm.ts model path is fully retired", () => {
    expect(existsSync(resolve(root, "lib/ai/llm.ts"))).toBe(false);
  });

  it("the render component displays the overlaid narrative (activity.summary)", () => {
    const code = read(RENDER);
    expect(code).toMatch(/activity\.summary/);
  });
});
