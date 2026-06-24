import "server-only";

/**
 * Shared Memory — text-generation provider factory (the plug-in seam).
 *
 * CEO Directive 009 Module 1, PR5. This is the ONE place that knows which LLM
 * vendor is active for the lifecycle reducers. Everything upstream (the
 * lifecycle worker) asks `getTextProvider()` for "a provider" and gets `null`
 * when nothing is configured. That null is the whole graceful-degradation
 * contract — identical to the embedding seam:
 *
 *   - provider present → summarisation + consolidation refinement switch on.
 *   - provider null    → those reducers are simply skipped; the deterministic
 *     SQL digest / existing summary stays in place, and every other lifecycle
 *     reducer (expiry, decay archival, dedup, eviction) keeps working. The
 *     application cannot tell the difference, and no application code changes
 *     either way.
 *
 * Selecting a provider is CONFIGURATION ONLY: `MEMORY_TEXT_PROVIDER` names the
 * vendor (default "auto" — prefer Anthropic, else OpenAI); the vendor's own key
 * gates it. Adding Google / Azure / a local model is a branch here plus a
 * sibling provider file — never a change to the Memory Engine.
 */

import type { TextProvider } from "./types";
import { createAnthropicTextProvider } from "./anthropic";
import { createOpenAiTextProvider } from "./openai";

export type { TextProvider, TextResult, TextModelInfo, TextGenerationOptions } from "./types";
export { textCostUsd } from "./cost";

/**
 * Resolve the configured text provider, or `null` when none is usable.
 *
 * Never throws: an unknown provider name or a missing key degrades to `null`
 * (LLM-assisted reducers off) rather than crashing the worker. Construction is
 * cheap and network-free, so callers may call this per tick.
 *
 * Default "auto" mirrors `lib/ai/llm.ts`: prefer Anthropic (Haiku) when its key
 * is set, else OpenAI when its key is set, else null.
 */
export function getTextProvider(): TextProvider | null {
  const name = (process.env.MEMORY_TEXT_PROVIDER ?? "auto").trim().toLowerCase();

  switch (name) {
    case "auto": {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (anthropicKey) return createAnthropicTextProvider(anthropicKey);
      const openaiKey = process.env.OPENAI_API_KEY;
      if (openaiKey) return createOpenAiTextProvider(openaiKey);
      return null;
    }

    case "anthropic": {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return null;
      return createAnthropicTextProvider(key);
    }

    case "openai": {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return null;
      return createOpenAiTextProvider(key);
    }

    // Future providers slot in here — configuration only:
    //   case "google":  ...
    //   case "azure-openai": ...
    //   case "local":   ...

    case "":
    case "none":
    case "off":
    case "disabled":
      return null;

    default:
      // Unknown name → degrade, don't crash. LLM-assisted reducers stay off
      // until the configuration is corrected.
      console.warn(
        `[ai/text] unknown MEMORY_TEXT_PROVIDER="${name}" — LLM text generation disabled`,
      );
      return null;
  }
}

/**
 * Cheap presence check, mirroring `isEmbeddingConfigured()`. True iff a usable
 * text provider is configured right now.
 */
export function isTextConfigured(): boolean {
  return getTextProvider() !== null;
}
