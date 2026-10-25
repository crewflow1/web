import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

const windowJson = (over: Record<string, unknown> = {}) => ({
  window: "month",
  from: "2026-10-01T00:00:00Z",
  to: "2026-11-01T00:00:00Z",
  invocations: 3,
  cost_pence: 42,
  input_tokens: 1000,
  output_tokens: 200,
  cached_input_tokens: 50,
  failures: 1,
  fallback_events: 2,
  latency_p50_ms: 1200,
  latency_p95_ms: 3400,
  by_feature: [{ key: "quote.writer_draft", n: 2, pence: 40, in_tok: 900, out_tok: 180, cached_tok: 50 }],
  by_provider: [{ key: "anthropic", n: 3, pence: 42 }],
  by_model: [{ key: "claude-sonnet-5", n: 3, pence: 42 }],
  by_engine: [{ key: "hosted", n: 3, pence: 42 }],
  top_orgs: [{ key: "org-1", n: 3, pence: 42 }],
  ...over,
});

beforeEach(() => rpcMock.mockReset());

describe("buildAiCostReport", () => {
  it("calls ai_cost_window for today/week/month and maps snake_case → typed camelCase", async () => {
    rpcMock.mockImplementation((_fn: string, args?: { p_window?: string }) =>
      Promise.resolve({ data: windowJson({ window: args?.p_window ?? "month" }), error: null }),
    );
    const { buildAiCostReport } = await import("@/server/services/ai-cost-report");
    const report = await buildAiCostReport();

    expect(rpcMock).toHaveBeenCalledWith("ai_cost_window", { p_window: "today" });
    expect(rpcMock).toHaveBeenCalledWith("ai_cost_window", { p_window: "week" });
    expect(rpcMock).toHaveBeenCalledWith("ai_cost_window", { p_window: "month" });

    expect(report.month).toMatchObject({
      window: "month",
      invocations: 3,
      costPence: 42,
      cachedInputTokens: 50,
      fallbackEvents: 2,
      latencyP95Ms: 3400,
    });
    expect(report.month.byProvider[0]!).toEqual({ key: "anthropic", count: 3, costPence: 42, inputTokens: undefined, outputTokens: undefined, cachedInputTokens: undefined });
    expect(report.month.byFeature[0]!).toMatchObject({ key: "quote.writer_draft", count: 2, costPence: 40, inputTokens: 900 });
    expect(report.month.topOrgs[0]!.key).toBe("org-1");
  });

  it("coerces string numerics and tolerates missing arrays", async () => {
    rpcMock.mockResolvedValue({
      data: { window: "today", invocations: "5", cost_pence: "9", by_feature: null, by_engine: undefined },
      error: null,
    });
    const { buildAiCostReport } = await import("@/server/services/ai-cost-report");
    const report = await buildAiCostReport();
    expect(report.today.invocations).toBe(5);
    expect(report.today.costPence).toBe(9);
    expect(report.today.byFeature).toEqual([]);
    expect(report.today.byEngine).toEqual([]);
  });

  it("throws loud on a read error", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { buildAiCostReport } = await import("@/server/services/ai-cost-report");
    await expect(buildAiCostReport()).rejects.toThrow(/ai_cost_window\(.*\) failed: boom/);
  });
});
