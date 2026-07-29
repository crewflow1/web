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
 * Reads `process.env` DIRECTLY, imports no SDK and no `server-only` module, and
 * CAN NEVER THROW — a readiness probe must always answer.
 */

import { AI_TIERS, TIER_MODEL, isAnyTierBound, type AiTier } from "./registry";

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
   * A vendor credential is set while NO tier is bound — the drift case, and the
   * one honest warning this module owes an operator.
   *
   * The governor cannot govern what does not pass through it. Several call
   * sites predate this seam and gate themselves on `isAiConfigured()` (a bare
   * key check), so a credential appearing on a deploy could let one of those
   * legacy paths reach a provider while every tier here is still `null` and the
   * governor is a pass-through. That is spend with no ceiling and no ledger
   * entry — the AI analogue of the false-green this module was modelled on.
   * It is reported rather than "fixed" silently, because the fix is a decision:
   * either bind the tier (activate properly) or remove the credential.
   */
  ungovernedCredentialRisk: boolean;
};

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
    ungovernedCredentialRisk: credentialsPresent.length > 0 && !anyTierBound,
  };
}

/**
 * Cheap predicate for the hot path: is ANY governed call able to reach a
 * provider? `invokeWithGovernor` calls this first and, when false, runs the
 * caller's existing degraded path without a single database read — which is why
 * wiring the governor into a dark seam changes nothing that a user or a bill
 * can observe.
 */
export function isGovernorActivated(): boolean {
  return getAiGovernorReadiness().activated;
}
