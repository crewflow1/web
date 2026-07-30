/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI QUOTE WRITER — ACTIVATION READINESS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A direct descendant of lib/comms/readiness.ts (the #433 false-green fix) and
 * lib/ai/governor/readiness.ts, and it exists for the same reason both of those
 * do: a single `enabled` boolean derived from configuration is a LIE whenever
 * the runtime cannot actually perform the capability, and a green light over a
 * dead path is worse than no light, because it suppresses the alarm that would
 * have caught the misconfiguration.
 *
 * The specific failure this prevents: someone sets `ANTHROPIC_API_KEY` on a
 * deploy, a naive `isAiConfigured()` check answers "yes", the quote screen
 * renders a "Draft with AI" button — and the button does nothing, because no
 * tier is bound to a model. An operator concludes the product is broken. The
 * honest alternative is to say, on the screen, exactly what is missing.
 *
 * THE LOAD-BEARING RULE, inherited verbatim:
 * **`available` can NEVER be true without `modelBindingPresent`.**
 * No environment variable can manufacture a capability this build does not have.
 *
 * There is one more decomposition here than the governor needs, and it is the
 * interesting one for this feature:
 *
 *   pipelineImplemented — the schema, prompt, context builder and storage
 *                         EXIST in this build.        (build-time fact — TRUE)
 *   featureRegistered   — `quote.writer_draft` is in the governor's registry, so a
 *                         call could be governed.     (build-time fact — TRUE)
 *   modelBindingPresent — the drafting tier maps to a model.        (FALSE)
 *   credentialsPresent  — the vendor secret is set.        (configuration)
 *   available           — all four. FALSE today.
 *
 * Splitting "built" from "bound" is what lets the dark UI say the true and
 * useful thing — "this is built and waiting on a decision" — rather than the
 * unhelpfully vague "not configured".
 *
 * Reads `process.env` only through the governor's readiness module, imports no
 * SDK and no `server-only`, and CAN NEVER THROW.
 */

import { getAiGovernorReadiness, type AiGovernorReadiness } from "./governor/readiness";
import { featureDefinition, TASK_CLASS_TIER, type AiTier } from "./governor/registry";

/**
 * The governor feature key for quote drafting. ONE literal, exported, so the
 * service, the readiness surface and the tests cannot drift apart — and so a
 * rename is a single visible edit rather than a hunt for a string.
 *
 * Stability note: this value is written to `ai_invocations.feature` and to
 * `ai_quote_drafts` provenance. Renaming it breaks historic telemetry.
 */
export const QUOTE_WRITER_FEATURE = "quote.writer_draft";

/**
 * The task class quote drafting runs as. `drafting` — customer-facing prose a
 * human reviews before it goes anywhere — which is the existing class's exact
 * definition, so no new class was invented.
 *
 * It is NOT `deterministic`: a scope of works is not computable from the
 * inputs. And it is NOT `complex`: a call site cannot promote itself to a more
 * expensive tier, the registry decides, and `invokeWithGovernor` refuses any
 * disagreement.
 */
export const QUOTE_WRITER_TASK_CLASS = "drafting" as const;

/**
 * BUILD-TIME FACT: does this build contain the whole quote-writer pipeline?
 *
 * A hand-maintained mirror of "the modules exist and are wired", in exactly the
 * spirit of `SENDER_IMPLEMENTED` in lib/comms/readiness.ts. It is `true` from
 * the moment this wave lands, because the pipeline genuinely is built — what is
 * missing is the model binding, and conflating the two is the mistake this
 * whole file exists to avoid.
 */
const QUOTE_WRITER_PIPELINE_IMPLEMENTED = true;

export type QuoteWriterReadiness = {
  /**
   * THE headline: can an operator get an AI-drafted quote right now?
   * `false` today. Never true without a model binding.
   */
  available: boolean;
  /** The pipeline exists in this build. True. */
  pipelineImplemented: boolean;
  /** `quote.writer_draft` is a registered governed capability. True. */
  featureRegistered: boolean;
  /** The tier this feature routes to (`mid`, from the `drafting` class). */
  tier: AiTier | null;
  /** A concrete model is bound to that tier in this build. False today. */
  modelBindingPresent: boolean;
  /** The bound vendor's credential is set. Meaningless while nothing is bound. */
  credentialsPresent: boolean;
  /** Everything standing between an operator and a draft. Empty ⇒ available. */
  blockers: string[];
  /**
   * Forwarded from the governor: an inference path in this build could reach a
   * provider on a credential alone, outside the ceiling and the ledger.
   *
   * FALSE by construction since the governance closure — every provider door
   * requires governor activation. It is forwarded rather than dropped so that if
   * such a path is ever added back (which requires raising
   * `AI_UNGOVERNED_INFERENCE_ENTRY_POINTS` in a diff), this screen learns about
   * it for free. The operator-facing "you have a key but no model" hint is NOT
   * this field — see `credentialsPresent` + `modelBindingPresent`, which is what
   * the panel renders, because that hint is about an activation half-done and is
   * useful whether or not anything ungoverned exists.
   */
  ungovernedCredentialRisk: boolean;
};

/**
 * Compose the quote writer's readiness from the governor's.
 *
 * `governor` is injectable so a test can prove the invariant DIRECTLY — hand it
 * a fully activated governor and a missing pipeline, and `available` must still
 * be false — rather than inferring it from whichever tiers happen to be dark
 * today. Production always takes the real reading.
 */
export function getQuoteWriterReadiness(
  governor: AiGovernorReadiness = getAiGovernorReadiness(),
  pipelineImplemented: boolean = QUOTE_WRITER_PIPELINE_IMPLEMENTED,
): QuoteWriterReadiness {
  const featureRegistered = featureDefinition(QUOTE_WRITER_FEATURE) !== null;
  const tier = TASK_CLASS_TIER[QUOTE_WRITER_TASK_CLASS];
  const tierReadiness = tier === null ? null : governor.tiers.find((t) => t.tier === tier) ?? null;

  const modelBindingPresent = tierReadiness?.modelBindingPresent ?? false;
  const credentialsPresent = tierReadiness?.credentialsPresent ?? false;

  const blockers: string[] = [];
  if (!pipelineImplemented) {
    blockers.push("the quote-writer pipeline is not present in this build");
  }
  if (!featureRegistered) {
    blockers.push(
      `'${QUOTE_WRITER_FEATURE}' is not registered in lib/ai/governor/registry.ts, so it cannot be governed`,
    );
  }
  if (tier === null) {
    blockers.push(`task class '${QUOTE_WRITER_TASK_CLASS}' routes to no cost tier`);
  } else if (!modelBindingPresent) {
    blockers.push(`no model bound to the '${tier}' tier in this build`);
  } else if (!credentialsPresent) {
    blockers.push(...(tierReadiness?.blockers ?? []));
  }

  // THE INVARIANT. Every clause is necessary; the binding clause is the one no
  // amount of configuration can satisfy.
  const available =
    pipelineImplemented &&
    featureRegistered &&
    modelBindingPresent &&
    credentialsPresent &&
    (tierReadiness?.providerResolvable ?? false);

  return {
    available,
    pipelineImplemented,
    featureRegistered,
    tier,
    modelBindingPresent,
    credentialsPresent,
    blockers,
    ungovernedCredentialRisk: governor.ungovernedCredentialRisk,
  };
}

/** Cheap predicate for the service's first gate. */
export function isQuoteWriterAvailable(): boolean {
  return getQuoteWriterReadiness().available;
}

/**
 * The one sentence the dark UI shows an operator.
 *
 * Written here rather than in the component so the honest wording lives beside
 * the logic that decides it, and so a test can assert that the dark state never
 * claims to be anything else.
 */
export function quoteWriterStatusLine(readiness: QuoteWriterReadiness): string {
  if (readiness.available) {
    return "AI drafting is active. Every draft is reviewed by you before it becomes a quote.";
  }
  if (readiness.pipelineImplemented && !readiness.modelBindingPresent) {
    return (
      "AI quote drafting is built and switched OFF. No AI model is connected to CrewFlow, " +
      "so nothing is generated and nothing is sent to any third party. Writing a quote works " +
      "exactly as it always has."
    );
  }
  return "AI quote drafting is unavailable in this build.";
}
