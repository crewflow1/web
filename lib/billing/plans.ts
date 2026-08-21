/**
 * Self-serve billing — the PLAN CATALOGUE (config, not a table).
 *
 * Named plans with their feature ENTITLEMENTS. Held as config (not DB rows) so
 * the entitlement gate is deterministic and unit-testable with no database, and
 * so no pricing amount is ever invented in a seed. The plan's actual PRICE lives
 * in Stripe (CEO config) and is resolved at runtime by its `stripeLookupKey`;
 * `priceHintGbp` here is ONLY a display hint the surface may show when Stripe is
 * dark — it is never used to charge and never authoritative.
 *
 * The plan KEYS are kept in lockstep with the org_subscriptions.plan_key CHECK
 * constraint (migration 20261148000000) by a drift test — adding a plan means
 * widening BOTH.
 *
 * Feature ENTITLEMENT keys name capabilities other code can gate on via
 * lib/billing/entitlements.ts. This is the gate DEFINITION; wiring is deliberate
 * and sparse (1 to 2 example call sites), NOT a retrofit of every feature.
 */

export const PLAN_KEYS = ["trial", "starter", "pro", "enterprise"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export function isPlanKey(v: unknown): v is PlanKey {
  return typeof v === "string" && (PLAN_KEYS as readonly string[]).includes(v);
}

/**
 * Feature entitlement keys — capabilities a plan may grant. Deterministic
 * strings other code can check with planHasFeature() / orgHasEntitlement().
 */
export const FEATURE_KEYS = [
  "core", // baseline product — every plan
  "ai_receptionist", // the AI receptionist / comms engine
  "advanced_reporting", // scheduled report subscriptions, exports
  "outbound_webhooks", // org-configurable outbound webhooks
  "api_access", // programmatic API keys
  "priority_support", // SLA / priority support
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export function isFeatureKey(v: unknown): v is FeatureKey {
  return typeof v === "string" && (FEATURE_KEYS as readonly string[]).includes(v);
}

export type PlanDefinition = {
  key: PlanKey;
  name: string;
  description: string;
  /**
   * Rank for upgrade/downgrade comparison (higher = more). Distinct per plan.
   * trial < starter < pro < enterprise.
   */
  rank: number;
  /**
   * The stable Stripe price lookup_key the runtime resolver uses to find the
   * real recurring price. null = not a self-serve-purchasable plan (trial has
   * no Stripe price; it is the pre-subscription state).
   */
  stripeLookupKey: string | null;
  /** DISPLAY-ONLY monthly hint (GBP). Never used to charge. null for trial. */
  priceHintGbp: number | null;
  /** Seat allowance. null = unlimited. */
  seats: number | null;
  /** The feature entitlements this plan grants. */
  features: readonly FeatureKey[];
};

/**
 * The catalogue. Entitlements are additive up the ranks by intent, but each
 * plan lists its full set explicitly so a check never has to walk ranks.
 *
 * PRICES ARE NOT SET HERE. priceHintGbp is a display placeholder (null) until
 * the CEO sets real Stripe prices and (optionally) fills the hints; the charge
 * always comes from the Stripe price resolved by stripeLookupKey.
 */
export const PLAN_DEFINITIONS: Record<PlanKey, PlanDefinition> = {
  trial: {
    key: "trial",
    name: "Trial",
    description: "Time-limited evaluation access. No subscription.",
    rank: 0,
    stripeLookupKey: null,
    priceHintGbp: null,
    seats: 3,
    features: ["core", "ai_receptionist"],
  },
  starter: {
    key: "starter",
    name: "Starter",
    description: "For small crews getting started with CrewFlow.",
    rank: 1,
    stripeLookupKey: "crewflow_plan_starter_monthly",
    priceHintGbp: null,
    seats: 5,
    features: ["core", "ai_receptionist"],
  },
  pro: {
    key: "pro",
    name: "Pro",
    description: "Growing companies: reporting, integrations and API access.",
    rank: 2,
    stripeLookupKey: "crewflow_plan_pro_monthly",
    priceHintGbp: null,
    seats: 20,
    features: [
      "core",
      "ai_receptionist",
      "advanced_reporting",
      "outbound_webhooks",
      "api_access",
    ],
  },
  enterprise: {
    key: "enterprise",
    name: "Enterprise",
    description: "Unlimited seats, priority support and every capability.",
    rank: 3,
    stripeLookupKey: "crewflow_plan_enterprise_monthly",
    priceHintGbp: null,
    seats: null,
    features: [
      "core",
      "ai_receptionist",
      "advanced_reporting",
      "outbound_webhooks",
      "api_access",
      "priority_support",
    ],
  },
};

/** All plans, ordered by rank (trial first). */
export function listPlans(): PlanDefinition[] {
  return [...PLAN_KEYS].map((k) => PLAN_DEFINITIONS[k]);
}

/** Plans a tenant can self-serve subscribe to (excludes trial — no price). */
export function purchasablePlans(): PlanDefinition[] {
  return listPlans().filter((p) => p.stripeLookupKey !== null);
}

/** Resolve a plan definition; returns null for an unknown key. */
export function getPlan(key: string): PlanDefinition | null {
  return isPlanKey(key) ? PLAN_DEFINITIONS[key] : null;
}
