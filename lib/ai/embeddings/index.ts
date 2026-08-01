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
import { isEmbeddingActivated } from "@/lib/ai/governor/readiness";
import { TIER_MODEL } from "@/lib/ai/governor/registry";
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
      // THE AUTHORISATION — a key is not permission to spend; a bound
      // `embedding` tier is (lib/ai/governor/registry.ts TIER_MODEL). This is
      // the same closure the text and vision doors already have: before it,
      // OPENAI_API_KEY alone selected a PAID provider here, which made
      // embeddings the last key-only activation in the build. The
      // deterministic branch below is deliberately NOT behind this gate — it
      // is zero-egress, zero-cost compute, and CI depends on it.
      if (!isEmbeddingActivated()) return null;
      const key = process.env.OPENAI_API_KEY;
      if (!key) return null;
      // The binding is the model authority. This provider embeds a fixed
      // model; if the bound model ever disagrees, refuse rather than bill a
      // model the registry did not authorise.
      const bound = TIER_MODEL.embedding;
      const provider = createOpenAiEmbeddingProvider(key);
      if (bound && bound.model !== provider.info.model) {
        console.error(
          `[ai/embeddings] bound model "${bound.model}" ≠ provider model ` +
            `"${provider.info.model}" — refusing (fix the binding or the provider)`,
        );
        return null;
      }
      return provider;
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
 * Cheap presence check. True iff a usable embedding provider is configured
 * right now — which, since the embeddings-governance closure, means
 * AUTHORISED as well as configured: a vendor key with no bound `embedding`
 * tier answers false, because the paid branch can produce no provider. Only
 * the deterministic (zero-cost, zero-egress) provider answers true without a
 * binding.
 */
export function isEmbeddingConfigured(): boolean {
  return getEmbeddingProvider() !== null;
}
