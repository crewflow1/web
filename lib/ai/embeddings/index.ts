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
 *
 * ONE exception to "configuration selects": the deterministic/hash provider is
 * a dev/CI/bench tool and REFUSES in any production runtime (see
 * `isProductionRuntime` below) — configuration can never select it where its
 * meaningless vectors could reach the real corpus.
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
 * Affirmative production detection for the deterministic lockdown below.
 *
 * TWO signals, EITHER sufficient to refuse:
 *   - `VERCEL_ENV === "production"` — the Vercel deployment truth, set by the
 *     platform itself (never by an operator), per the posture in
 *     app/api/dev/test-login/route.ts.
 *   - `NODE_ENV === "production"` — what `next build`/`next start` bakes into
 *     EVERY deployed build, on Vercel or anywhere else. This deliberately also
 *     covers Vercel PREVIEW deployments (NODE_ENV is "production" there too),
 *     which point at the single production Supabase and must be refused for
 *     the same reason.
 *
 * Neither signal is operator-set on a deployed build, so no env typo can
 * configure the refusal away. Everything the deterministic provider exists for
 * stays non-production: `next dev` (NODE_ENV=development), vitest/CI
 * (NODE_ENV=test), and the tsx bench harness (scripts/memory-bench.ts —
 * NODE_ENV unset).
 */
function isProductionRuntime(): boolean {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}

/**
 * Resolve the configured embedding provider, or `null` when none is usable.
 *
 * Never throws: an unknown provider name, a missing key, or a selection that
 * is forbidden in this runtime (the deterministic provider in production)
 * degrades to `null` (semantic search off) rather than crashing the recall
 * path. Construction is cheap and network-free, so callers may call this per
 * request.
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
      // PRODUCTION LOCKDOWN (P1, remediation wave A). The provider's own header
      // says it must NEVER be selected in production: its vectors are stable
      // hashes with no semantic content, so one env typo on a deploy would fill
      // the ARMED corpus with meaningless-but-valid vectors that recall would
      // then rank with a straight face. Before this guard, the env VALUE alone
      // selected it here, OUTSIDE the activation gate (the deterministic branch
      // is deliberately ungoverned — zero egress, zero cost). Fail CLOSED in
      // the factory's existing degradation shape: loud log + null (semantic
      // search off, every other recall channel unaffected) — never construct.
      if (isProductionRuntime()) {
        console.error(
          `[ai/embeddings] MEMORY_EMBEDDING_PROVIDER="${name}" selects the deterministic/` +
            "hash provider, which must NEVER run in production (its vectors are " +
            "semantically meaningless and would poison the corpus) — refusing; " +
            "semantic search disabled until the configuration is corrected",
        );
        return null;
      }
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
