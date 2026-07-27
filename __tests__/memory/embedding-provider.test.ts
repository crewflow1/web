import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EMBEDDING_SCHEMA_REVISION,
  embeddingVersion,
  embeddingChecksum,
  embeddingCostUsd,
  estimateTokens,
  isValidEmbedding,
  assertValidEmbedding,
  EmbeddingDimensionError,
} from "@/lib/ai/embeddings/versioning";
import { getEmbeddingProvider, isEmbeddingConfigured } from "@/lib/ai/embeddings";
import { createOpenAiEmbeddingProvider } from "@/lib/ai/embeddings/openai";
import { createDeterministicEmbeddingProvider } from "@/lib/ai/embeddings/deterministic";

/**
 * Shared Memory — embedding provider abstraction (Volume X §11; CEO Directive
 * 009 Module 1, PR4a).
 *
 * The CEO's "plug-in, never a dependency" rule lives on two seams, both
 * proven here WITHOUT a database or a live API:
 *   - the FACTORY returns `null` when nothing is configured (graceful
 *     degradation — semantic search off, every other channel unaffected);
 *   - the PROVIDER throws on a vendor failure (so the worker, not the
 *     provider, owns retry / backoff / dead-letter).
 * Plus the pure versioning/cost/validation helpers that make embeddings
 * versioned, deduplicated, cost-accounted assets.
 */

// The `openai` SDK is dynamically imported by the provider; mock it so embed()
// is deterministic and never touches the network.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    embeddings: { create: mockCreate },
  })),
}));

/** A structurally-valid 1536-d vector whose first element marks its identity. */
function vec(mark: number): number[] {
  const v = new Array<number>(1536).fill(0.01);
  v[0] = mark;
  return v;
}

// =====================================================================
// 1. Versioning — the canonical staleness key
// =====================================================================

describe("embeddingVersion — the single re-embed trigger", () => {
  const base = { provider: "openai", model: "text-embedding-3-small", dimension: 1536 };

  it("composes provider:model:dimension:revision", () => {
    expect(embeddingVersion(base)).toBe(
      `openai:text-embedding-3-small:d1536:v${EMBEDDING_SCHEMA_REVISION}`,
    );
  });

  it("changes when the PROVIDER changes (vendor swap → re-embed)", () => {
    expect(embeddingVersion({ ...base, provider: "voyage" })).not.toBe(embeddingVersion(base));
  });

  it("changes when the MODEL changes (model upgrade → re-embed)", () => {
    expect(embeddingVersion({ ...base, model: "text-embedding-3-large" })).not.toBe(
      embeddingVersion(base),
    );
  });

  it("changes when the DIMENSION changes (dimension change → re-embed)", () => {
    expect(embeddingVersion({ ...base, dimension: 3072 })).not.toBe(embeddingVersion(base));
  });
});

// =====================================================================
// 2. Checksum — idempotency + drift detection
// =====================================================================

describe("embeddingChecksum — idempotency + drift", () => {
  it("is stable for identical text", () => {
    expect(embeddingChecksum("hello world")).toBe(embeddingChecksum("hello world"));
  });

  it("differs when the source text changes (body edit ⇒ re-embed)", () => {
    expect(embeddingChecksum("hello world")).not.toBe(embeddingChecksum("hello  world"));
  });

  it("is a 64-char hex sha-256 digest", () => {
    expect(embeddingChecksum("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// =====================================================================
// 3. Cost — observability, never a correctness gate
// =====================================================================

describe("embeddingCostUsd — provider pricing metadata", () => {
  it("prices the Version-1 model (text-embedding-3-small @ $0.02/Mtok)", () => {
    expect(embeddingCostUsd({ provider: "openai", model: "text-embedding-3-small" }, 1_000_000)).toBeCloseTo(0.02, 10);
    expect(embeddingCostUsd({ provider: "openai", model: "text-embedding-3-small" }, 500_000)).toBeCloseTo(0.01, 10);
  });

  it("returns null for an unknown model — cost unknown, never blocks embedding", () => {
    expect(embeddingCostUsd({ provider: "acme", model: "mystery-embed" }, 1_000_000)).toBeNull();
  });

  it("is zero for zero tokens", () => {
    expect(embeddingCostUsd({ provider: "openai", model: "text-embedding-3-small" }, 0)).toBe(0);
  });
});

// =====================================================================
// 4. Token estimate — attribution + budgeting (never billing)
// =====================================================================

describe("estimateTokens — rough, for attribution/budgeting only", () => {
  it("is zero for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("is at least 1 for any non-empty text", () => {
    expect(estimateTokens("a")).toBe(1);
  });

  it("scales ~chars/4", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

// =====================================================================
// 5. Vector validation — the corruption guard
// =====================================================================

describe("isValidEmbedding / assertValidEmbedding — corruption guard", () => {
  it("accepts a right-length, all-finite vector", () => {
    expect(isValidEmbedding(vec(0.5), 1536)).toBe(true);
    expect(() => assertValidEmbedding(vec(0.5), 1536)).not.toThrow();
  });

  it("rejects a wrong-length vector (dimension mismatch)", () => {
    expect(isValidEmbedding([0.1, 0.2, 0.3], 1536)).toBe(false);
    expect(() => assertValidEmbedding([0.1, 0.2, 0.3], 1536)).toThrow(EmbeddingDimensionError);
  });

  it("rejects NaN / Infinity (corruption)", () => {
    const nan = vec(0.5);
    nan[3] = NaN;
    const inf = vec(0.5);
    inf[7] = Infinity;
    expect(isValidEmbedding(nan, 1536)).toBe(false);
    expect(isValidEmbedding(inf, 1536)).toBe(false);
    expect(() => assertValidEmbedding(nan, 1536)).toThrow(/non-finite/);
  });

  it("rejects a non-array", () => {
    expect(isValidEmbedding("not-a-vector", 1536)).toBe(false);
    expect(isValidEmbedding(null, 1536)).toBe(false);
    expect(() => assertValidEmbedding(null, 1536)).toThrow(EmbeddingDimensionError);
  });

  it("carries expected vs actual on the error (for the worker's failure reason)", () => {
    try {
      assertValidEmbedding([1, 2], 1536);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EmbeddingDimensionError);
      expect((e as EmbeddingDimensionError).expected).toBe(1536);
      expect((e as EmbeddingDimensionError).actual).toBe(2);
    }
  });
});

// =====================================================================
// 6. Factory — the graceful-degradation seam (configuration only)
// =====================================================================

describe("getEmbeddingProvider — null when unconfigured, provider when configured", () => {
  const ENV = ["MEMORY_EMBEDDING_PROVIDER", "OPENAI_API_KEY"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.clearAllMocks();
  });

  it("returns null when no provider key is set (graceful degradation)", () => {
    expect(getEmbeddingProvider()).toBeNull();
    expect(isEmbeddingConfigured()).toBe(false);
  });

  it("defaults to OpenAI when a key is present and no provider is named", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const p = getEmbeddingProvider();
    expect(p).not.toBeNull();
    expect(p?.info.provider).toBe("openai");
    expect(p?.info.model).toBe("text-embedding-3-small");
    expect(p?.info.dimension).toBe(1536);
    expect(isEmbeddingConfigured()).toBe(true);
  });

  it("the provider's version equals embeddingVersion(info) — single source of truth", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const p = getEmbeddingProvider();
    expect(p?.info.version).toBe(
      embeddingVersion({ provider: "openai", model: "text-embedding-3-small", dimension: 1536 }),
    );
  });

  it("honours an explicit provider name, case/space-insensitively", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MEMORY_EMBEDDING_PROVIDER = "  OpenAI  ";
    expect(getEmbeddingProvider()?.info.provider).toBe("openai");
  });

  it("treats none/off/disabled/empty as explicitly off, even with a key set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    for (const off of ["none", "off", "disabled", ""]) {
      process.env.MEMORY_EMBEDDING_PROVIDER = off;
      expect(getEmbeddingProvider()).toBeNull();
    }
  });

  it("returns null for openai when its key is missing (named but unconfigured)", () => {
    process.env.MEMORY_EMBEDDING_PROVIDER = "openai";
    expect(getEmbeddingProvider()).toBeNull();
  });

  it("degrades (null) on an unknown provider name — never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.MEMORY_EMBEDDING_PROVIDER = "totally-made-up";
    expect(() => getEmbeddingProvider()).not.toThrow();
    expect(getEmbeddingProvider()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// =====================================================================
// 7. OpenAI provider.embed() — mocked SDK, deterministic
// =====================================================================

describe("OpenAI provider.embed — order, tokens, failure propagation", () => {
  const provider = createOpenAiEmbeddingProvider("sk-test");

  afterEach(() => vi.clearAllMocks());

  it("returns an empty result for an empty batch WITHOUT touching the network", async () => {
    const out = await provider.embed([]);
    expect(out).toEqual({ vectors: [], model: "text-embedding-3-small", dimension: 1536, tokens: 0 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("preserves input order even when the API returns rows out of order", async () => {
    mockCreate.mockResolvedValue({
      data: [
        { index: 1, embedding: vec(0.22) },
        { index: 0, embedding: vec(0.11) },
      ],
      usage: { total_tokens: 42, prompt_tokens: 42 },
    });
    const out = await provider.embed(["a", "b"]);
    expect(out.vectors[0]?.[0]).toBe(0.11); // input[0]
    expect(out.vectors[1]?.[0]).toBe(0.22); // input[1]
    expect(out.tokens).toBe(42);
  });

  it("requests the Version-1 model + dimension and forwards the abort signal", async () => {
    mockCreate.mockResolvedValue({ data: [{ index: 0, embedding: vec(0.3) }], usage: { total_tokens: 3 } });
    const ctrl = new AbortController();
    await provider.embed(["x"], { signal: ctrl.signal });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "text-embedding-3-small", input: ["x"], dimensions: 1536 }),
      expect.objectContaining({ signal: ctrl.signal }),
    );
  });

  it("throws EmbeddingDimensionError when the API returns a wrong-length vector", async () => {
    mockCreate.mockResolvedValue({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], usage: { total_tokens: 3 } });
    await expect(provider.embed(["x"])).rejects.toThrow(EmbeddingDimensionError);
  });

  it("throws when the API returns the wrong NUMBER of vectors", async () => {
    mockCreate.mockResolvedValue({ data: [{ index: 0, embedding: vec(0.1) }], usage: { total_tokens: 3 } });
    await expect(provider.embed(["a", "b"])).rejects.toThrow(/returned 1 vectors for 2 inputs/);
  });

  it("propagates a rate-limit error (the worker, not the provider, retries)", async () => {
    mockCreate.mockRejectedValue(new Error("429 Too Many Requests"));
    await expect(provider.embed(["x"])).rejects.toThrow(/429/);
  });

  it("propagates an invalid-API-key error (no silent swallow)", async () => {
    mockCreate.mockRejectedValue(new Error("401 Incorrect API key provided"));
    await expect(provider.embed(["x"])).rejects.toThrow(/401/);
  });
});

// =====================================================================
// 8. Deterministic provider — the offline plug-in (local / CI / bench)
// =====================================================================

describe("getEmbeddingProvider — the deterministic offline provider (config swap)", () => {
  const ENV = ["MEMORY_EMBEDDING_PROVIDER", "OPENAI_API_KEY"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("selects the deterministic provider by name — WITHOUT any API key", () => {
    // The whole point: it runs offline, so it is configured even though no
    // OPENAI_API_KEY (or any other key) is present. Proves "a new provider is a
    // configuration swap, not a Memory-Engine change".
    process.env.MEMORY_EMBEDDING_PROVIDER = "deterministic";
    const p = getEmbeddingProvider();
    expect(p).not.toBeNull();
    expect(p?.info.provider).toBe("deterministic");
    expect(p?.info.model).toBe("hash-v1");
    expect(p?.info.dimension).toBe(1536);
    expect(isEmbeddingConfigured()).toBe(true);
  });

  it("accepts the 'hash' alias too, case/space-insensitively", () => {
    process.env.MEMORY_EMBEDDING_PROVIDER = "  Hash  ";
    expect(getEmbeddingProvider()?.info.provider).toBe("deterministic");
  });

  it("its version equals embeddingVersion(info) — versioned like any provider", () => {
    process.env.MEMORY_EMBEDDING_PROVIDER = "deterministic";
    expect(getEmbeddingProvider()?.info.version).toBe(
      embeddingVersion({ provider: "deterministic", model: "hash-v1", dimension: 1536 }),
    );
  });

  it("is NOT the production default (default stays openai → null without a key)", () => {
    // No MEMORY_EMBEDDING_PROVIDER, no key → still null. Adding the offline
    // provider must never change the default behaviour.
    expect(getEmbeddingProvider()).toBeNull();
  });
});

describe("deterministic provider.embed — stable, sound, offline", () => {
  const provider = createDeterministicEmbeddingProvider();

  it("returns an empty result for an empty batch", async () => {
    const out = await provider.embed([]);
    expect(out).toEqual({ vectors: [], model: "hash-v1", dimension: 1536, tokens: 0 });
  });

  it("produces 1536-d, all-finite, UNIT-LENGTH vectors", async () => {
    const { vectors } = await provider.embed(["the quick brown fox"]);
    const v = vectors[0]!;
    expect(v).toHaveLength(1536);
    expect(v.every((n) => Number.isFinite(n))).toBe(true);
    const norm = Math.sqrt(v.reduce((s, n) => s + n * n, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(() => assertValidEmbedding(v, 1536)).not.toThrow();
  });

  it("is DETERMINISTIC: identical text ⇒ identical vector (idempotency + dedupe)", async () => {
    const a = (await provider.embed(["same text"])).vectors[0]!;
    const b = (await provider.embed(["same text"])).vectors[0]!;
    expect(a).toEqual(b);
  });

  it("distinct text ⇒ distinct vector (so candidates are separable)", async () => {
    const a = (await provider.embed(["alpha"])).vectors[0]!;
    const b = (await provider.embed(["beta"])).vectors[0]!;
    expect(a).not.toEqual(b);
  });

  it("preserves batch order and counts tokens (~chars/4, never billed)", async () => {
    const out = await provider.embed(["a", "bb", "cccc"]);
    expect(out.vectors).toHaveLength(3);
    expect(out.vectors[0]).toEqual((await provider.embed(["a"])).vectors[0]);
    expect(out.tokens).toBe(estimateTokens("a") + estimateTokens("bb") + estimateTokens("cccc"));
  });
});
