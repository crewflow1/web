import "server-only";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { recomputeHealthForOrg } from "@/server/services/hq-health-recompute";
import { emitNotifications } from "@/server/services/notifications-service";
import {
  notifyOnSetupFeePaid,
  notifyOnSubscriptionStarted,
  notifyOnSubscriptionCancelled,
  notifyOnFailedPayment,
} from "@/lib/notifications/events";
import {
  isProcessedEvent,
  type CheckoutSessionMetadata,
} from "@/lib/stripe/events";

/**
 * CrewFlow — Stripe webhook event processor.
 *
 * Called from app/api/webhooks/stripe/route.ts after the signature has
 * been verified. This module is the SIDE EFFECTS layer: writes to
 * billing_events / billing_invoices / organizations and triggers the
 * health recompute pipeline. Kept separate from the route so unit
 * tests can hit it with synthetic events.
 *
 * Idempotency strategy:
 *   1. Every webhook starts with an INSERT into billing_events keyed
 *      on the Stripe event.id (unique partial index from HQ-4 ensures
 *      replay attempts collide).
 *   2. If the INSERT collides → return early with status="duplicate".
 *      The route returns 200 to Stripe (any other response triggers
 *      retries we don't want).
 *   3. After successful processing, UPDATE billing_events.processed_at.
 *
 * Service-role client throughout — RLS would block the cross-tenant
 * lookups (find org by stripe_customer_id, etc).
 */

// ---------------------------------------------------------------------
// Admin table helper — billing_events / billing_invoices / organizations
// aren't fully in the generated Supabase types yet (HQ-4 schema, HQ-6
// columns). Cast through unknown so the chain compiles.
// ---------------------------------------------------------------------

type AnyQuery = {
  eq: (k: string, v: unknown) => AnyQuery;
  in: (k: string, v: unknown[]) => AnyQuery;
  order: (k: string, opts: { ascending: boolean }) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
  }> & AnyQuery;
  limit: (n: number) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
  }> & AnyQuery;
  maybeSingle: () => Promise<{
    data: unknown | null;
    error: { message: string } | null;
  }>;
};

type AnyInsert = Promise<{
  data: unknown | null;
  error: { message: string; code?: string } | null;
}>;

type AnyUpdate = {
  eq: (k: string, v: unknown) => AnyUpdate &
    Promise<{ error: { message: string } | null }>;
};

function adminTable(name: string) {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as {
    select: (cols: string) => AnyQuery;
    insert: (payload: unknown) => AnyInsert;
    update: (payload: unknown) => AnyUpdate;
  };
}

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

export type ProcessResult =
  | { status: "duplicate"; event_id: string }
  | { status: "skipped"; event_id: string; reason: string }
  | { status: "processed"; event_id: string; actions: ReadonlyArray<string> };

export async function processStripeEvent(
  event: Stripe.Event,
): Promise<ProcessResult> {
  // 1. Insert into billing_events. Unique partial index on event_id
  //    means a second delivery for the same event collides and we
  //    short-circuit with "duplicate".
  const orgId = await orgIdFromEvent(event);
  const insertRes = await adminTable("billing_events").insert({
    event_id: event.id,
    event_type: event.type,
    org_id: orgId,
    payload: event as unknown as Record<string, unknown>,
  });
  if (insertRes.error) {
    // Unique violation = duplicate delivery → ack and stop.
    if (
      insertRes.error.code === "23505" ||
      insertRes.error.message?.includes("duplicate")
    ) {
      return { status: "duplicate", event_id: event.id };
    }
    // Some other DB error — we throw so the route returns 500 and
    // Stripe retries.
    throw new Error(`billing_events insert failed: ${insertRes.error.message}`);
  }

  // 2. Skip event types we don't process — but still mark stored.
  if (!isProcessedEvent(event.type)) {
    await markProcessed(event.id, "noop");
    return { status: "skipped", event_id: event.id, reason: "unhandled_type" };
  }

  // 3. Dispatch.
  const actions: string[] = [];
  try {
    switch (event.type) {
      case "checkout.session.completed":
        actions.push(...(await handleCheckoutCompleted(event)));
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        actions.push(...(await handleSubscriptionUpsert(event)));
        break;
      case "customer.subscription.deleted":
        actions.push(...(await handleSubscriptionDeleted(event)));
        break;
      case "invoice.paid":
        actions.push(...(await handleInvoicePaid(event)));
        break;
      case "invoice.payment_failed":
      case "invoice.payment_action_required":
        actions.push(...(await handleInvoiceFailed(event)));
        break;
      case "invoice.finalized":
      case "invoice.voided":
        actions.push(...(await handleInvoiceStatusChange(event)));
        break;
      case "payment_intent.succeeded":
      case "payment_intent.payment_failed":
        actions.push(...(await handlePaymentIntent(event)));
        break;
      case "customer.created":
      case "customer.updated":
        actions.push(...(await handleCustomerUpsert(event)));
        break;
      default:
        actions.push("unhandled_known_type");
    }
    await markProcessed(event.id, "ok");
    return { status: "processed", event_id: event.id, actions };
  } catch (e) {
    await markProcessed(
      event.id,
      `error: ${e instanceof Error ? e.message : String(e)}`,
    );
    throw e;
  }
}

// ---------------------------------------------------------------------
// Per-event handlers
// ---------------------------------------------------------------------

async function handleCheckoutCompleted(
  event: Stripe.Event,
): Promise<string[]> {
  const session = event.data.object as Stripe.Checkout.Session;
  const meta = (session.metadata ?? {}) as Partial<CheckoutSessionMetadata>;
  if (!meta.org_id) {
    return ["skipped:no_org_id_in_metadata"];
  }
  const out: string[] = [];

  // Persist the stripe_customer_id on the org.
  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : (session.customer?.id ?? null);
  if (customerId) {
    await adminTable("organizations")
      .update({ stripe_customer_id: customerId })
      .eq("id", meta.org_id);
    out.push(`stripe_customer_id_set:${customerId}`);
  }

  if (meta.kind === "setup_fee") {
    // One-off — record paid setup fee on the org.
    await adminTable("organizations")
      .update({
        setup_fee_status: "paid",
        setup_fee_paid_at: new Date().toISOString(),
      })
      .eq("id", meta.org_id);
    out.push("setup_fee_paid");

    // Insert a billing_invoices row capturing the payment if not
    // already present from a sibling invoice.paid event.
    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : (session.payment_intent?.id ?? null);
    await adminTable("billing_invoices").insert({
      org_id: meta.org_id,
      kind: "setup_fee",
      status: "paid",
      amount_gbp: ((session.amount_total ?? 0) / 100).toFixed(2),
      currency: (session.currency ?? "gbp").toUpperCase(),
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId,
      notes: "Auto-created from Stripe checkout.session.completed (setup_fee)",
    });
    out.push("billing_invoice_inserted:setup_fee");

    // Notify customer + HQ that the setup fee landed.
    await emitNotifications(
      notifyOnSetupFeePaid({
        org_id: meta.org_id,
        amount_gbp: (session.amount_total ?? 0) / 100,
      }),
    );
  }

  if (meta.kind === "subscription") {
    const subId =
      typeof session.subscription === "string"
        ? session.subscription
        : (session.subscription?.id ?? null);
    if (subId) {
      await adminTable("organizations")
        .update({
          stripe_subscription_id: subId,
          status: "active",
        })
        .eq("id", meta.org_id);
      out.push(`subscription_started:${subId}`);

      // Notify customer + HQ that the subscription is active.
      await emitNotifications(
        notifyOnSubscriptionStarted({
          org_id: meta.org_id,
          stripe_subscription_id: subId,
          next_renewal_at: null,
        }),
      );
    }
  }

  await recordAdminActivity({
    actorId: meta.actor_id ?? null,
    actorEmail: null,
    action: "stripe.checkout_completed",
    targetTable: "organizations",
    targetId: meta.org_id,
    metadata: {
      stripe_session_id: session.id,
      kind: meta.kind,
      amount_total: session.amount_total,
      stripe_customer_id: customerId,
    },
  });

  await recomputeHealthForOrg(meta.org_id, "payment_change", null);
  return out;
}

async function handleSubscriptionUpsert(
  event: Stripe.Event,
): Promise<string[]> {
  const sub = event.data.object as Stripe.Subscription;
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const orgId = await orgIdByCustomer(customerId);
  if (!orgId) return ["skipped:no_org_for_customer"];

  const nextRenewalRaw = (sub as unknown as { current_period_end?: number })
    .current_period_end;
  const nextRenewal =
    typeof nextRenewalRaw === "number" && nextRenewalRaw > 0
      ? new Date(nextRenewalRaw * 1000).toISOString()
      : null;
  await adminTable("organizations")
    .update({
      stripe_subscription_id: sub.id,
      stripe_customer_id: customerId,
      next_renewal_at: nextRenewal,
      status: sub.status === "active" || sub.status === "trialing"
        ? "active"
        : sub.status === "canceled"
          ? "cancelled"
          : sub.status === "past_due" || sub.status === "unpaid"
            ? "suspended"
            : undefined,
    })
    .eq("id", orgId);

  await recordAdminActivity({
    actorId: null,
    actorEmail: null,
    action: "stripe.subscription_upsert",
    targetTable: "organizations",
    targetId: orgId,
    metadata: {
      stripe_subscription_id: sub.id,
      status: sub.status,
      next_renewal_at: nextRenewal,
    },
  });

  await recomputeHealthForOrg(orgId, "payment_change", null);
  return [`subscription_synced:${sub.status}`];
}

async function handleSubscriptionDeleted(
  event: Stripe.Event,
): Promise<string[]> {
  const sub = event.data.object as Stripe.Subscription;
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const orgId = await orgIdByCustomer(customerId);
  if (!orgId) return ["skipped:no_org_for_customer"];

  // Don't auto-cancel the org — that's a high-blast-radius decision.
  // Record the event and let the operator decide via /admin/customers.
  await recordAdminActivity({
    actorId: null,
    actorEmail: null,
    action: "stripe.subscription_deleted",
    targetTable: "organizations",
    targetId: orgId,
    metadata: { stripe_subscription_id: sub.id, status: sub.status },
  });

  // Loud HQ notification — urgent decision needed.
  await emitNotifications(
    notifyOnSubscriptionCancelled({
      org_id: orgId,
      stripe_subscription_id: sub.id,
    }),
  );
  return ["subscription_deleted_recorded"];
}

async function handleInvoicePaid(event: Stripe.Event): Promise<string[]> {
  const inv = event.data.object as Stripe.Invoice;
  const customerId =
    typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
  if (!customerId) return ["skipped:no_customer"];
  const orgId = await orgIdByCustomer(customerId);
  if (!orgId) return ["skipped:no_org_for_customer"];

  const amount = (inv.amount_paid ?? inv.amount_due ?? 0) / 100;
  const paidAtRaw = (inv as unknown as { status_transitions?: { paid_at?: number } })
    .status_transitions?.paid_at;
  const paidAt =
    typeof paidAtRaw === "number" && paidAtRaw > 0
      ? new Date(paidAtRaw * 1000).toISOString()
      : new Date().toISOString();

  // Upsert by stripe_invoice_id (unique partial idx from HQ-4).
  // Try update first; if no rows matched, insert.
  const stripeInvId = inv.id;
  const updRes = await adminTable("billing_invoices")
    .update({
      status: "paid",
      paid_at: paidAt,
      amount_gbp: amount.toFixed(2),
    })
    .eq("stripe_invoice_id", stripeInvId);
  // We can't easily get rowcount from the typed cast, so insert
  // protected by the unique partial index — if it collides, ignore.
  const insertRes = await adminTable("billing_invoices").insert({
    org_id: orgId,
    kind: inv.subscription ? "subscription" : "setup_fee",
    status: "paid",
    amount_gbp: amount.toFixed(2),
    currency: (inv.currency ?? "gbp").toUpperCase(),
    paid_at: paidAt,
    stripe_invoice_id: stripeInvId,
    due_date: inv.due_date
      ? new Date(inv.due_date * 1000).toISOString().slice(0, 10)
      : null,
    notes: "Auto-created from Stripe invoice.paid",
  });
  // Suppress unused expression warnings on the awaited results.
  void updRes;
  void insertRes;

  await recordAdminActivity({
    actorId: null,
    actorEmail: null,
    action: "stripe.invoice_paid",
    targetTable: "organizations",
    targetId: orgId,
    metadata: {
      stripe_invoice_id: stripeInvId,
      amount_gbp: amount,
      paid_at: paidAt,
    },
  });

  await recomputeHealthForOrg(orgId, "payment_change", null);
  return [`invoice_paid:${stripeInvId}`];
}

async function handleInvoiceFailed(event: Stripe.Event): Promise<string[]> {
  const inv = event.data.object as Stripe.Invoice;
  const customerId =
    typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
  if (!customerId) return ["skipped:no_customer"];
  const orgId = await orgIdByCustomer(customerId);
  if (!orgId) return ["skipped:no_org_for_customer"];

  const amount = (inv.amount_due ?? 0) / 100;
  const failedAt = new Date().toISOString();
  const failureReason =
    (inv as unknown as { last_finalization_error?: { message?: string } })
      .last_finalization_error?.message ?? "Stripe reported payment_failed";

  await adminTable("billing_invoices")
    .update({
      status: "failed",
      failed_at: failedAt,
      failure_reason: failureReason,
    })
    .eq("stripe_invoice_id", inv.id);
  await adminTable("billing_invoices").insert({
    org_id: orgId,
    kind: inv.subscription ? "subscription" : "setup_fee",
    status: "failed",
    amount_gbp: amount.toFixed(2),
    currency: (inv.currency ?? "gbp").toUpperCase(),
    failed_at: failedAt,
    failure_reason: failureReason,
    stripe_invoice_id: inv.id,
    notes: "Auto-created from Stripe invoice.payment_failed",
  });

  // Notify both customer + HQ urgently — the customer needs to fix
  // their card, HQ needs to chase if it doesn't get resolved.
  await emitNotifications(
    notifyOnFailedPayment({
      org_id: orgId,
      amount_gbp: amount,
      stripe_invoice_id: inv.id,
      reason: failureReason,
    }),
  );

  await recordAdminActivity({
    actorId: null,
    actorEmail: null,
    action: "stripe.invoice_failed",
    targetTable: "organizations",
    targetId: orgId,
    metadata: {
      stripe_invoice_id: inv.id,
      amount_gbp: amount,
      reason: failureReason,
    },
  });

  await recomputeHealthForOrg(orgId, "payment_change", null);
  return [`invoice_failed:${inv.id}`];
}

async function handleInvoiceStatusChange(
  event: Stripe.Event,
): Promise<string[]> {
  const inv = event.data.object as Stripe.Invoice;
  const newStatus = event.type === "invoice.voided" ? "void" : "sent";
  await adminTable("billing_invoices")
    .update({ status: newStatus })
    .eq("stripe_invoice_id", inv.id);
  return [`invoice_status_${newStatus}:${inv.id}`];
}

async function handlePaymentIntent(event: Stripe.Event): Promise<string[]> {
  const pi = event.data.object as Stripe.PaymentIntent;
  const customerId =
    typeof pi.customer === "string" ? pi.customer : pi.customer?.id ?? null;
  if (!customerId) return ["skipped:no_customer"];
  const orgId = await orgIdByCustomer(customerId);
  if (!orgId) return ["skipped:no_org_for_customer"];

  await recordAdminActivity({
    actorId: null,
    actorEmail: null,
    action: `stripe.${event.type.replace("payment_intent.", "pi_")}`,
    targetTable: "organizations",
    targetId: orgId,
    metadata: {
      stripe_payment_intent_id: pi.id,
      amount: pi.amount,
      status: pi.status,
    },
  });
  return [`pi:${pi.id}:${pi.status}`];
}

async function handleCustomerUpsert(event: Stripe.Event): Promise<string[]> {
  const c = event.data.object as Stripe.Customer;
  // If metadata.org_id is set (we set it on checkout creation), keep
  // the link fresh in case it was missed.
  const orgId = c.metadata?.org_id;
  if (!orgId) return ["skipped:no_org_id_metadata"];
  await adminTable("organizations")
    .update({
      stripe_customer_id: c.id,
      billing_email: c.email ?? undefined,
    })
    .eq("id", orgId);
  return [`customer_synced:${c.id}`];
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Try to infer the org_id from a Stripe event so the billing_events
 * row can be linked. Falls back to null when we can't (e.g. customer
 * deleted events with no metadata). The handler still processes those
 * by looking up the org via stripe_customer_id at dispatch time.
 */
async function orgIdFromEvent(event: Stripe.Event): Promise<string | null> {
  const obj = event.data.object as unknown as Record<string, unknown>;
  // 1. Checkout sessions carry org_id in metadata.
  const meta = obj.metadata as Record<string, string> | undefined;
  if (meta?.org_id) return meta.org_id;

  // 2. Anything with a customer field → look it up.
  const cust = obj.customer;
  if (typeof cust === "string") {
    return orgIdByCustomer(cust);
  }
  if (cust && typeof cust === "object" && "id" in cust) {
    return orgIdByCustomer((cust as { id: string }).id);
  }
  return null;
}

async function orgIdByCustomer(customerId: string): Promise<string | null> {
  const res = await adminTable("organizations")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (!res.data) return null;
  return (res.data as { id: string }).id;
}

async function markProcessed(eventId: string, note: string): Promise<void> {
  await adminTable("billing_events")
    .update({
      processed_at: new Date().toISOString(),
      error_message: note === "ok" ? null : note.startsWith("error:") ? note : null,
    })
    .eq("event_id", eventId);
  // Suppress lint for the awaited expression's discarded promise above.
}
