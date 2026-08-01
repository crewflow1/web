import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * THE WORKER'S BUDGET GATES — embeddings governance at the cron seam.
 *
 * Two rules were added when the worker's batch embed moved behind
 * `governedEmbed`, and both are about NOT punishing rows for conditions that
 * are no fault of theirs:
 *
 *   1. ATTRIBUTION IS A PRECONDITION. A paid provider spends CrewFlow's own
 *      budget (hqBudgetOrgId — HQ memories have no tenant), and a governed
 *      call with no org cannot be reserved against a ceiling. No org ⇒ the run
 *      stops at `no_budget_org` BEFORE any claim is taken. The deterministic
 *      provider spends nothing, so it needs no org and keeps running in CI.
 *
 *   2. A BUDGET REFUSAL IS NOT A ROW FAILURE. The ceiling clears next month,
 *      the dedupe window clears in minutes; burning a retry attempt (five of
 *      which dead-letter the row) on either would turn a transient budget
 *      condition into permanent data loss. A refusal therefore stops the run
 *      (`budget_refused:<reason>`), fails NOBODY, and leaves the batch LEASED
 *      for `hq_embedding_reclaim_stale` to free on the next run.
 *
 * `governedEmbed` is mocked HERE (its own mapping is proven in
 * __tests__/ai/embeddings-governed.test.ts); the sibling suite
 * memory-embedder.test.ts drives the worker through the REAL door.
 */

const { rpcMock, getProviderMock, governedEmbedMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  getProviderMock: vi.fn(),
  governedEmbedMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));
vi.mock("@/lib/ai/embeddings", () => ({
  getEmbeddingProvider: getProviderMock,
}));
vi.mock("@/lib/ai/embeddings/governed", () => ({
  governedEmbed: governedEmbedMock,
}));

import { runEmbeddingWorker } from "@/server/services/memory-embedder";

const HQ_ORG = "00000000-0000-4000-8000-0000000000cf";

type ClaimRow = { id: string; embed_input: string };
const row = (id: string): ClaimRow => ({ id, embed_input: `body of ${id}` });
const vec4 = [0.1, 0.1, 0.1, 0.1];

function setProvider(provider: "openai" | "deterministic"): void {
  const model = provider === "openai" ? "text-embedding-3-small" : "hash-v1";
  getProviderMock.mockReturnValue({
    info: { provider, model, dimension: 4, version: `${provider}:${model}:d4:v1` },
    embed: vi.fn(),
  });
}

function routeRpc(claims: ClaimRow[][]): void {
  const queue = [...claims];
  rpcMock.mockImplementation((fn: string) => {
    switch (fn) {
      case "hq_memory_embed_enabled":
        return Promise.resolve({ data: true, error: null });
      case "hq_embedding_reclaim_stale":
        return Promise.resolve({ data: 0, error: null });
      case "hq_embedding_claim_batch":
        return Promise.resolve({ data: { claimed: queue.shift() ?? [] }, error: null });
      case "hq_embedding_complete":
        return Promise.resolve({ data: { ok: true }, error: null });
      case "hq_embedding_fail":
        return Promise.resolve({ data: { ok: true }, error: null });
      default:
        return Promise.resolve({ data: null, error: null });
    }
  });
}

const callsTo = (fn: string): unknown[][] => rpcMock.mock.calls.filter((c) => c[0] === fn);

beforeEach(() => {
  rpcMock.mockReset();
  getProviderMock.mockReset();
  governedEmbedMock.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

// =====================================================================
// (1) Attribution is a precondition for a PAID provider
// =====================================================================

describe("runEmbeddingWorker — the no_budget_org gate", () => {
  it("PAID provider + no CREWFLOW_INTERNAL_ORG_ID → stops BEFORE claiming anything", async () => {
    vi.stubEnv("CREWFLOW_INTERNAL_ORG_ID", "");
    setProvider("openai");
    routeRpc([[row("m1")]]);

    const res = await runEmbeddingWorker();

    expect(res).toMatchObject({
      ok: true,
      enabled: true,
      stopped: "no_budget_org",
      claimed: 0,
      embedded: 0,
      failed: 0,
      batches: 0,
    });
    // Fail dark, not unattributed: no lease is ever taken, no embed attempted.
    expect(callsTo("hq_embedding_claim_batch")).toHaveLength(0);
    expect(governedEmbedMock).not.toHaveBeenCalled();
  });

  it("DETERMINISTIC provider + no org → still runs (zero cost, nothing to attribute)", async () => {
    vi.stubEnv("CREWFLOW_INTERNAL_ORG_ID", "");
    setProvider("deterministic");
    routeRpc([[row("m1")]]);
    governedEmbedMock.mockResolvedValue({
      status: "embedded",
      vectors: [vec4],
      tokens: 4,
      info: { provider: "deterministic", model: "hash-v1", dimension: 4, version: "deterministic:hash-v1:d4:v1" },
      governed: false,
    });

    const res = await runEmbeddingWorker();

    expect(res).toMatchObject({
      ok: true,
      enabled: true,
      claimed: 1,
      embedded: 1,
      failed: 0,
      stopped: "queue_empty",
    });
    expect(callsTo("hq_embedding_complete")).toHaveLength(1);
  });

  it("PAID provider + org present → the batch is billed to the HQ org via the write feature", async () => {
    vi.stubEnv("CREWFLOW_INTERNAL_ORG_ID", HQ_ORG);
    setProvider("openai");
    routeRpc([[row("m1")]]);
    governedEmbedMock.mockResolvedValue({
      status: "embedded",
      vectors: [vec4],
      tokens: 4,
      info: { provider: "openai", model: "text-embedding-3-small", dimension: 4, version: "openai:text-embedding-3-small:d4:v1" },
      governed: true,
    });

    const res = await runEmbeddingWorker();

    expect(res).toMatchObject({ embedded: 1, failed: 0 });
    expect(governedEmbedMock).toHaveBeenCalledTimes(1);
    expect(governedEmbedMock.mock.calls[0]?.[0]).toMatchObject({
      feature: "memory.embedding_write",
      orgId: HQ_ORG,
      userId: null,
      texts: ["body of m1"],
    });
  });
});

// =====================================================================
// (2) A budget refusal fails NOBODY and stops the run
// =====================================================================

describe("runEmbeddingWorker — a governor refusal is not a row failure", () => {
  beforeEach(() => {
    vi.stubEnv("CREWFLOW_INTERNAL_ORG_ID", HQ_ORG);
    setProvider("openai");
  });

  it("refusal → stopped 'budget_refused:<reason>', zero failed, zero completed", async () => {
    routeRpc([[row("m1"), row("m2")]]);
    governedEmbedMock.mockResolvedValue({ status: "refused", reason: "monthly ceiling reached" });

    const res = await runEmbeddingWorker();

    expect(res.ok).toBe(true);
    expect(res.stopped).toBe("budget_refused:monthly ceiling reached");
    expect(String(res.stopped)).toMatch(/^budget_refused/);
    expect(res).toMatchObject({ claimed: 2, embedded: 0, failed: 0 });
    // THE pin: a refusal must not burn retry attempts toward the dead-letter
    // queue. No hq_embedding_fail, no hq_embedding_complete — the batch stays
    // LEASED for hq_embedding_reclaim_stale to free next run.
    expect(callsTo("hq_embedding_fail")).toHaveLength(0);
    expect(callsTo("hq_embedding_complete")).toHaveLength(0);
  });

  it("refusal stops CLAIMING — no second batch is taken from the queue", async () => {
    routeRpc([[row("m1")], [row("m2")], [row("m3")]]);
    governedEmbedMock.mockResolvedValue({ status: "refused", reason: "duplicate_in_flight" });

    const res = await runEmbeddingWorker({ batchSize: 1, maxBatches: 5 });

    expect(res.stopped).toBe("budget_refused:duplicate_in_flight");
    expect(callsTo("hq_embedding_claim_batch")).toHaveLength(1);
    expect(governedEmbedMock).toHaveBeenCalledTimes(1);
  });

  it("an UNAVAILABLE outcome (provider failure) is still a per-row failure, unchanged", async () => {
    // The contrast case: a provider that failed HAS consumed an attempt — that
    // is what retry/backoff/DLQ accounting exists for. Only refusals are free.
    routeRpc([[row("m1"), row("m2")]]);
    governedEmbedMock.mockResolvedValue({ status: "unavailable", reason: "429 rate limited" });

    const res = await runEmbeddingWorker();

    expect(res).toMatchObject({ claimed: 2, embedded: 0, failed: 2, stopped: "queue_empty" });
    const fails = callsTo("hq_embedding_fail");
    expect(fails).toHaveLength(2);
    expect(fails[0]?.[1]).toMatchObject({ p_memory_id: "m1", p_error: "429 rate limited" });
  });
});
