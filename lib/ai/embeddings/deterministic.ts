import "server-only";

/**
 * Shared Memory — DETERMINISTIC offline embedding provider (local / CI / bench).
 *
 * CEO Directive 009 Module 1. This is a second concrete `EmbeddingProvider`
 * implementation whose entire purpose is to let the FULL embedding pipeline —
 * the queue claim → embed → store → ANN recall loop — run with ZERO network and
 * ZERO API key, so it can be exercised on a local Docker Supabase, in CI, and in
 * the performance benchmark harness. It is the living proof of the plug-in rule:
 * "a new provider is a configuration swap, not a Memory-Engine change."
 *
 *   MEMORY_EMBEDDING_PROVIDER=deterministic   (default stays "openai")
 *
 * WHAT IT IS: a stable hash → vector function. The same text ALWAYS yields the
 * same 1536-d unit vector, and identical text yields identical vectors — so
 * re-embed idempotency (checksum match) and near-duplicate detection (cosine ≈ 0
 * for identical bodies) behave exactly as they do with a real provider.
 *
 * WHAT IT IS NOT: semantically meaningful. Two paraphrases are NOT close in this
 * space — only the MECHANICS (queue throughput, latency, versioning, cost
 * ledger, ANN index population, crash/lease recovery) are faithful, never
 * retrieval QUALITY. It must NEVER be selected in production. Cost is genuinely
 * zero (no pricing row), which the worker records as unknown/0 — accurate here.
 */

import { createHash } from "node:crypto";
import type {
  EmbeddingModelInfo,
  EmbeddingProvider,
  EmbeddingResult,
} from "./types";
import { assertValidEmbedding, embeddingVersion, estimateTokens } from "./versioning";

const MODEL = "hash-v1";
const DIMENSION = 1536;

/**
 * mulberry32 — a tiny, fast, fully deterministic 32-bit PRNG. Seeded from the
 * text's digest, it gives a reproducible stream of draws with no platform
 * dependence (pure integer math), so a vector is identical on every machine.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fold the SHA-256 digest of the text into a single 32-bit seed by XOR-ing its
 * eight 32-bit words. Deterministic, and spreads the full digest's entropy into
 * the seed so distinct texts almost never collide (and a collision only repeats
 * a vector — never a correctness fault).
 */
function seedFromText(text: string): number {
  const hex = createHash("sha256").update(text, "utf8").digest("hex");
  let seed = 0;
  for (let i = 0; i < 8; i++) {
    seed = (seed ^ (parseInt(hex.slice(i * 8, i * 8 + 8), 16) | 0)) | 0;
  }
  return seed >>> 0;
}

/** text → seed → 1536 draws in [-1,1) → L2-normalised unit vector. */
function embedOne(text: string): number[] {
  const rand = mulberry32(seedFromText(text));
  const v = new Array<number>(DIMENSION);
  let sumSq = 0;
  for (let i = 0; i < DIMENSION; i++) {
    const x = rand() * 2 - 1;
    v[i] = x;
    sumSq += x * x;
  }
  // Normalise to unit length (never divide by zero — a 1536-draw vector is
  // effectively never all-zero, but guard anyway so the output is always sound).
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < DIMENSION; i++) v[i] = (v[i] as number) / norm;
  return v;
}

/**
 * Build the deterministic provider. Pure construction (no I/O), so the factory
 * hands one out cheaply and the worker reuses it across a batch — same shape as
 * `createOpenAiEmbeddingProvider`.
 */
export function createDeterministicEmbeddingProvider(): EmbeddingProvider {
  const info: EmbeddingModelInfo = {
    provider: "deterministic",
    model: MODEL,
    dimension: DIMENSION,
    version: embeddingVersion({ provider: "deterministic", model: MODEL, dimension: DIMENSION }),
  };

  return {
    info,
    // No `opts` param: the offline provider has no network call to abort, and
    // the interface's options are optional, so an implementation may omit them.
    async embed(texts: string[]): Promise<EmbeddingResult> {
      // Empty batch: free, no work (mirrors every provider's contract).
      if (texts.length === 0) {
        return { vectors: [], model: MODEL, dimension: DIMENSION, tokens: 0 };
      }
      let tokens = 0;
      const vectors = texts.map((t) => {
        tokens += estimateTokens(t);
        const vec = embedOne(t);
        // Same guard the worker relies on for any provider — a corrupt vector is
        // dead-lettered, never indexed. Here it can only ever pass.
        assertValidEmbedding(vec, DIMENSION);
        return vec;
      });
      return { vectors, model: MODEL, dimension: DIMENSION, tokens };
    },
  };
}
