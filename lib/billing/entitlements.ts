/**
 * Self-serve billing — the FEATURE ENTITLEMENT GATE (pure, deterministic).
 *
 * A plan→feature check other code calls to ask "does this plan include feature
 * X?". Pure and DB-free so the answer is deterministic and unit-testable. The
 * ORG-level resolution (read the org's current plan, apply the dark-allow
 * contract) lives in server/services/entitlements.ts — this module never touches
 * a database or process.env.
 *
 * DARK CONTRACT (enforced by the SERVER resolver, not here): while self-serve
 * billing is dark, org entitlement checks return ALLOW, so wiring a gate into
 * existing code changes nothing in production until the feature is switched on.
 * These pure functions always answer strictly from the catalogue.
 */

import {
  PLAN_DEFINITIONS,
  getPlan,
  isFeatureKey,
  type FeatureKey,
  type PlanKey,
} from "./plans";

/** The exact feature set a plan grants (empty set for an unknown key). */
export function planEntitlements(planKey: string): ReadonlySet<FeatureKey> {
  const plan = getPlan(planKey);
  return new Set(plan ? plan.features : []);
}

/**
 * Deterministic: does `planKey` include `featureKey`? False for an unknown plan
 * or an unknown feature (fail-closed at the catalogue layer).
 */
export function planHasFeature(planKey: string, featureKey: string): boolean {
  if (!isFeatureKey(featureKey)) return false;
  const plan = getPlan(planKey);
  return plan ? plan.features.includes(featureKey) : false;
}

/** The seat allowance for a plan; null = unlimited, undefined = unknown plan. */
export function planSeatLimit(planKey: string): number | null | undefined {
  const plan = getPlan(planKey);
  return plan ? plan.seats : undefined;
}

/**
 * The union of every feature any plan grants — the "unlimited" set the dark
 * contract hands back so a gated call site behaves exactly as it did before the
 * gate existed (i.e. everything allowed) while billing is off.
 */
export const ALL_FEATURES: ReadonlySet<FeatureKey> = new Set(
  Object.values(PLAN_DEFINITIONS).flatMap((p) => p.features),
);

export type { FeatureKey, PlanKey };
