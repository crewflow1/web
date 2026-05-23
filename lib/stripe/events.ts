/**
 * Stripe webhook event type registry — pure constants, no Stripe import.
 *
 * Lists every event type the handler explicitly processes. Events not
 * in this list are stored in billing_events (for replay later) but no
 * side effects fire — they just record `processed_at` with a "noop"
 * note.
 */

export const PROCESSED_STRIPE_EVENTS = [
  // Checkout
  "checkout.session.completed",
  // Subscriptions
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  // Invoices
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalized",
  "invoice.voided",
  // Payment intents (one-off charges)
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  // Customer
  "customer.created",
  "customer.updated",
] as const;

export type ProcessedStripeEvent = (typeof PROCESSED_STRIPE_EVENTS)[number];

export function isProcessedEvent(type: string): type is ProcessedStripeEvent {
  return (PROCESSED_STRIPE_EVENTS as ReadonlyArray<string>).includes(type);
}

/**
 * Checkout Session metadata we attach when creating a session — drives
 * the webhook handler's branching once payment completes.
 */
export type CheckoutSessionMetadata = {
  org_id: string;
  kind: "setup_fee" | "subscription";
  actor_id?: string;
};

/**
 * Subset of Stripe API shapes the handler consumes. Mirrors the
 * Stripe namespace but stays plain-object-typed so unit tests can
 * construct fixtures without pulling the Stripe SDK.
 */
export type WebhookEventShape = {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
};
