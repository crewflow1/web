import "server-only";

/**
 * Shared Memory — text-generation provider factory (the plug-in seam).
 *
 * CEO Directive 009 Module 1, PR5. This is the ONE place that knows which LLM
 * vendor is active for the lifecycle reducers. Everything upstream (the
 * lifecycle worker) asks `getTextProvider("mid")` for "a provider" and gets `null`
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
 *
 * CONFIGURATION SELECTS THE VENDOR; THE GOVERNOR AUTHORISES THE CALL.
 * ------------------------------------------------------------------
 * Those are two different questions, and this factory used to answer only the
 * first. A key in the environment was sufficient to hand back a live provider,
 * which meant `ANTHROPIC_API_KEY` on a deploy silently switched on every caller
 * of this door — the /insights narrative and question box, HQ drafts, memory
 * summarisation and the receptionist's conversation engine — at a time when
 * every cost tier in lib/ai/governor/registry.ts still maps to NO model. The
 * calls ran, the money left the account, and the £100/org/month ceiling never
 * saw them, because `invokeWithGovernor` is a deliberate pass-through while
 * nothing is bound.
 *
 * So the factory now asks BOTH questions, and the second one first-class:
 * `isGovernorActivated()` requires a MODEL BINDING in this build as well as the
 * vendor credential. Unbound ⇒ `null` ⇒ every caller's existing
 * graceful-degradation leg, which is the leg production has always run.
 *
 * This costs nothing where it matters and closes the only thing that did. In
 * production and in CI no credential is set, so the answer was `null` before and
 * is `null` now. The single configuration whose behaviour changes is "a key is
 * present while no tier is bound" — which is not a configuration anyone chose,
 * it is the drift the readiness surface has been shouting about, and the
 * behaviour it used to produce was unmetered spend.
 */

import type { TextProvider } from "./types";
import { TIER_MODEL, type AiTier } from "@/lib/ai/governor/registry";
import { isTierActivated } from "@/lib/ai/governor/readiness";
import { createAnthropicTextProvider } from "./anthropic";
import { createOpenAiTextProvider } from "./openai";

/** The generative tiers this door can serve (embedding/transcription have their own doors). */
export type InferenceTier = Extract<AiTier, "cheap" | "mid" | "high">;

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
 *
 * `null` ALSO when the governor is not activated — see the module note. That
 * check is deliberately FIRST: it is the cheapest, it is the one a stray
 * credential cannot satisfy, and putting it after the vendor branches would mean
 * a provider object briefly exists for a call that must never happen.
 */
// tier is REQUIRED, deliberately: a defaulted "mid" silently re-created the
// execution/accounting divergence for the next cheap/high caller — a missing
// argument must be a compile error, not a 2x mispricing.
export function getTextProvider(tier: InferenceTier): TextProvider | null {
  // THE AUTHORISATION. A vendor key is not permission to spend; a bound cost
  // tier is. Nothing below can be reached without one.
  // PER-TIER (activation diff 2026-09-10): the caller's OWN tier must be
  // bound, and the provider is constructed with THAT tier's model — the old
  // any-inference-tier gate + hard-coded default model meant a mid caller
  // could run the cheap model while being priced at the mid binding, the
  // execution/accounting divergence this diff closes across the whole door.
  const binding = TIER_MODEL[tier];
  if (!binding || !isTierActivated(tier)) return null;

  const name = (process.env.MEMORY_TEXT_PROVIDER ?? "auto").trim().toLowerCase();

  switch (name) {
    case "auto": {
      // The BINDING chooses the vendor; env keys only supply credentials.
      if (binding.provider === "anthropic") {
        const key = process.env.ANTHROPIC_API_KEY;
        return key ? createAnthropicTextProvider(key, binding.model) : null;
      }
      if (binding.provider === "openai") {
        const key = process.env.OPENAI_API_KEY;
        return key ? createOpenAiTextProvider(key, binding.model) : null;
      }
      return null;
    }

    case "anthropic": {
      if (binding.provider !== "anthropic") return null; // never run a different vendor's model name
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return null;
      return createAnthropicTextProvider(key, binding.model);
    }

    case "openai": {
      if (binding.provider !== "openai") return null;
      const key = process.env.OPENAI_API_KEY;
      if (!key) return null;
      return createOpenAiTextProvider(key, binding.model);
    }

    // Future providers slot in here — configuration only:
    //   case "google":  ...
    //   case "azure-openai": ...
    //   case "local":   ...

    // NOTE (activation review): this switch silences the TEXT DOOR only —
    // the vision door (AI_VISION_PROVIDER) and the three governed direct-SDK
    // legs (lead summary, receptionist extraction, research) do not read it.
    // The ESTATE kill switches are: unset ANTHROPIC_API_KEY (immediate) or
    // revert TIER_MODEL (reviewed diff). Documented in
    // docs/launch/PRODUCTION-ACTIVATION-MATRIX.md.
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
 * text provider is configured right now — which, since the governance closure,
 * means AUTHORISED as well as configured: a vendor key with no bound cost tier
 * answers false, because it can produce no provider.
 */
/** NOTE: answers for the MID (drafting) tier specifically — the tier every
 *  UI gate that calls this guards. */
export function isTextConfigured(): boolean {
  return getTextProvider("mid") !== null;
}
