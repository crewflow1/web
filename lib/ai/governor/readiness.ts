/**
 * AI Cost Governor — activation readiness.
 *
 * A direct mirror of lib/comms/readiness.ts, and for the same reason. That
 * module exists because WhatsApp once reported `configured: true` from two
 * environment variables at a time when the build contained NO WhatsApp sender —
 * a green light over a dead path, which is worse than no light at all because
 * it suppresses the alert that would have caught the misconfiguration.
 *
 * AI has the identical failure mode waiting for it, with a bigger blast radius:
 * setting `ANTHROPIC_API_KEY` on a deploy would make any naive `isAiConfigured()`
 * check answer "yes, AI is on" while every cost tier still maps to `null` and no
 * governed call can reach a model. Worse, the inverse mistake is expensive
 * rather than merely silent — a surface that believes AI is live may stop
 * rendering its deterministic fallback.
 *
 * So readiness is decomposed into things that are independently, verifiably true:
 *
 *   modelBindingPresent — a tier maps to a real model.          (build-time fact)
 *   credentialsPresent  — the vendor secret is set.             (configuration)
 *   providerResolvable  — both of the above.                    (the seam)
 *   activated           — THE headline: a governed call CAN reach a provider.
 *
 * The load-bearing rule, inherited verbatim from the comms incident:
 * **`activated` can NEVER be true without `modelBindingPresent`.** No amount of
 * environment configuration can manufacture a capability that this build does
 * not contain.
 *
 * AND THE RULE IS NOW ENFORCED, NOT MERELY REPORTED. `isGovernorActivated()`
 * below is the gate on BOTH provider doors in the build — the text factory
 * (lib/ai/text) and the vision factory (lib/ai/vision) — so a vendor key with no
 * bound tier hands back no provider anywhere. Before that, this module answered
 * "not activated" perfectly correctly while seven call sites went ahead on the
 * strength of the key alone; a readiness surface that is right about a fact
 * nothing consults is the same false green in a different costume.
 *
 * Reads `process.env` DIRECTLY, imports no SDK and no `server-only` module, and
 * CAN NEVER THROW — a readiness probe must always answer.
 */

import {
  AI_TIERS,
  INFERENCE_TIERS,
  TIER_MODEL,
  isAnyTierBound,
  type AiTier,
} from "./registry";

const present = (v: string | undefined | null): boolean =>
  typeof v === "string" && v.trim().length > 0;

/**
 * Vendor id → the environment variable holding its credential. A hand-maintained
 * mirror of the key lookups in lib/ai/text/index.ts; the security suite pins
 * that this map introduces no NEW credential name.
 */
const VENDOR_CREDENTIAL: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export type AiTierReadiness = {
  tier: AiTier;
  /** A concrete provider+model is bound to this tier in this build. */
  modelBindingPresent: boolean;
  /** The bound vendor's credential is set. Meaningless while nothing is bound. */
  credentialsPresent: boolean;
  /** Both of the above — this tier could actually reach a model. */
  providerResolvable: boolean;
  /** The vendor this tier would use, or null while unbound. */
  provider: string | null;
  /** The model this tier would use, or null while unbound. */
  model: string | null;
  /** Everything standing between this tier and activation. Empty ⇒ ready. */
  blockers: string[];
};

export type AiGovernorReadiness = {
  /**
   * THE honest headline: can ANY governed call reach a provider right now?
   * `false` today. Never true without a model binding.
   */
  activated: boolean;
  /** Build-time fact: at least one tier maps to a real model. */
  anyTierBound: boolean;
  tiers: ReadonlyArray<AiTierReadiness>;
  /** The full activation checklist, deduplicated across tiers. Empty ⇒ activated. */
  blockers: string[];
  /** Vendor credentials present in this environment, by variable name. */
  credentialsPresent: ReadonlyArray<string>;
  /**
   * A vendor credential is set AND some inference path could reach a provider
   * without passing through the governor.
   *
   * THIS IS NOW FALSE BY CONSTRUCTION, and the construction is the point.
   *
   * It used to be `credentialsPresent && !anyTierBound`, because several call
   * sites predated the seam and gated themselves on a bare key check
   * (`isAiConfigured()`, or `getTextProvider()` — which was the same question
   * asked in a nicer voice). A credential appearing on a deploy would let those
   * paths reach a provider while every tier here was still `null` and the
   * governor was a pass-through: spend with no ceiling and no ledger entry.
   *
   * That is closed. Every provider door in the build — the text factory
   * (lib/ai/text) and the vision factory (lib/ai/vision) — now requires
   * `isGovernorActivated()`, which requires a MODEL BINDING and not merely a
   * key. A credential on its own therefore yields no provider at any door, so
   * there is no ungoverned path left for it to switch on, and
   * `AI_UNGOVERNED_INFERENCE_ENTRY_POINTS` records that as a number the security
   * suite pins at zero rather than as a claim in a comment.
   *
   * IT IS DERIVED, NOT HARD-CODED. If the count is ever raised — the only
   * honest way to add a path that gates on a bare key again — this goes amber
   * again on its own, and the ratchet
   * (__tests__/security/ai-governance-closure.test.ts) fails first.
   *
   * EMBEDDINGS ARE NOW INSIDE THIS BOUNDARY (they were the stated exception
   * here until migration 20261080). `lib/ai/embeddings` no longer hands back a
   * paid provider on `OPENAI_API_KEY` alone: its door requires
   * `isEmbeddingActivated()` — a bound `embedding` tier, not a key — and both
   * embedding call sites (the memory worker and HQ recall's query embed) run
   * through `invokeWithGovernor` under the `embedding` task class, which the
   * ledger's CHECK now admits. The one deliberate exemption is the
   * DETERMINISTIC embedding provider (CI/dev): zero egress, zero cost, no
   * vendor — there is nothing to govern, and the ratchet pins that it is the
   * only path that may bypass the door.
   */
  ungovernedCredentialRisk: boolean;
};

/**
 * How many inference entry points in this build reach a provider WITHOUT going
 * through `invokeWithGovernor`, or gate themselves on a bare vendor credential
 * instead of on governor activation.
 *
 * ZERO. It was seven: the /insights narrative and question box, HQ drafts,
 * memory summarisation, import OCR, the lead summary, and HQ research. (The
 * audit found five; sweeping for provider-SDK constructions rather than for
 * `isAiConfigured()` gates found the other two.)
 *
 * A NUMBER, not a boolean, and exported rather than inlined, for one reason:
 * `__tests__/security/ai-governance-closure.test.ts` derives the same figure
 * from the SOURCE TEXT — every provider-SDK construction and every bare
 * credential gate outside the governor's own doors — and asserts the two agree.
 * So this constant cannot drift from reality without a test failing, and raising
 * it is a visible, deliberate act in a diff rather than an emergent property of
 * someone adding a file.
 */
export const AI_UNGOVERNED_INFERENCE_ENTRY_POINTS = 0;

/** Every vendor credential this build knows about, present or not. */
export const KNOWN_VENDOR_CREDENTIALS: ReadonlyArray<string> =
  Object.values(VENDOR_CREDENTIAL);

/**
 * Compose one tier's readiness. Exported so a test can assert the invariant
 * directly — pass a binding with its credential satisfied and `bound: false`,
 * and `providerResolvable` must still be false — rather than inferring it from
 * whichever tiers happen to be dark today.
 */
export function composeTierReadiness(input: {
  tier: AiTier;
  /** The tier's binding, or null when this build binds nothing to it. */
  binding: { provider: string; model: string } | null;
  /** Override the credential lookup. Testing only. */
  credentialPresent?: boolean;
}): AiTierReadiness {
  const modelBindingPresent = input.binding !== null;
  const envVar = input.binding ? VENDOR_CREDENTIAL[input.binding.provider] : undefined;
  const credentialsPresent =
    input.credentialPresent ?? (envVar !== undefined && present(process.env[envVar]));

  // The invariant: no binding ⇒ NEVER resolvable, whatever the environment says.
  const providerResolvable = modelBindingPresent && credentialsPresent;

  const blockers: string[] = [];
  if (!modelBindingPresent) {
    blockers.push(`no model bound to the '${input.tier}' tier in this build`);
  } else if (envVar === undefined) {
    blockers.push(`no known credential for vendor '${input.binding?.provider}'`);
  } else if (!credentialsPresent) {
    blockers.push(envVar);
  }

  return {
    tier: input.tier,
    modelBindingPresent,
    credentialsPresent,
    providerResolvable,
    provider: providerResolvable ? (input.binding?.provider ?? null) : null,
    model: providerResolvable ? (input.binding?.model ?? null) : null,
    blockers,
  };
}

/** One call for the full governor activation snapshot (HQ, health checks, tests). */
export function getAiGovernorReadiness(): AiGovernorReadiness {
  const tiers = AI_TIERS.map((tier) =>
    composeTierReadiness({ tier, binding: TIER_MODEL[tier] }),
  );
  const blockers = [...new Set(tiers.flatMap((t) => t.blockers))];
  const anyTierBound = isAnyTierBound();
  const credentialsPresent = KNOWN_VENDOR_CREDENTIALS.filter((v) => present(process.env[v]));
  return {
    // "Activated" means CAN REACH A MODEL, not "a key is set".
    activated: tiers.some((t) => t.providerResolvable),
    anyTierBound,
    tiers,
    blockers,
    credentialsPresent,
    // A credential can only be a RISK if something would act on it outside the
    // governor. Nothing does — see the field's own note and the pinned count.
    ungovernedCredentialRisk:
      credentialsPresent.length > 0 &&
      !anyTierBound &&
      AI_UNGOVERNED_INFERENCE_ENTRY_POINTS > 0,
  };
}

/**
 * Cheap predicate for the hot path: is ANY governed call able to reach a
 * provider? `invokeWithGovernor` consults per-tier readiness (below) and, when
 * the call's own tier is dark, runs the caller's existing degraded path without
 * a single database read — which is why wiring the governor into a dark seam
 * changes nothing that a user or a bill can observe.
 */
export function isGovernorActivated(): boolean {
  return getAiGovernorReadiness().activated;
}

/**
 * Is ONE specific tier able to reach a provider — binding AND credential?
 *
 * The per-modality question the door gates actually need. The global
 * `isGovernorActivated()` answers "could this build spend at all", which is
 * the wrong gate for a door: with more than one modality in the registry,
 * "some tier somewhere is bound" must not open a door whose own tier is dark.
 * (Concretely: binding an embedding model must not let `getTextProvider()`
 * hand out a text provider on a bare ANTHROPIC_API_KEY, and vice versa.)
 */
export function isTierActivated(tier: AiTier): boolean {
  return composeTierReadiness({ tier, binding: TIER_MODEL[tier] }).providerResolvable;
}

/**
 * Can any GENERATIVE tier (cheap/mid/high) reach a provider? The gate for the
 * text and vision doors — the modality those doors serve.
 */
export function isInferenceTierActivated(): boolean {
  return INFERENCE_TIERS.some((t) => isTierActivated(t));
}

/**
 * Can the embedding tier reach a provider? The gate for the PAID branch of the
 * embedding door (lib/ai/embeddings). The deterministic provider is exempt —
 * zero egress, zero cost — and that exemption is pinned by the ratchet suite.
 */
export function isEmbeddingActivated(): boolean {
  return isTierActivated("embedding");
}
