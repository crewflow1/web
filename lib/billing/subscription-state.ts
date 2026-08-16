/**
 * Self-serve billing — the SUBSCRIPTION STATE MACHINE (pure, deterministic).
 *
 * Two responsibilities, both DB-free and Stripe-SDK-free so they are unit-
 * testable from fixtures:
 *
 *   1. reduceStripeSubscription() — project a Stripe Subscription (a plain shape,
 *      not the SDK type) onto our org_subscriptions row columns. The webhook
 *      handler calls this so the projection never drifts from what Stripe says.
 *
 *   2. classifyPlanChange() / assertPlanChangeAllowed() — the upgrade / downgrade
 *      / cancel transition rules over the plan catalogue ranks. This is the state
 *      machine the plan-change server action consults BEFORE touching Stripe.
 */

import { getPlan, isPlanKey, type PlanKey } from "./plans";

/** The org_subscriptions.status closed set — the Stripe subscription enum. */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionStatus(v: unknown): v is SubscriptionStatus {
  return (
    typeof v === "string" &&
    (SUBSCRIPTION_STATUSES as readonly string[]).includes(v)
  );
}

/**
 * Map a raw Stripe subscription.status to our enum. Stripe's values match ours
 * verbatim; an unrecognised value fails CLOSED to 'incomplete' (no access-
 * granting default) rather than throwing inside a webhook.
 */
export function mapStripeStatus(raw: unknown): SubscriptionStatus {
  return isSubscriptionStatus(raw) ? raw : "incomplete";
}

/** A status that currently grants product access. */
export function statusGrantsAccess(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing";
}

/** The minimal Stripe Subscription shape the reducer consumes. */
export type StripeSubscriptionShape = {
  id: string;
  status: string;
  customer: string | { id: string };
  cancel_at_period_end?: boolean;
  canceled_at?: number | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  items?: {
    data?: Array<{ price?: { id?: string; lookup_key?: string | null } }>;
  };
};

/** The columns reduceStripeSubscription writes onto an org_subscriptions row. */
export type OrgSubscriptionProjection = {
  status: SubscriptionStatus;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  stripe_price_id: string | null;
  plan_key: PlanKey | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
};

function unixToIso(v: number | null | undefined): string | null {
  return typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : null;
}

/**
 * Resolve the plan_key from a Stripe price lookup_key using the catalogue.
 * Returns null when no plan owns that lookup_key (unknown price) — the caller
 * decides whether to keep the existing plan_key or record null.
 */
export function planKeyForLookupKey(lookupKey: string | null | undefined): PlanKey | null {
  if (!lookupKey) return null;
  for (const key of ["starter", "pro", "enterprise", "trial"] as const) {
    if (getPlan(key)?.stripeLookupKey === lookupKey) return key;
  }
  return null;
}

/**
 * Project a Stripe Subscription onto our row columns. Pure: no SDK, no I/O.
 * plan_key is resolved from the first line item's price lookup_key; when that
 * can't be resolved it is null and the caller keeps the prior plan_key.
 */
export function reduceStripeSubscription(
  sub: StripeSubscriptionShape,
): OrgSubscriptionProjection {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const firstItem = sub.items?.data?.[0];
  const priceId = firstItem?.price?.id ?? null;
  const lookupKey = firstItem?.price?.lookup_key ?? null;
  return {
    status: mapStripeStatus(sub.status),
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    stripe_price_id: priceId,
    plan_key: planKeyForLookupKey(lookupKey),
    current_period_start: unixToIso(sub.current_period_start),
    current_period_end: unixToIso(sub.current_period_end),
    cancel_at_period_end: sub.cancel_at_period_end === true,
    canceled_at: unixToIso(sub.canceled_at),
  };
}

// ---------------------------------------------------------------------------
// Plan-change transition rules (the upgrade / downgrade / cancel state machine)
// ---------------------------------------------------------------------------

export type PlanChangeKind = "upgrade" | "downgrade" | "noop" | "invalid";

/**
 * Classify a requested plan change by comparing catalogue ranks.
 *   invalid   — either key is not a real plan, or target is 'trial' (you cannot
 *               self-serve DOWN to trial; that is a cancel, handled separately).
 *   noop      — same plan.
 *   upgrade   — target rank > current rank.
 *   downgrade — target rank < current rank.
 */
export function classifyPlanChange(
  currentPlanKey: string,
  targetPlanKey: string,
): PlanChangeKind {
  if (!isPlanKey(currentPlanKey) || !isPlanKey(targetPlanKey)) return "invalid";
  // 'trial' is never a self-serve TARGET — it has no Stripe price. Downgrading
  // to nothing is cancellation, which goes through the billing portal / cancel.
  if (targetPlanKey === "trial") return "invalid";
  const cur = getPlan(currentPlanKey)!.rank;
  const tgt = getPlan(targetPlanKey)!.rank;
  if (tgt === cur) return "noop";
  return tgt > cur ? "upgrade" : "downgrade";
}

export type PlanChangeDecision =
  | { ok: true; kind: "upgrade" | "downgrade"; target: PlanKey }
  | { ok: false; reason: "invalid_plan" | "same_plan" | "not_purchasable" };

/**
 * The guard the plan-change action calls BEFORE any Stripe work. Returns a
 * structured decision; the target plan must be a real, PURCHASABLE plan (has a
 * Stripe lookup_key) and different from the current one.
 */
export function assertPlanChangeAllowed(
  currentPlanKey: string,
  targetPlanKey: string,
): PlanChangeDecision {
  const kind = classifyPlanChange(currentPlanKey, targetPlanKey);
  if (kind === "invalid") return { ok: false, reason: "invalid_plan" };
  if (kind === "noop") return { ok: false, reason: "same_plan" };
  const target = getPlan(targetPlanKey)!;
  if (target.stripeLookupKey === null) return { ok: false, reason: "not_purchasable" };
  return { ok: true, kind, target: target.key };
}
