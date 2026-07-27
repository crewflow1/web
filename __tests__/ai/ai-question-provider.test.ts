import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Tenant AI Q&A on the shared abstraction (Vision 2030 AI-2) — the unit tier.
 *
 * AI-1 activated the insights NARRATIVE through `lib/ai/text::getTextProvider`
 * and retired one ad-hoc SDK-direct path (`lib/ai/llm.ts`). This increment
 * retires the LAST one: the tenant "Ask CrewFlow Insights" handler
 * (`askAi`) used to read `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` itself,
 * `new Anthropic()` / `new OpenAI()` directly, and record NO cost. It now
 * reaches a model SOLELY through the shared provider abstraction, so the whole
 * tenant AI surface has ONE model door with cost accounting and graceful
 * degradation:
 *
 *   • ONE MODEL DOOR: generation reaches a model only via `getTextProvider`
 *     — no vendor SDK, no API key read in the handler.
 *   • NARRATE-NOT-INVENT: temperature 0 + the fixed guardrail system prompt;
 *     the deterministic snapshot is the model's only ground truth.
 *   • TRUTHFUL ATTRIBUTION: `generated_by` is OUR truth (the provider that ran),
 *     overwriting whatever the model self-reports.
 *   • ORG ISOLATION: the slim snapshot carries no org_id / PII, so nothing
 *     tenant-identifying reaches the prompt.
 *   • COST: provider-truth tokens + `textCostUsd` recorded to the log sink.
 *   • GRACEFUL: no provider / unsupported vendor / throw / unparseable / invalid
 *     → the deterministic answer stands in unchanged.
 *
 * The handler's three edges — the provider factory, the cost helper, and the
 * retention snapshot — are MOCKED so every leg runs without a model, a network,
 * or a database. `validateAiResponse` stays REAL (we test the true validator).
 */

const {
  getTextProviderMock,
  generateMock,
  textCostMock,
  isAiConfiguredMock,
  buildSnapshotMock,
} = vi.hoisted(() => ({
  getTextProviderMock: vi.fn(),
  generateMock: vi.fn(),
  textCostMock: vi.fn(),
  isAiConfiguredMock: vi.fn(),
  buildSnapshotMock: vi.fn(),
}));

vi.mock("@/lib/ai/text", () => ({
  getTextProvider: getTextProviderMock,
  textCostUsd: textCostMock,
}));

vi.mock("@/server/services/retention-snapshot", () => ({
  buildRetentionSnapshot: buildSnapshotMock,
}));

// Keep the real safety contract (AI_FORBIDDEN_ACTIONS + validateAiResponse);
// only the env-backed `isAiConfigured` gate is controlled here.
vi.mock("@/lib/ai/safety", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/safety")>();
  return { ...actual, isAiConfigured: isAiConfiguredMock };
});

import { askAi } from "@/server/services/ai-question";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

function fakeProvider(provider = "anthropic", model = "claude-haiku-4-5") {
  return { info: { provider, model }, generate: generateMock };
}

/** A representative retention snapshot — only the fields `slimSnapshot` reads. */
const SNAP = {
  now: "2026-07-10T00:00:00.000Z",
  last_activity_at: "2026-07-08T00:00:00.000Z",
  onboarding: {
    counts: { customers: 12, quotes: 7, invoices: 5, staffMembers: 3, importsCommitted: 1 },
  },
  overdue_invoice_count: 2,
  support_open_count: 1,
  unresolved_alerts_count: 0,
  invoiced_total_gbp: 42000,
  windows: {
    last_7d: {
      customers_added: 1,
      quotes_created: 0,
      quotes_accepted: 0,
      invoices_sent: 2,
      invoiced_gbp: 3000,
      payments_received_gbp: 1500,
    },
  },
};

/** A well-formed model reply (the model self-reports the WRONG provider on purpose). */
const VALID_JSON = JSON.stringify({
  answer: "  Your quote pipeline is converting steadily this month.  ",
  confidence: "high",
  sources: [{ label: "Quotes last 7d" }],
  generated_by: "openai",
});

let infoSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getTextProviderMock.mockReset();
  generateMock.mockReset();
  textCostMock.mockReset();
  isAiConfiguredMock.mockReset();
  buildSnapshotMock.mockReset();

  // Sensible defaults: AI on, a real-shaped provider, priced cost, a snapshot.
  isAiConfiguredMock.mockReturnValue(true);
  getTextProviderMock.mockReturnValue(fakeProvider());
  textCostMock.mockReturnValue(0.00031);
  buildSnapshotMock.mockResolvedValue(SNAP);

  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  errorSpy.mockRestore();
});

// ---------------------------------------------------------------------
// Behavioural — every leg of the handler
// ---------------------------------------------------------------------

describe("askAi — one model door via the shared abstraction", () => {
  it("returns a deterministic answer when AI is not configured (feature off)", async () => {
    isAiConfiguredMock.mockReturnValue(false);
    const out = await askAi({ orgId: "ORG-1", question: "Summarise this month." });
    expect(out.generated_by).toBe("deterministic");
    expect(getTextProviderMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("returns deterministic when configured but no provider resolves", async () => {
    getTextProviderMock.mockReturnValue(null);
    const out = await askAi({ orgId: "ORG-1", question: "Summarise this month." });
    expect(out.generated_by).toBe("deterministic");
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("returns deterministic for an unsupported provider vendor (never narrates from an unknown model)", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider("acme", "mystery-llm"));
    const out = await askAi({ orgId: "ORG-1", question: "Summarise this month." });
    expect(out.generated_by).toBe("deterministic");
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("returns deterministic (never throws) when the provider throws", async () => {
    generateMock.mockRejectedValue(new Error("rate limited"));
    const out = await askAi({ orgId: "ORG-1", question: "How are we doing?" });
    expect(out.generated_by).toBe("deterministic");
    expect(out.answer.length).toBeGreaterThan(0);
  });

  it("returns deterministic when the model reply is unparseable", async () => {
    generateMock.mockResolvedValue({
      text: "sorry, I can't help with that",
      model: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 8,
    });
    const out = await askAi({ orgId: "ORG-1", question: "How are we doing?" });
    expect(out.generated_by).toBe("deterministic");
  });

  it("returns deterministic when the model JSON is missing an answer", async () => {
    generateMock.mockResolvedValue({
      text: JSON.stringify({ confidence: "high", sources: [] }),
      model: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 8,
    });
    const out = await askAi({ orgId: "ORG-1", question: "How are we doing?" });
    expect(out.generated_by).toBe("deterministic");
  });

  it("happy path — trimmed prose, OUR provider attribution, cost via textCostUsd", async () => {
    getTextProviderMock.mockReturnValue(fakeProvider("anthropic", "claude-haiku-4-5"));
    generateMock.mockResolvedValue({
      text: VALID_JSON,
      model: "claude-haiku-4-5",
      inputTokens: 250,
      outputTokens: 40,
    });
    const out = await askAi({ orgId: "ORG-1", question: "How is the pipeline?" });
    expect(out.answer).toBe("Your quote pipeline is converting steadily this month.");
    expect(out.confidence).toBe("high");
    expect(out.sources[0]?.label).toBe("Quotes last 7d");
    // Model self-reported "openai"; the handler overwrites with the provider
    // that actually ran — attribution is OUR truth, not the model's.
    expect(out.generated_by).toBe("anthropic");
    expect(textCostMock).toHaveBeenCalledWith(
      { provider: "anthropic", model: "claude-haiku-4-5" },
      expect.objectContaining({ inputTokens: 250, outputTokens: 40 }),
    );
  });

  it("records provider-truth cost to the structured log sink", async () => {
    generateMock.mockResolvedValue({
      text: VALID_JSON,
      model: "claude-haiku-4-5",
      inputTokens: 250,
      outputTokens: 40,
    });
    await askAi({ orgId: "ORG-42", question: "How is the pipeline?" });
    expect(infoSpy).toHaveBeenCalledWith(
      "[ai-question] answered",
      expect.objectContaining({
        org_id: "ORG-42",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        cost_usd: 0.00031,
      }),
    );
  });

  it("applies the guardrail system prompt at temperature 0 with a bounded token cap and a timeout", async () => {
    generateMock.mockResolvedValue({
      text: VALID_JSON,
      model: "claude-haiku-4-5",
      inputTokens: 10,
      outputTokens: 4,
    });
    await askAi({ orgId: "ORG-1", question: "How are we doing?" });
    const [, opts] = generateMock.mock.calls[0]!;
    expect(opts.system).toMatch(/STRICT RULES/);
    expect(opts.system).toMatch(/read-only/i);
    expect(opts.temperature).toBe(0);
    expect(opts.maxTokens).toBeGreaterThan(0);
    expect(opts.signal).toBeDefined();
  });

  it("the prompt carries snapshot facts but never the org identifier (org isolation)", async () => {
    generateMock.mockResolvedValue({
      text: VALID_JSON,
      model: "claude-haiku-4-5",
      inputTokens: 10,
      outputTokens: 4,
    });
    await askAi({ orgId: "ORG-SECRET-8f2c", question: "How are we doing?" });
    const [prompt] = generateMock.mock.calls[0]!;
    expect(prompt).not.toContain("ORG-SECRET-8f2c");
    expect(prompt).not.toContain("org_id");
    // The real facts are still present — the model has something to describe.
    expect(prompt).toContain("ORG SNAPSHOT");
    expect(prompt).toContain("customers");
  });
});

// ---------------------------------------------------------------------
// Source-pinned architecture — the last ad-hoc SDK door is gone
// ---------------------------------------------------------------------

describe("ai-question wiring (source-pinned architecture)", () => {
  const HANDLER = "server/services/ai-question.ts";

  it("the handler's ONLY model door is getTextProvider — no vendor SDK", () => {
    const code = read(HANDLER);
    expect(code).toMatch(/getTextProvider\s*\(\s*\)/);
    expect(code).not.toMatch(/@anthropic-ai\/sdk/);
    expect(code).not.toMatch(/\bnew\s+Anthropic\b/);
    expect(code).not.toMatch(/import\(\s*["']openai["']\s*\)/);
    expect(code).not.toMatch(/\bnew\s+OpenAI\b/);
  });

  it("the handler no longer reads provider API keys directly (the abstraction owns that)", () => {
    const code = read(HANDLER);
    expect(code).not.toMatch(/process\.env\.ANTHROPIC_API_KEY/);
    expect(code).not.toMatch(/process\.env\.OPENAI_API_KEY/);
  });

  it("the handler records cost through the shared helper and narrates at temperature 0", () => {
    const code = read(HANDLER);
    expect(code).toMatch(/textCostUsd/);
    expect(code).toMatch(/temperature:\s*0/);
  });

  it("the deterministic fallback + the isAiConfigured gate are preserved", () => {
    const code = read(HANDLER);
    expect(code).toMatch(/deterministicAnswer/);
    expect(code).toMatch(/if \(!isAiConfigured\(\)\)/);
  });
});
