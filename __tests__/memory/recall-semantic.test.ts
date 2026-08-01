import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Unit proof for the SEMANTIC recall seam in `recallMemory`
 * (CEO Directive 009 Module 1, PR4d). Mocks the admin client's RPC and the
 * embedding-provider factory so the read-path's graceful-degradation contract
 * is exercised deterministically WITHOUT a database or a network call. The live
 * ANN behaviour (the `public.vector` cast, the HNSW probe, permission + version
 * isolation) is proven in SQL (security tier) and end-to-end (integration tier);
 * here we assert the TS seam — "embeddings are a PLUG-IN, not a dependency":
 *
 *   - no provider configured            → semantic OFF, recall still works;
 *   - a blank query                     → the provider is never even consulted;
 *   - a provider failure (throw/timeout)→ semantic OFF, recall still works;
 *   - a wrong-shape vector              → semantic OFF, recall still works;
 *   - the happy path                    → the vector + its version are forwarded
 *                                         together and cos_sim drives the rank.
 *
 * The pure ranker (lib/memory/retrieval.ts) and the model helpers run for real —
 * only the provider factory and the RPC surface are mocked, so a real cos_sim
 * genuinely flows through scoring into the assembled order.
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

import { recallMemory } from "@/server/services/hq-memory";

const EMP = "11111111-1111-1111-1111-111111111111";
const VERSION_D4 = "openai:text-embedding-3-small:d4:v1";

/** A finite vector of the given dimension. */
function vec(dim: number, mark = 0.5): number[] {
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

/** A complete candidate row as hq_memory_recall projects it (snake_case). */
function candRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1",
    memory_class: "semantic",
    memory_type: "fact",
    title: "Title",
    summary: "Summary",
    visibility: "public_hq",
    department: null,
    owner_employee_id: null,
    importance: "normal",
    salience: 50,
    pinned: false,
    access_count: 0,
    consolidated_into: null,
    version: 1,
    created_at: "2026-06-01T00:00:00.000Z",
    last_reinforced_at: null,
    ts_rank: 0,
    structural_match: 0,
    cos_sim: null,
    body_tokens: 5,
    summary_tokens: 2,
    ...over,
  };
}

/** Route rpc() so recall returns `rows` and reinforce is a no-op. */
function setRecallRows(rows: Array<Record<string, unknown>>): void {
  rpcMock.mockImplementation((fn: string) => {
    if (fn === "hq_memory_recall") return { data: rows, error: null };
    if (fn === "hq_memory_reinforce") return { data: null, error: null };
    return { data: null, error: null };
  });
}

/** The args object passed to the hq_memory_recall RPC (asserted on). */
function recallArgs(): Record<string, unknown> {
  const call = rpcMock.mock.calls.find((c: unknown[]) => c[0] === "hq_memory_recall");
  expect(call, "hq_memory_recall was never called").toBeTruthy();
  return (call as unknown[])[1] as Record<string, unknown>;
}

beforeEach(() => {
  rpcMock.mockReset();
  getProviderMock.mockReset();
  embedMock.mockReset();
  // The query probe now travels through the governed door (embeddings
  // governance): a PAID provider bills the HQ budget org, so one must exist
  // for the paid seam below to be reachable at all. With the `embedding` tier
  // unbound in this build the governor dark-short-circuits into
  // `provider.embed()`, so every argument/degradation assertion here still
  // observes the provider seam. The no-org refusal (semantic off, recall
  // intact) is its own pin below.
  vi.stubEnv("CREWFLOW_INTERNAL_ORG_ID", "00000000-0000-4000-8000-0000000000cf");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// =====================================================================
// No provider — semantic OFF, every other channel keeps working
// =====================================================================

describe("recallMemory — graceful when no provider is configured", () => {
  it("passes null embedding + null version and never calls embed", async () => {
    getProviderMock.mockReturnValue(null);
    setRecallRows([candRow({ id: "m1", ts_rank: 0.5 })]);

    const res = await recallMemory({ query: "hello" }, { id: EMP });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.items.map((i) => i.id)).toContain("m1");
    const args = recallArgs();
    expect(args.p_query_embedding).toBeNull();
    expect(args.p_query_version).toBeNull();
    expect(embedMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Blank query — the provider is never even consulted
// =====================================================================

describe("recallMemory — a blank query short-circuits the probe", () => {
  it("does not look up a provider and sends no embedding", async () => {
    setProvider(4);
    setRecallRows([candRow({ id: "m1" })]);

    const res = await recallMemory({ query: "   " }, { id: EMP });

    expect(res.ok).toBe(true);
    expect(getProviderMock).not.toHaveBeenCalled();
    expect(embedMock).not.toHaveBeenCalled();
    const args = recallArgs();
    expect(args.p_query_embedding).toBeNull();
    expect(args.p_query_version).toBeNull();
  });

  it("treats a null query the same way", async () => {
    setProvider(4);
    setRecallRows([candRow({ id: "m1" })]);

    const res = await recallMemory({ query: null }, { id: EMP });

    expect(res.ok).toBe(true);
    expect(getProviderMock).not.toHaveBeenCalled();
    expect(embedMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Happy path — vector + version travel together, cos_sim drives the rank
// =====================================================================

describe("recallMemory — generates + forwards the probe and ranks on cos_sim", () => {
  it("embeds the trimmed query under an abort signal and forwards (vector, version)", async () => {
    setProvider(4);
    embedMock.mockResolvedValue({
      vectors: [vec(4, 0.5)],
      model: "text-embedding-3-small",
      dimension: 4,
      tokens: 5,
    });
    setRecallRows([candRow({ id: "m1" })]);

    const res = await recallMemory({ query: "  hello  " }, { id: EMP });

    expect(res.ok).toBe(true);
    expect(embedMock).toHaveBeenCalledTimes(1);
    const firstCall = embedMock.mock.calls[0];
    expect(firstCall).toBeTruthy();
    expect(firstCall?.[0]).toEqual(["hello"]); // trimmed, single input
    expect(firstCall?.[1]?.signal).toBeInstanceOf(AbortSignal); // latency guard
    const args = recallArgs();
    expect(args.p_query_embedding).toEqual(vec(4, 0.5));
    expect(args.p_query_version).toBe(VERSION_D4);
  });

  it("a high cos_sim outranks a null cos_sim, all else equal", async () => {
    setProvider(4);
    embedMock.mockResolvedValue({
      vectors: [vec(4, 0.5)],
      model: "text-embedding-3-small",
      dimension: 4,
      tokens: 5,
    });
    setRecallRows([
      candRow({ id: "low", memory_type: "a", cos_sim: null }),
      candRow({ id: "high", memory_type: "b", cos_sim: 0.95 }),
    ]);

    const res = await recallMemory({ query: "hello" }, { id: EMP });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.items[0]?.id).toBe("high");
      expect(res.items.map((i) => i.id)).toContain("low");
    }
  });
});

// =====================================================================
// Provider failures — never fail the recall the caller asked for
// =====================================================================

describe("recallMemory — a provider failure degrades to lexical, never errors", () => {
  it("embed throws (rate-limit / bad key) → null probe, recall still returns", async () => {
    setProvider(4);
    embedMock.mockRejectedValue(new Error("429 rate limited"));
    setRecallRows([candRow({ id: "m1" })]);

    const res = await recallMemory({ query: "hello" }, { id: EMP });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.items.map((i) => i.id)).toContain("m1");
    const args = recallArgs();
    expect(args.p_query_embedding).toBeNull();
    expect(args.p_query_version).toBeNull();
  });

  it("a wrong-dimension vector → null probe (never compared cross-space)", async () => {
    setProvider(4);
    embedMock.mockResolvedValue({
      vectors: [vec(3, 0.5)], // provider says 4, returned 3 → reject
      model: "text-embedding-3-small",
      dimension: 3,
      tokens: 5,
    });
    setRecallRows([candRow({ id: "m1" })]);

    const res = await recallMemory({ query: "hello" }, { id: EMP });

    expect(res.ok).toBe(true);
    const args = recallArgs();
    expect(args.p_query_embedding).toBeNull();
    expect(args.p_query_version).toBeNull();
  });

  it("an empty vectors array → null probe", async () => {
    setProvider(4);
    embedMock.mockResolvedValue({
      vectors: [],
      model: "text-embedding-3-small",
      dimension: 4,
      tokens: 0,
    });
    setRecallRows([candRow({ id: "m1" })]);

    const res = await recallMemory({ query: "hello" }, { id: EMP });

    expect(res.ok).toBe(true);
    const args = recallArgs();
    expect(args.p_query_embedding).toBeNull();
    expect(args.p_query_version).toBeNull();
  });
});

// =====================================================================
// Budget attribution — a paid probe with no HQ org degrades, deterministic
// needs none
// =====================================================================

describe("recallMemory — the governed probe fails dark without a budget org", () => {
  it("PAID provider + no CREWFLOW_INTERNAL_ORG_ID → semantic off, embed never called", async () => {
    // An unattributed paid embed would be spend outside the ceiling — the
    // defect, not the fix. Recall itself must be untouched.
    vi.stubEnv("CREWFLOW_INTERNAL_ORG_ID", "");
    setProvider(4);
    setRecallRows([candRow({ id: "m1" })]);

    const res = await recallMemory({ query: "hello" }, { id: EMP });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.items.map((i) => i.id)).toContain("m1");
    expect(embedMock).not.toHaveBeenCalled();
    const args = recallArgs();
    expect(args.p_query_embedding).toBeNull();
    expect(args.p_query_version).toBeNull();
  });

  it("DETERMINISTIC provider + no org → the probe still runs (zero cost, nothing to bill)", async () => {
    vi.stubEnv("CREWFLOW_INTERNAL_ORG_ID", "");
    getProviderMock.mockReturnValue({
      info: {
        provider: "deterministic",
        model: "hash-v1",
        dimension: 4,
        version: "deterministic:hash-v1:d4:v1",
      },
      embed: embedMock,
    });
    embedMock.mockResolvedValue({
      vectors: [vec(4, 0.5)],
      model: "hash-v1",
      dimension: 4,
      tokens: 5,
    });
    setRecallRows([candRow({ id: "m1" })]);

    const res = await recallMemory({ query: "hello" }, { id: EMP });

    expect(res.ok).toBe(true);
    expect(embedMock).toHaveBeenCalledTimes(1);
    const args = recallArgs();
    expect(args.p_query_embedding).toEqual(vec(4, 0.5));
    expect(args.p_query_version).toBe("deterministic:hash-v1:d4:v1");
  });
});

// =====================================================================
// The RPC error path is unaffected by the probe
// =====================================================================

describe("recallMemory — surfaces a recall RPC error", () => {
  it("returns ok:false with the SQL error message", async () => {
    getProviderMock.mockReturnValue(null);
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_memory_recall") return { data: null, error: { message: "boom" } };
      return { data: null, error: null };
    });

    const res = await recallMemory({ query: "hello" }, { id: EMP });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("boom");
  });
});
