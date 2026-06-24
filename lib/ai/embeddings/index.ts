import "server-only";

/**
 * Shared Memory — embedding provider factory (the plug-in seam).
 *
 * CEO Directive 009 Module 1, PR4. This is the ONE place that knows which
 * vendor is active. Everything upstream (recall, the worker) asks
 * `getEmbeddingProvider()` for "a provider" and gets `null` when nothing is
 * configured. That null is the whole graceful-degradation contract:
 *
 *   - provider present → semantic recall + the embedding worker switch on.
 *   - provider null    → semantic search is simply unavailable; permission
 *     filtering, lexical recall, structural recall, ranking, diversification,
 *     and assembly all keep working. The application cannot tell the
 *     difference, and no application code changes either way.
 *
 * Selecting a provider is CONFIGURATION ONLY: `MEMORY_EMBEDDING_PROVIDER`
 * names the vendor (default "openai"); the vendor's own key gates it. Adding
 * Anthropic / Google / Azure / Voyage / a local model is a branch here plus a
 * sibling provider file — never a change to the Memory Engine.
 */

import type { EmbeddingProvider } from "./types";
import { createOpenAiEmbeddingProvider } from "./openai";
import { createDeterministicEmbeddingProvider } from "./deterministic";

export type { EmbeddingProvider, EmbeddingResult, EmbeddingModelInfo, EmbeddingStatus } from "./types";
export {
  embeddingVersion,
  embeddingChecksum,
  embeddingCostUsd,
  estimateTokens,
  isValidEmbedding,
  assertValidEmbedding,
  EmbeddingDimensionError,
  EMBEDDING_SCHEMA_REVISION,
} from "./versioning";

/**
 * Resolve the configured embedding provider, or `null` when none is usable.
 *
 * Never throws: an unknown provider name or a missing key degrades to `null`
 * (semantic search off) rather than crashing the recall path. Construction is
 * cheap and network-free, so callers may call this per request.
 */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  const name = (process.env.MEMORY_EMBEDDING_PROVIDER ?? "openai").trim().toLowerCase();

  switch (name) {
    case "openai": {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return null;
      return createOpenAiEmbeddingProvider(key);
    }

    // A DETERMINISTIC, offline, network-free provider for local dev, CI, and
    // the performance benchmark harness. Never semantically meaningful — it
    // exercises the full queue→embed→store→ANN loop with no API key. Opt-in
    // only; the production default above is unaffected. (See ./deterministic.)
    case "deterministic":
    case "hash":
      return createDeterministicEmbeddingProvider();

    // Future real providers slot in here — configuration only:
    //   case "anthropic": ...
    //   case "voyage":    ...
    //   case "azure-openai": ...
    //   case "local":     ...

    case "":
    case "none":
    case "off":
    case "disabled":
      return null;

    default:
      // Unknown name → degrade, don't crash. Semantic search stays off until
      // the configuration is corrected.
      console.warn(
        `[ai/embeddings] unknown MEMORY_EMBEDDING_PROVIDER="${name}" — semantic search disabled`,
      );
      return null;
  }
}

/**
 * Cheap presence check, mirroring `isAiConfigured()` in `lib/ai/safety.ts`.
 * True iff a usable embedding provider is configured right now.
 */
export function isEmbeddingConfigured(): boolean {
  return getEmbeddingProvider() !== null;
}
