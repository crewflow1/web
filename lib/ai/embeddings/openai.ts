import "server-only";

/**
 * Shared Memory — OpenAI embedding provider ("Version 1").
 *
 * CEO Directive 009 Module 1, PR4. This is ONE implementation of
 * `EmbeddingProvider`, not the engine's dependency: the Memory Engine never
 * imports this file — it asks the factory (`./index`) for "a provider" and
 * gets whatever configuration selects. Swapping vendors adds a sibling file
 * and a factory branch; recall and the worker do not change.
 *
 * Model: `text-embedding-3-small`, 1536-d. The `openai` SDK is dynamically
 * imported so it never enters a bundle that doesn't embed (mirrors
 * `lib/ai/llm.ts`). `embed()` THROWS on failure — the worker owns retry,
 * backoff, dead-letter, and failure-reason recording.
 */

import type {
  EmbeddingCallOptions,
  EmbeddingModelInfo,
  EmbeddingProvider,
  EmbeddingResult,
} from "./types";
import { assertValidEmbedding, embeddingVersion } from "./versioning";

const MODEL = "text-embedding-3-small";
const DIMENSION = 1536;

/**
 * 20s. Generous vs. `llm.ts`'s 8s because a batch of embeddings is larger
 * than a 3-sentence summary, and the worker runs on the Node runtime
 * (maxDuration 60s) rather than inline in a request.
 */
const EMBED_TIMEOUT_MS = 20_000;

/**
 * Build the OpenAI provider for a given key. Pure construction — no network
 * call here, so the factory can hand one out cheaply and the worker reuses it
 * across a batch.
 */
export function createOpenAiEmbeddingProvider(apiKey: string): EmbeddingProvider {
  const info: EmbeddingModelInfo = {
    provider: "openai",
    model: MODEL,
    dimension: DIMENSION,
    version: embeddingVersion({ provider: "openai", model: MODEL, dimension: DIMENSION }),
  };

  return {
    info,
    async embed(texts: string[], opts?: EmbeddingCallOptions): Promise<EmbeddingResult> {
      // Empty batch: never touch the network (deterministic, free).
      if (texts.length === 0) {
        return { vectors: [], model: MODEL, dimension: DIMENSION, tokens: 0 };
      }

      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey });

      const res = await client.embeddings.create(
        { model: MODEL, input: texts, dimensions: DIMENSION },
        { signal: opts?.signal ?? AbortSignal.timeout(EMBED_TIMEOUT_MS) },
      );

      // The API returns rows tagged with their input `index`; sort defensively
      // so vectors line up with `texts` regardless of response ordering.
      const ordered = [...res.data].sort((a, b) => a.index - b.index);
      if (ordered.length !== texts.length) {
        throw new Error(
          `openai embeddings returned ${ordered.length} vectors for ${texts.length} inputs`,
        );
      }

      const vectors = ordered.map((d) => {
        const v = d.embedding as number[];
        // Guard the ANN index from a truncated/wrong-model/NaN vector.
        assertValidEmbedding(v, DIMENSION);
        return v;
      });

      const tokens = res.usage?.total_tokens ?? res.usage?.prompt_tokens ?? 0;
      return { vectors, model: MODEL, dimension: DIMENSION, tokens };
    },
  };
}
