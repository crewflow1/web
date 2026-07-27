import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit proof for the embedding worker (CEO Directive 009 Module 1, PR4c). Mocks
 * the admin client's RPC and the embedding-provider factory so every failure
 * mode is exercised deterministically WITHOUT a database or a network call. The
 * real atomic claim/store/retry/DLQ behaviour is proven in SQL (security tier)
 * and end-to-end in the integration tier; here we assert the TS seam:
 *
 *   - the dark short-circuits (gate off, no provider) cost nothing;
 *   - the claim → embed → complete/fail loop maps its arguments correctly;
 *   - batch failure, vector corruption, lost leases, cost caps, deadlines, and
 *     claim errors each resolve to the right summary WITHOUT throwing.
 *
 * The versioning helpers (checksum/cost/validation) are pure and run for real —
 * only the provider factory and the RPC surface are mocked.
 */

const { rpcMock, getProviderMock, embedMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  getProviderMock: vi.fn(),
  embedMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

vi.mock("@/lib/ai/embeddings", () => ({
  getEmbeddingProvider: getProviderMock,
}));

import {
  runEmbeddingWorker,
  isEmbedWorkerEnabled,
  getEmbeddingGoldenSignals,
} from "@/server/services/memory-embedder";

type ClaimRow = { id: string; embed_input: string };

const ROW_TEXT = "hello world body text"; // 21 chars → estimateTokens = 6

function row(id: string, text: string = ROW_TEXT): ClaimRow {
  return { id, embed_input: text };
}

/** A finite vector of the given dimension. */
function vec(dim: number, mark = 0.1): number[] {
  return Array.from({ length: dim }, () => mark);
}

/** Install a fake provider with the given embedding dimension. */
function setProvider(dimension = 4): void {
  getProviderMock.mockReturnValue({
    info: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimension,
      version: `openai:text-embedding-3-small:d${dimension}:v1`,
    },
    embed: embedMock,
  });
}

const VERSION_D4 = "openai:text-embedding-3-small:d4:v1";

/** Route rpc() responses by function name. claim_batch drains a queue. */
function routeRpc(cfg: {
  enabled?: boolean;
  reclaim?: number;
  reclaimReject?: boolean;
  claims?: ClaimRow[][];
  claimError?: string;
  complete?: { ok: boolean; reason?: string };
  golden?: Record<string, unknown> | null;
}): void {
  const claimsQueue = [...(cfg.claims ?? [])];
  rpcMock.mockImplementation((fn: string) => {
    switch (fn) {
      case "hq_memory_embed_enabled":
        return Promise.resolve({ data: cfg.enabled ?? false, error: null });
      case "hq_embedding_reclaim_stale":
        if (cfg.reclaimReject) return Promise.reject(new Error("reclaim down"));
        return Promise.resolve({ data: cfg.reclaim ?? 0, error: null });
      case "hq_embedding_claim_batch":
        if (cfg.claimError) {
          return Promise.resolve({ data: null, error: { message: cfg.claimError } });
        }
        return Promise.resolve({ data: { claimed: claimsQueue.shift() ?? [] }, error: null });
      case "hq_embedding_complete":
        return Promise.resolve({ data: cfg.complete ?? { ok: true }, error: null });
      case "hq_embedding_fail":
        return Promise.resolve({ data: { ok: true }, error: null });
      case "hq_embedding_golden_signals":
        return Promise.resolve({ data: cfg.golden ?? null, error: null });
      default:
        return Promise.resolve({ data: null, error: null });
    }
  });
}

function callsTo(fn: string): unknown[][] {
  return rpcMock.mock.calls.filter((c) => c[0] === fn);
}

describe("memory-embedder worker", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    getProviderMock.mockReset();
    embedMock.mockReset();
  });

  // --- Dark short-circuits ---------------------------------------------------

  it("is a no-op when the kill-switch is off (never reads the provider or claims)", async () => {
    routeRpc({ enabled: false });
    setProvider();

    const res = await runEmbeddingWorker();

    expect(res).toMatchObject({ ok: true, enabled: false, stopped: "disabled", claimed: 0, embedded: 0 });
    expect(getProviderMock).not.toHaveBeenCalled();
    expect(callsTo("hq_embedding_claim_batch")).toHaveLength(0);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("is a graceful no-op when no provider is configured (recall keeps working)", async () => {
    routeRpc({ enabled: true });
    getProviderMock.mockReturnValue(null);

    const res = await runEmbeddingWorker();

    expect(res).toMatchObject({ ok: true, enabled: true, provider: null, stopped: "no_provider", claimed: 0 });
    expect(callsTo("hq_embedding_claim_batch")).toHaveLength(0);
    expect(embedMock).not.toHaveBeenCalled();
  });

  // --- Happy path ------------------------------------------------------------

  it("claims, embeds, and stores a batch — recording version, checksum, tokens, and cost", async () => {
    routeRpc({ enabled: true, reclaim: 0, claims: [[row("m1"), row("m2")]] });
    setProvider(4);
    embedMock.mockResolvedValue({
      vectors: [vec(4, 0.1), vec(4, 0.2)],
      model: "text-embedding-3-small",
      dimension: 4,
      tokens: 100,
    });

    const res = await runEmbeddingWorker();

    expect(res).toMatchObject({
      ok: true,
      enabled: true,
      provider: VERSION_D4,
      claimed: 2,
      embedded: 2,
      failed: 0,
      batches: 1,
      stopped: "queue_empty",
    });

    // Crash recovery runs BEFORE the first claim ("resume after restart").
    const order = rpcMock.mock.calls.map((c) => c[0]);
    expect(order.indexOf("hq_embedding_reclaim_stale")).toBeLessThan(
      order.indexOf("hq_embedding_claim_batch"),
    );

    // The provider saw the exact inputs and (no timeout) no options object.
    expect(embedMock).toHaveBeenCalledWith([ROW_TEXT, ROW_TEXT], undefined);

    // Each row stored with full provenance.
    const completes = callsTo("hq_embedding_complete");
    expect(completes).toHaveLength(2);
    expect(completes[0]?.[1]).toMatchObject({
      p_memory_id: "m1",
      p_provider: "openai",
      p_model: "text-embedding-3-small",
      p_dimension: 4,
      p_version: VERSION_D4,
    });
    const stored = completes[0]?.[1] as Record<string, unknown>;
    expect((stored.p_embedding as number[]).length).toBe(4);
    expect(typeof stored.p_checksum).toBe("string");
    expect((stored.p_checksum as string).length).toBe(64); // sha256 hex

    // The provider's authoritative batch tokens are split across rows (50/50).
    const tokenSum = completes.reduce((s, c) => s + ((c[1] as { p_tokens: number }).p_tokens), 0);
    expect(tokenSum).toBe(100);
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it("forwards the configured batch bounds and a per-run worker id", async () => {
    routeRpc({ enabled: true, claims: [[row("a1"), row("a2")], [row("b1"), row("b2")]] });
    setProvider(4);
    embedMock.mockResolvedValue({ vectors: [vec(4), vec(4)], model: "text-embedding-3-small", dimension: 4, tokens: 8 });

    const res = await runEmbeddingWorker({ batchSize: 2, maxBatches: 5, leaseSeconds: 120 });

    expect(res).toMatchObject({ claimed: 4, embedded: 4, batches: 2, stopped: "queue_empty" });
    const claim = callsTo("hq_embedding_claim_batch")[0]?.[1] as Record<string, unknown>;
    expect(claim).toMatchObject({ p_limit: 2, p_lease_seconds: 120 });
    expect(String(claim.p_worker_id)).toMatch(/^embed-/);
  });

  it("stops at maxBatches even when the queue still has work", async () => {
    routeRpc({ enabled: true, claims: [[row("a")], [row("b")], [row("c")]] });
    setProvider(4);
    embedMock.mockResolvedValue({ vectors: [vec(4)], model: "text-embedding-3-small", dimension: 4, tokens: 4 });

    const res = await runEmbeddingWorker({ batchSize: 1, maxBatches: 2 });

    expect(res).toMatchObject({ embedded: 2, batches: 2, stopped: "max_batches" });
    expect(callsTo("hq_embedding_claim_batch")).toHaveLength(2);
  });

  it("surfaces the count of leases reclaimed from crashed runs", async () => {
    routeRpc({ enabled: true, reclaim: 7, claims: [] });
    setProvider();

    const res = await runEmbeddingWorker();

    expect(res.reclaimed).toBe(7);
    expect(res).toMatchObject({ claimed: 0, embedded: 0, batches: 0, stopped: "queue_empty" });
  });

  // --- Failure modes ---------------------------------------------------------

  it("fails every row in a batch (for retry/backoff/DLQ) when the provider call throws", async () => {
    routeRpc({ enabled: true, claims: [[row("m1"), row("m2")]] });
    setProvider(4);
    embedMock.mockRejectedValue(new Error("rate limited"));

    const res = await runEmbeddingWorker();

    expect(res).toMatchObject({ enabled: true, claimed: 2, embedded: 0, failed: 2, batches: 1, stopped: "queue_empty" });
    const fails = callsTo("hq_embedding_fail");
    expect(fails).toHaveLength(2);
    expect(fails[0]?.[1]).toMatchObject({
      p_memory_id: "m1",
      p_error: "rate limited",
      p_provider: "openai",
      p_model: "text-embedding-3-small",
    });
    expect(callsTo("hq_embedding_complete")).toHaveLength(0);
  });

  it("dead-letters a corrupt (wrong-dimension) vector instead of indexing it", async () => {
    routeRpc({ enabled: true, claims: [[row("m1")]] });
    setProvider(4);
    // A 3-length vector from a dimension-4 provider — corruption.
    embedMock.mockResolvedValue({ vectors: [[0.1, 0.2, 0.3]], model: "text-embedding-3-small", dimension: 4, tokens: 10 });

    const res = await runEmbeddingWorker();

    expect(res).toMatchObject({ claimed: 1, embedded: 0, failed: 1 });
    const fails = callsTo("hq_embedding_fail");
    expect(fails).toHaveLength(1);
    expect(String((fails[0]?.[1] as { p_error: string }).p_error)).toMatch(/corrupt vector/);
    expect(callsTo("hq_embedding_complete")).toHaveLength(0);
  });

  it("treats a lost lease as a no-op — not embedded, not failed, never duplicated", async () => {
    routeRpc({ enabled: true, claims: [[row("m1")]], complete: { ok: false, reason: "lease_lost" } });
    setProvider(4);
    embedMock.mockResolvedValue({ vectors: [vec(4)], model: "text-embedding-3-small", dimension: 4, tokens: 10 });

    const res = await runEmbeddingWorker();

    expect(res).toMatchObject({ claimed: 1, embedded: 0, failed: 0, stopped: "queue_empty" });
    expect(callsTo("hq_embedding_complete")).toHaveLength(1);
    expect(callsTo("hq_embedding_fail")).toHaveLength(0);
  });

  it("stops claiming once the run's spend reaches the cost cap", async () => {
    routeRpc({ enabled: true, claims: [[row("m1"), row("m2")], [row("m3"), row("m4")]] });
    setProvider(4);
    // 10M tokens at $0.02/Mtok = $0.20 for the batch — over a $0.10 cap.
    embedMock.mockResolvedValue({ vectors: [vec(4), vec(4)], model: "text-embedding-3-small", dimension: 4, tokens: 10_000_000 });

    const res = await runEmbeddingWorker({ batchSize: 2, maxBatches: 5, maxCostUsd: 0.1 });

    expect(res).toMatchObject({ embedded: 2, batches: 1, stopped: "cost_cap" });
    // The second iteration trips the cap BEFORE claiming again.
    expect(callsTo("hq_embedding_claim_batch")).toHaveLength(1);
    expect(res.costUsd).toBeGreaterThanOrEqual(0.1);
  });

  it("stops at the wall-clock deadline before claiming", async () => {
    routeRpc({ enabled: true, claims: [[row("m1")]] });
    setProvider(4);
    // Date.now(): 1st = deadline base; 2nd (loop top) is already past it.
    const times = [1_000_000, 5_000_000];
    const spy = vi.spyOn(Date, "now").mockImplementation(() => times.shift() ?? 9_000_000);

    const res = await runEmbeddingWorker();
    spy.mockRestore();

    expect(res).toMatchObject({ stopped: "deadline", claimed: 0, batches: 0 });
    expect(callsTo("hq_embedding_claim_batch")).toHaveLength(0);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("reports a claim error cleanly (ok:false) without throwing", async () => {
    routeRpc({ enabled: true, claimError: "rls denied" });
    setProvider(4);

    const res = await runEmbeddingWorker();

    expect(res).toMatchObject({
      ok: false,
      enabled: true,
      stopped: "claim_error",
      error: "rls denied",
      provider: VERSION_D4,
    });
  });

  it("never throws — an unexpected rejection becomes ok:false / stopped:error", async () => {
    routeRpc({ enabled: true, reclaimReject: true });
    setProvider(4);

    const res = await runEmbeddingWorker();

    expect(res).toMatchObject({ ok: false, enabled: true, stopped: "error" });
    expect(res.error).toContain("reclaim down");
  });

  it("passes an AbortSignal to the provider when callTimeoutMs is set", async () => {
    routeRpc({ enabled: true, claims: [[row("m1")]] });
    setProvider(4);
    embedMock.mockResolvedValue({ vectors: [vec(4)], model: "text-embedding-3-small", dimension: 4, tokens: 4 });

    await runEmbeddingWorker({ callTimeoutMs: 5000 });

    const opts = embedMock.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  // --- Exported helpers ------------------------------------------------------

  it("isEmbedWorkerEnabled is fail-dark — any error reads as OFF", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    expect(await isEmbedWorkerEnabled()).toBe(true);

    rpcMock.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await isEmbedWorkerEnabled()).toBe(false);

    rpcMock.mockRejectedValue(new Error("down"));
    expect(await isEmbedWorkerEnabled()).toBe(false);
  });

  it("getEmbeddingGoldenSignals returns the signals or null (never throws)", async () => {
    rpcMock.mockResolvedValue({ data: { worker_enabled: false, memories: {} }, error: null });
    expect(await getEmbeddingGoldenSignals()).toMatchObject({ worker_enabled: false });
    const call = rpcMock.mock.calls.find((c) => c[0] === "hq_embedding_golden_signals");
    expect(call?.[1]).toEqual({ p_target_version: null });

    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await getEmbeddingGoldenSignals()).toBeNull();

    rpcMock.mockRejectedValue(new Error("down"));
    expect(await getEmbeddingGoldenSignals()).toBeNull();
  });

  it("getEmbeddingGoldenSignals forwards the target version", async () => {
    rpcMock.mockResolvedValue({ data: {}, error: null });
    await getEmbeddingGoldenSignals("v9");
    const call = rpcMock.mock.calls.find((c) => c[0] === "hq_embedding_golden_signals");
    expect(call?.[1]).toEqual({ p_target_version: "v9" });
  });
});
