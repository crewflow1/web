/**
 * Self-serve tenant billing — the TWO-SWITCH DARK GATE.
 *
 * This feature lets a tenant admin manage their OWN CrewFlow SaaS subscription
 * (upgrade / downgrade / cancel) via Stripe's Billing Portal + Checkout, instead
 * of the mailto-to-hello@crewflow.uk that is the only path today. It reuses
 * CrewFlow's OWN SaaS-billing Stripe integration (lib/stripe/client.ts,
 * STRIPE_SECRET_KEY, the /api/webhooks/stripe route). It is SEPARATE from the
 * demo setup-fee checkout and from P2 portal invoice payments (which have their
 * own Connect key + route).
 *
 * ── THE TWO SWITCHES ─────────────────────────────────────────────────────────
 *   1. NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING === "true"  (the master flag), AND
 *   2. STRIPE_SECRET_KEY present                          (the SaaS Stripe key).
 *
 * `isSelfServeBillingConfigured()` is a pure env read: true only when BOTH hold —
 * NEVER, today. The server actions + the entitlement-enforcement path REFUSE-
 * before-fetch on either being unmet, so there is no route from "dark" to a
 * Stripe network call. Even both switches together only enable the MECHANISM;
 * the actual plan PRICES are CEO config in Stripe (resolved by lookup_key).
 *
 * Reads process.env directly (the substrate idiom used by portal-stripe.ts /
 * outbound-webhooks flags), NOT the frozen `env` snapshot, so activation is a
 * runtime config act — no rebuild — and the dark contract is testable by
 * flipping process.env. env.ts still declares + validates these for boot-time
 * visibility.
 */

function rawEnv(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** Switch 1: the master feature flag. */
export function selfServeBillingFeatureEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING === "true";
}

/** Switch 2: the SaaS-billing Stripe secret key is present + non-empty. */
export function selfServeBillingKeyPresent(): boolean {
  return rawEnv("STRIPE_SECRET_KEY") !== null;
}

/**
 * The two-switch config gate: FLAG on AND SaaS Stripe key present. A pure env
 * read, no network, never throws. Still NOT sufficient to bill — the plan PRICES
 * must exist in Stripe (CEO config, resolved by lookup_key at runtime).
 */
export function isSelfServeBillingConfigured(): boolean {
  return selfServeBillingFeatureEnabled() && selfServeBillingKeyPresent();
}
