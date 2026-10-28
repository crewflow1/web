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
 *
 * Two distinct shapes share this type:
 *
 *   1. ORG flow (app/admin/customers/[id]/_stripe-actions.ts) — the org
 *      already exists, so we key on `org_id`. Used for both the £1,000
 *      setup fee and the £500/mo subscription.
 *
 *   2. DEMO flow (lib/stripe/demo-checkout.ts) — fired from the Demos
 *      CRM "Send setup payment" action BEFORE any org exists. We key on
 *      `demo_id` instead; the webhook flips the demo to payment_received
 *      and emails the receipt. The customer org is provisioned later by
 *      the operator's "Move to onboarding" action.
 *
 * Stripe metadata values are always strings on the wire, so every field
 * is optional here and the handler branches on which key is present.
 */
export type CheckoutSessionMetadata = {
  kind: "setup_fee" | "subscription";
  /** Present for the ORG flow (customer already provisioned). */
  org_id?: string;
  /** Present for the DEMO flow (pre-provisioning setup-fee payment). */
  demo_id?: string;
  /** Company name — carried on the demo flow for nicer audit/receipts. */
  company?: string;
  actor_id?: string;
};

/**
 * Resolve the subscription id an invoice belongs to, across Stripe API versions.
 *
 * Stripe DEPRECATED the top-level `Invoice.subscription` field: from the
 * 2025-era API versions the reference moved to
 * `parent.subscription_details.subscription`, with a per-line copy at
 * `lines.data[].parent.subscription_item_details.subscription`. An account whose
 * API version is newer than the pinned SDK still sends events in that newer
 * shape, so reading only the legacy field silently mislabels every recurring
 * invoice as a one-off (billing_invoices.kind='setup_fee' instead of
 * 'subscription'). We therefore check all known locations, newest first with the
 * legacy field as a fallback. Returns null only for a genuinely one-off invoice
 * (no subscription reference anywhere).
 *
 * Pure + plain-object-typed (no Stripe SDK import) so it works on the raw webhook
 * payload and is unit-testable from fixtures.
 */
export function invoiceSubscriptionId(invoice: unknown): string | null {
  const pick = (v: unknown): string | null => {
    if (typeof v === "string" && v.length > 0) return v;
    if (
      v &&
      typeof v === "object" &&
      typeof (v as { id?: unknown }).id === "string"
    ) {
      return (v as { id: string }).id;
    }
    return null;
  };
  if (!invoice || typeof invoice !== "object") return null;
  const inv = invoice as {
    subscription?: unknown;
    parent?: { subscription_details?: { subscription?: unknown } | null } | null;
    lines?: {
      data?: Array<
        | {
            parent?: {
              subscription_item_details?: { subscription?: unknown } | null;
            } | null;
          }
        | undefined
      >;
    } | null;
  };
  return (
    pick(inv.subscription) ??
    pick(inv.parent?.subscription_details?.subscription) ??
    pick(inv.lines?.data?.[0]?.parent?.subscription_item_details?.subscription) ??
    null
  );
}

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
