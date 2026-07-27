import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit proof for the lifecycle worker (CEO Directive 009 Module 1, PR5d). Mocks
 * the admin client's RPC and the text-provider factory so every path is
 * exercised deterministically WITHOUT a database or a network call. The real
 * atomic archival/supersede/summary behaviour is proven in SQL (security tier)
 * and end-to-end in the integration tier; here we assert the TS seam:
 *
 *   - the dark short-circuit (gate off) costs nothing and never touches the
 *     ungated apply-primitives;
 *   - the sweep → dedupe → summarise orchestration maps its arguments correctly;
 *   - no text provider / no embeddings / per-item failures / cost caps /
 *     deadlines each resolve to the right summary WITHOUT throwing.
 */

const { rpcMock, getTextProviderMock, generateMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  getTextProviderMock: vi.fn(),
  generateMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

vi.mock("@/lib/ai/text", () => ({
  getTextProvider: getTextProviderMock,
}));

import {
  runMemoryLifecycleWorker,
  isLifecycleWorkerEnabled,
  getMemoryGoldenSignals,
  consolidateTheme,
} from "@/server/services/memory-lifecycle";

type Pair = { keep_id: string; drop_id: string; cos_sim: number };
type Candidate = { id: string; title: string; body: string; body_chars: number; summary_chars: number };

function pair(keep: string, drop: string, cos = 0.99): Pair {
  return { keep_id: keep, drop_id: drop, cos_sim: cos };
}
function candidate(id: string, bodyChars = 2000): Candidate {
  return { id, title: `Title ${id}`, body: "x".repeat(Math.min(bodyChars, 24000)), body_chars: bodyChars, summary_chars: 0 };
}

/** Install a fake Anthropic-shaped text provider. */
function setProvider(): void {
  getTextProviderMock.mockReturnValue({
    info: { provider: "anthropic", model: "claude-haiku-4-5" },
    generate: generateMock,
  });
}

/** Route rpc() responses by function name. */
function routeRpc(cfg: {
  enabled?: boolean;
  expire?: Record<string, unknown>;
  expireReject?: boolean;
  pairs?: Pair[];
  supersede?: { ok: boolean };
  supersedeQueue?: Array<{ ok: boolean }>;
  candidates?: Candidate[];
  setSummary?: { ok: boolean };
  golden?: Record<string, unknown> | null;
  consolidate?: unknown;
}): void {
  const superQueue = cfg.supersedeQueue ? [...cfg.supersedeQueue] : null;
  rpcMock.mockImplementation((fn: string) => {
    switch (fn) {
      case "hq_memory_lifecycle_enabled":
        return Promise.resolve({ data: cfg.enabled ?? false, error: null });
      case "hq_memory_expire_sweep":
        if (cfg.expireReject) return Promise.reject(new Error("sweep down"));
        return Promise.resolve({ data: cfg.expire ?? { ttl_expired: 0, decayed_archived: 0 }, error: null });
      case "hq_memory_dedupe_pairs":
        return Promise.resolve({ data: cfg.pairs ?? [], error: null });
      case "hq_memory_supersede":
        return Promise.resolve({ data: superQueue ? superQueue.shift() ?? { ok: false } : cfg.supersede ?? { ok: true }, error: null });
      case "hq_memory_summary_candidates":
        return Promise.resolve({ data: cfg.candidates ?? [], error: null });
      case "hq_memory_set_summary":
        return Promise.resolve({ data: cfg.setSummary ?? { ok: true }, error: null });
      case "hq_memory_golden_signals":
        return Promise.resolve({ data: cfg.golden ?? null, error: null });
      case "hq_memory_consolidate":
        return Promise.resolve({ data: cfg.consolidate ?? null, error: null });
      default:
        return Promise.resolve({ data: null, error: null });
    }
  });
}

function callsTo(fn: string): unknown[][] {
  return rpcMock.mock.calls.filter((c) => c[0] === fn);
}

const SHORT = { text: "A faithful summary of the note.", model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 20 };

describe("memory-lifecycle worker", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    getTextProviderMock.mockReset();
    generateMock.mockReset();
  });

  // --- Dark short-circuit ----------------------------------------------------

  it("is a no-op when the kill-switch is off (never reads the provider or the ungated primitives)", async () => {
    routeRpc({ enabled: false });
    setProvider();

    const res = await runMemoryLifecycleWorker();

    expect(res).toMatchObject({ ok: true, enabled: false, stopped: "disabled", ttlExpired: 0, superseded: 0, summarised: 0 });
    expect(getTextProviderMock).not.toHaveBeenCalled();
    expect(callsTo("hq_memory_expire_sweep")).toHaveLength(0);
    expect(callsTo("hq_memory_dedupe_pairs")).toHaveLength(0);
    expect(callsTo("hq_memory_supersede")).toHaveLength(0);
    expect(callsTo("hq_memory_summary_candidates")).toHaveLength(0);
  });

  // --- Happy path ------------------------------------------------------------

  it("sweeps, dedupes→supersedes, and summarises in one pass", async () => {
    routeRpc({
      enabled: true,
      expire: { ttl_expired: 2, decayed_archived: 1 },
      pairs: [pair("k1", "d1"), pair("k2", "d2")],
      candidates: [candidate("m1"), candidate("m2")],
    });
    setProvider();
    generateMock.mockResolvedValue(SHORT);

    const res = await runMemoryLifecycleWorker();

    expect(res).toMatchObject({
      ok: true,
      enabled: true,
      ttlExpired: 2,
      decayedArchived: 1,
      duplicatePairs: 2,
      superseded: 2,
      summaryCandidates: 2,
      summarised: 2,
      textProvider: "anthropic:claude-haiku-4-5",
      stopped: "ok",
    });
    expect(res.costUsd).toBeGreaterThan(0);

    // Supersede saw the keeper/drop ids + a dedupe reason.
    const sup = callsTo("hq_memory_supersede");
    expect(sup).toHaveLength(2);
    expect(sup[0]?.[1]).toMatchObject({ p_keep_id: "k1", p_drop_id: "d1", p_reason: "dedupe" });

    // set_summary saw the generated text for each candidate.
    const set = callsTo("hq_memory_set_summary");
    expect(set).toHaveLength(2);
    expect(set[0]?.[1]).toMatchObject({ p_memory_id: "m1", p_summary: SHORT.text });

    // The provider was prompted with a system instruction + the body.
    expect(generateMock).toHaveBeenCalledTimes(2);
    const genOpts = generateMock.mock.calls[0]?.[1] as { system?: string } | undefined;
    expect(genOpts?.system).toMatch(/summary/i);
  });

  it("forwards the dedupe threshold + scan limit and reports the text provider", async () => {
    routeRpc({ enabled: true, expire: { ttl_expired: 0, decayed_archived: 0 }, pairs: [] });
    setProvider();

    await runMemoryLifecycleWorker({ scanLimit: 75 });

    const sweep = callsTo("hq_memory_expire_sweep")[0]?.[1] as Record<string, unknown>;
    expect(sweep).toMatchObject({ p_limit: 75 });
    const dd = callsTo("hq_memory_dedupe_pairs")[0]?.[1] as Record<string, unknown>;
    expect(dd).toMatchObject({ p_limit: 75, p_threshold: 0.95 });
  });

  // --- Graceful degradation --------------------------------------------------

  it("skips summarisation entirely when no text provider is configured (expiry+dedup still run)", async () => {
    routeRpc({ enabled: true, expire: { ttl_expired: 1, decayed_archived: 0 }, pairs: [pair("k", "d")] });
    getTextProviderMock.mockReturnValue(null);

    const res = await runMemoryLifecycleWorker();

    expect(res).toMatchObject({ ttlExpired: 1, superseded: 1, summaryCandidates: 0, summarised: 0, textProvider: null, stopped: "ok" });
    expect(callsTo("hq_memory_summary_candidates")).toHaveLength(0);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("is a dedup no-op when there are no embeddings (detector returns [])", async () => {
    routeRpc({ enabled: true, expire: { ttl_expired: 0, decayed_archived: 0 }, pairs: [], candidates: [] });
    setProvider();

    const res = await runMemoryLifecycleWorker();

    expect(res).toMatchObject({ duplicatePairs: 0, superseded: 0, stopped: "ok" });
    expect(callsTo("hq_memory_supersede")).toHaveLength(0);
  });

  // --- Failure isolation -----------------------------------------------------

  it("counts only successful supersedes — a failed merge is isolated, not fatal", async () => {
    routeRpc({
      enabled: true,
      expire: { ttl_expired: 0, decayed_archived: 0 },
      pairs: [pair("k1", "d1"), pair("k2", "d2")],
      supersedeQueue: [{ ok: true }, { ok: false }],
      candidates: [],
    });
    setProvider();

    const res = await runMemoryLifecycleWorker();

    expect(res).toMatchObject({ duplicatePairs: 2, superseded: 1, stopped: "ok" });
    expect(callsTo("hq_memory_supersede")).toHaveLength(2);
  });

  it("skips a memory whose generation throws (stays a candidate, never crashes the run)", async () => {
    routeRpc({ enabled: true, expire: { ttl_expired: 0, decayed_archived: 0 }, pairs: [], candidates: [candidate("m1"), candidate("m2")] });
    setProvider();
    generateMock.mockRejectedValueOnce(new Error("429 rate limited")).mockResolvedValueOnce(SHORT);

    const res = await runMemoryLifecycleWorker();

    expect(res).toMatchObject({ summaryCandidates: 2, summarised: 1, stopped: "ok" });
    // Only the second (successful) generation was persisted.
    const set = callsTo("hq_memory_set_summary");
    expect(set).toHaveLength(1);
    expect(set[0]?.[1]).toMatchObject({ p_memory_id: "m2" });
  });

  it("does NOT persist a 'summary' that is not meaningfully shorter than the body", async () => {
    routeRpc({ enabled: true, expire: { ttl_expired: 0, decayed_archived: 0 }, pairs: [], candidates: [candidate("m1", 2000)] });
    setProvider();
    // 1300 chars vs a 2000-char body → 65% ≥ the 60% ratio → not a real summary.
    generateMock.mockResolvedValue({ text: "y".repeat(1300), model: "claude-haiku-4-5", inputTokens: 50, outputTokens: 500 });

    const res = await runMemoryLifecycleWorker();

    expect(res).toMatchObject({ summaryCandidates: 1, summarised: 0 });
    expect(callsTo("hq_memory_set_summary")).toHaveLength(0);
  });

  it("does NOT persist an empty generation", async () => {
    routeRpc({ enabled: true, expire: { ttl_expired: 0, decayed_archived: 0 }, pairs: [], candidates: [candidate("m1")] });
    setProvider();
    generateMock.mockResolvedValue({ text: "", model: "claude-haiku-4-5", inputTokens: 10, outputTokens: 0 });

    const res = await runMemoryLifecycleWorker();

    expect(res).toMatchObject({ summarised: 0 });
    expect(callsTo("hq_memory_set_summary")).toHaveLength(0);
  });

  // --- Bounds ----------------------------------------------------------------

  it("stops summarising once the run's spend reaches the cost cap", async () => {
    routeRpc({ enabled: true, expire: { ttl_expired: 0, decayed_archived: 0 }, pairs: [], candidates: [candidate("m1"), candidate("m2")] });
    setProvider();
    // 1M output tokens @ $5/Mtok = $5 for the first summary — over a $0.01 cap.
    generateMock.mockResolvedValue({ text: "short summary", model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 1_000_000 });

    const res = await runMemoryLifecycleWorker({ maxCostUsd: 0.01 });

    expect(res).toMatchObject({ summarised: 1, stopped: "cost_cap" });
    expect(generateMock).toHaveBeenCalledTimes(1); // 2nd candidate never generated
    expect(res.costUsd).toBeGreaterThanOrEqual(0.01);
  });

  it("respects maxSupersedes / maxSummaries caps", async () => {
    routeRpc({
      enabled: true,
      expire: { ttl_expired: 0, decayed_archived: 0 },
      pairs: [pair("k1", "d1"), pair("k2", "d2"), pair("k3", "d3")],
      candidates: [candidate("m1"), candidate("m2"), candidate("m3")],
    });
    setProvider();
    generateMock.mockResolvedValue(SHORT);

    const res = await runMemoryLifecycleWorker({ maxSupersedes: 1, maxSummaries: 2 });

    expect(res).toMatchObject({ superseded: 1, summarised: 2 });
    expect(callsTo("hq_memory_supersede")).toHaveLength(1);
    // maxSummaries is passed straight to the candidate detector as p_limit.
    const cand = callsTo("hq_memory_summary_candidates")[0]?.[1] as Record<string, unknown>;
    expect(cand).toMatchObject({ p_limit: 2 });
  });

  it("stops at the wall-clock deadline (dedupe/summarise skipped) without throwing", async () => {
    routeRpc({ enabled: true, expire: { ttl_expired: 3, decayed_archived: 0 }, pairs: [pair("k", "d")], candidates: [candidate("m1")] });
    setProvider();
    // Date.now(): 1st = deadline base; 2nd (dedupe guard) is already past it.
    const times = [1_000_000, 9_000_000];
    const spy = vi.spyOn(Date, "now").mockImplementation(() => times.shift() ?? 9_000_000);

    const res = await runMemoryLifecycleWorker();
    spy.mockRestore();

    expect(res).toMatchObject({ ttlExpired: 3, superseded: 0, summarised: 0, stopped: "deadline" });
    expect(callsTo("hq_memory_dedupe_pairs")).toHaveLength(0);
    expect(callsTo("hq_memory_summary_candidates")).toHaveLength(0);
  });

  // --- Never throws ----------------------------------------------------------

  it("never throws — an unexpected rejection becomes ok:false / stopped:error", async () => {
    routeRpc({ enabled: true, expireReject: true });
    setProvider();

    const res = await runMemoryLifecycleWorker();

    expect(res).toMatchObject({ ok: false, enabled: true, stopped: "error" });
    expect(res.error).toContain("sweep down");
  });

  // --- Exported helpers ------------------------------------------------------

  it("isLifecycleWorkerEnabled is fail-dark — any error reads as OFF", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    expect(await isLifecycleWorkerEnabled()).toBe(true);

    rpcMock.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await isLifecycleWorkerEnabled()).toBe(false);

    rpcMock.mockRejectedValue(new Error("down"));
    expect(await isLifecycleWorkerEnabled()).toBe(false);
  });

  it("getMemoryGoldenSignals returns the signals or null (never throws)", async () => {
    rpcMock.mockResolvedValue({ data: { worker_enabled: false, memories: {} }, error: null });
    expect(await getMemoryGoldenSignals()).toMatchObject({ worker_enabled: false });

    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await getMemoryGoldenSignals()).toBeNull();

    rpcMock.mockRejectedValue(new Error("down"));
    expect(await getMemoryGoldenSignals()).toBeNull();
  });

  it("consolidateTheme returns the new memory id, or null on no-op/error", async () => {
    rpcMock.mockResolvedValue({ data: "new-mem-id", error: null });
    expect(await consolidateTheme("emp-1", "late payments")).toBe("new-mem-id");
    const call = rpcMock.mock.calls.find((c) => c[0] === "hq_memory_consolidate");
    expect(call?.[1]).toEqual({ p_employee_id: "emp-1", p_theme: "late payments" });

    rpcMock.mockResolvedValue({ data: null, error: null }); // < MIN sources → null
    expect(await consolidateTheme("emp-1", "noise")).toBeNull();

    rpcMock.mockRejectedValue(new Error("down"));
    expect(await consolidateTheme("emp-1", "x")).toBeNull();
  });
});
