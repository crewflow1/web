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
  invoiceSubscriptionId,
  type CheckoutSessionMetadata,
} from "@/lib/stripe/events";
import { onDemoStripePaymentConfirmed } from "@/server/services/demo-lifecycle";
import {
  wireSelfServeBillingDeps,
  syncOrgSubscriptionFromStripe,
} from "@/server/services/self-serve-billing";
import type { StripeSubscriptionShape } from "@/lib/billing/subscription-state";
import {
  applyStripeSubscriptionState,
  confirmCancellationRpc,
  isSubscriptionTombstoned,
  loadCancellationOrg,
  sendCancellationConfirmationEmail,
} from "@/server/services/subscription-cancellation";

/**
 * Best-effort projection of a Stripe subscription onto the org_subscriptions
 * table (P3W2 self-serve billing). ADDITIVE to the existing organizations-table
 * sync: it never throws (a projection failure must not fail the webhook — the
 * organizations update above is the authoritative access-control path), and it
 * writes the same row on redelivery (idempotent upsert keyed on org_id). Inert
 * while self-serve billing is dark? No — the projection is written whenever
 * Stripe sends the event, so activation has an accurate history to read; but no
 * Stripe subscription events exist until the feature is used, so it stays empty.
 */
async function projectOrgSubscription(
  orgId: string,
  sub: Stripe.Subscription,
): Promise<void> {
  try {
    await syncOrgSubscriptionFromStripe(wireSelfServeBillingDeps(), {
      orgId,
      subscription: sub as unknown as StripeSubscriptionShape,
    });
  } catch (e) {
    console.error("[stripe-webhook] org_subscriptions projection failed", {
      org_id: orgId,
      subscription_id: sub.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

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
 *   1. Every webhook starts with an INSERT into billing_events keyed on the
 *      Stripe event.id (`event_id text unique` — a plain UNIQUE constraint, so
 *      re-delivery collides).
 *   2. On collision, read the stored row's processed_at:
 *        - stamped  → genuinely handled before → return "duplicate", 200, stop.
 *                     This is the idempotency guarantee: handlers don't re-run.
 *        - NULL     → stored but never completed → FALL THROUGH and dispatch.
 *                     This is Stripe's retry doing its job.
 *   3. processed_at is stamped ONLY on success or a deliberate no-op
 *      (markProcessed). A failed dispatch records error_message and leaves
 *      processed_at NULL (markFailed), so the event stays retryable.
 *
 * `processed_at` is therefore the single "never run this again" flag, and the
 * ONLY thing that may set it is a dispatch that actually finished. Short-
 * circuiting on row existence instead — as this did until the retry
 * correction — turns Stripe's at-least-once delivery into at-most-once: one
 * transient failure inside a handler permanently drops the event.
 *
 * Known narrow window (documented, not fixed here): if a retry arrives while a
 * previous attempt is still in flight, both see processed_at NULL and both
 * dispatch. Closing it needs an atomic claim (e.g. a processing_started_at
 * column), which is a schema change and out of scope for this correction.
 * Stripe's retry schedule makes overlap unlikely, and the previous behaviour
 * traded this window for silent permanent data loss — a strictly worse deal.
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

/**
 * How long a billing_events claim is honoured before it is treated as orphaned.
 *
 * 15 minutes, matching the automation dispatcher's lease
 * (20260912000000_automation_runs_claim_semantics). The webhook route sets no
 * maxDuration and Stripe closes the connection at ~20s then retries, so nothing
 * legitimate runs anywhere near this — an older claim is provably dead.
 */
export const BILLING_CLAIM_LEASE_MS = 15 * 60 * 1000;

export async function processStripeEvent(
  event: Stripe.Event,
): Promise<ProcessResult> {
  // 1. CLAIM the event before any business logic runs. `event_id` is UNIQUE, so
  //    the INSERT is itself the atomic first-delivery claim: exactly one
  //    concurrent caller inserts, the rest collide with 23505.
  //
  //    `claimed_at = now()` on the insert is the lease stamp a concurrent loser
  //    reads to tell "someone is working on this right now" from "orphaned".
  const orgId = await orgIdFromEvent(event);
  const insertRes = await adminTable("billing_events").insert({
    event_id: event.id,
    event_type: event.type,
    org_id: orgId,
    payload: event as unknown as Record<string, unknown>,
    claimed_at: new Date().toISOString(),
  });
  if (insertRes.error) {
    const isDuplicate =
      insertRes.error.code === "23505" ||
      insertRes.error.message?.includes("duplicate");
    if (!isDuplicate) {
      // A real DB error — surfaced, not swallowed. Throw so the route 500s and
      // Stripe retries.
      throw new Error(
        `billing_events insert failed: ${insertRes.error.message}`,
      );
    }

    // A row already exists for this event_id. Existence is NOT proof of
    // completion. Try to RECLAIM it with ONE atomic conditional UPDATE — never
    // a read-then-act, whose window let a concurrent loser dispatch a second
    // time while the winner was still working.
    //
    // The UPDATE matches only a row that is genuinely takeable:
    //   - processed_at IS NULL           — never steal completed work, and
    //   - error_message IS NOT NULL      — a released failure, retry now, OR
    //   - claimed_at < now() - 15 min    — an orphaned in-flight claim.
    // A live claim (processed_at NULL, error_message NULL, claimed_at recent)
    // matches NEITHER branch, so it is left alone: the concurrent loser reclaims
    // nothing and runs nothing.
    const leaseCutoff = new Date(
      Date.now() - BILLING_CLAIM_LEASE_MS,
    ).toISOString();
    const reclaimRes = await (
      adminTable("billing_events") as unknown as {
        update: (row: unknown) => {
          eq: (k: string, v: unknown) => {
            is: (k: string, v: unknown) => {
              or: (f: string) => {
                select: (cols: string) => Promise<{
                  data: Array<{ id: string }> | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };
        };
      }
    )
      .update({ claimed_at: new Date().toISOString(), error_message: null })
      .eq("event_id", event.id)
      .is("processed_at", null)
      .or(`error_message.not.is.null,claimed_at.lt.${leaseCutoff}`)
      .select("id");

    if (reclaimRes.error) {
      // Cannot tell whether we hold the claim → throw so Stripe retries rather
      // than risk dropping the event or double-running the handler.
      throw new Error(
        `billing_events reclaim failed: ${reclaimRes.error.message}`,
      );
    }
    if ((reclaimRes.data?.length ?? 0) === 0) {
      // Completed, or an active lease is held by a concurrent winner. Either
      // way: ack and run NOTHING. This is the idempotency + concurrency
      // guarantee — business logic below does not run twice.
      return { status: "duplicate", event_id: event.id };
    }
    // Reclaimed an orphaned/failed row → fall through and dispatch (the retry).
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
      // Async/delayed payment methods settle AFTER checkout: the money confirms
      // via async_payment_succeeded (session now "paid") or fails via
      // async_payment_failed (session "unpaid"). Both route through the same
      // payment-gated handler, so success provisions and failure is a no-op.
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
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
    // Record WHY it failed, but leave processed_at NULL so the retry re-runs it.
    await markFailed(
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

  // PAYMENT-CONFIRMED GATE (first, so it protects BOTH the demo and org flows).
  // This handler serves checkout.session.completed AND .async_payment_succeeded
  // / .async_payment_failed. For card checkout, `completed` arrives "paid". For
  // async/delayed methods, `completed` arrives "unpaid" and the money confirms
  // later via async_payment_succeeded ("paid") or fails via async_payment_failed
  // ("unpaid"). Provisioning paid access — or confirming a demo setup-fee —
  // before payment is confirmed would grant access without money. Gate here.
  // "no_payment_required" covers genuine £0 / fully-discounted sessions.
  const paymentConfirmed =
    session.payment_status === "paid" || session.payment_status === "no_payment_required";
  if (!paymentConfirmed) {
    await recordAdminActivity({
      actorId: null,
      actorEmail: null,
      action: "stripe.checkout_completed_unpaid_skipped",
      targetTable: meta.demo_id ? "demo_requests" : "organizations",
      targetId: meta.org_id ?? meta.demo_id ?? session.id,
      metadata: {
        stripe_session_id: session.id,
        payment_status: session.payment_status ?? null,
        kind: meta.kind ?? null,
        demo_id: meta.demo_id ?? null,
        event_type: event.type,
      },
    });
    return [`skipped_unpaid:payment_status=${session.payment_status ?? "unknown"}`];
  }

  // --- DEMO flow: setup-fee paid BEFORE the org exists. -------------
  // The Demos CRM "Send setup payment" action mints a Checkout Session
  // keyed on demo_id (no org yet). On completion we flip the demo to
  // payment_received + email the receipt — fully automatic, the operator
  // never has to "mark payment received" by hand.
  if (meta.demo_id) {
    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : (session.payment_intent?.id ?? null);
    const res = await onDemoStripePaymentConfirmed({
      demoId: meta.demo_id,
      amountGbp:
        typeof session.amount_total === "number"
          ? session.amount_total / 100
          : null,
      stripeSessionId: session.id,
    });
    await recordAdminActivity({
      actorId: null,
      actorEmail: null,
      action: "stripe.demo_setup_fee_paid",
      targetTable: "demo_requests",
      targetId: meta.demo_id,
      metadata: {
        stripe_session_id: session.id,
        stripe_payment_intent_id: paymentIntentId,
        amount_total: session.amount_total,
        result_ok: res.ok,
        already_handled: res.alreadyHandled ?? false,
        done: res.done,
        failed: res.failed,
      },
    });
    return [
      res.alreadyHandled
        ? `demo_setup_fee_already_paid:${meta.demo_id}`
        : `demo_setup_fee_paid:${meta.demo_id}`,
    ];
  }

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
      // Atomic with the cancellation tombstone check: a checkout.session
      // .completed delivered AFTER the owner already cancelled that same
      // subscription (cancel-just-after-signup, out-of-order delivery) must not
      // re-activate the org. A NEW subscription id (a reactivation) applies.
      const applied = await applyStripeSubscriptionState({
        orgId: meta.org_id,
        subscriptionId: subId,
        customerId,
        status: "active",
        nextRenewalAt: null,
      });
      if (applied === "ignored_cancelled_subscription") {
        out.push(`subscription_start_ignored:cancelled:${subId}`);
      } else {
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

  // A subscription reported "canceled" is TERMINAL. It takes the same
  // exactly-once revocation path as customer.subscription.deleted.
  if (sub.status === "canceled") {
    return confirmSubscriptionTerminated(event, orgId, sub);
  }

  const nextRenewalRaw = (sub as unknown as { current_period_end?: number })
    .current_period_end;
  const nextRenewal =
    typeof nextRenewalRaw === "number" && nextRenewalRaw > 0
      ? new Date(nextRenewalRaw * 1000).toISOString()
      : null;

  // The org-status write is atomic with the cancellation TOMBSTONE check
  // (apply_stripe_subscription_state, migration 20261317000000). Stripe delivers
  // at-least-once and out of order: an `updated` (active / past_due) created
  // just before a cancel can land long after it. Applying it would lift a
  // cancelled org back to active — free access forever — so an event for a
  // subscription id already confirmed cancelled writes NOTHING.
  const applied = await applyStripeSubscriptionState({
    orgId,
    subscriptionId: sub.id,
    customerId,
    status:
      sub.status === "active" || sub.status === "trialing"
        ? "active"
        : sub.status === "past_due" || sub.status === "unpaid"
          ? "suspended"
          : null,
    nextRenewalAt: nextRenewal,
  });

  if (applied !== "applied") {
    await recordAdminActivity({
      actorId: null,
      actorEmail: null,
      action: "stripe.subscription_upsert_ignored",
      targetTable: "organizations",
      targetId: orgId,
      metadata: {
        stripe_subscription_id: sub.id,
        status: sub.status,
        outcome: applied,
        event_type: event.type,
      },
    });
    return [`subscription_ignored:${applied}:${sub.status}`];
  }

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

  // P3W2: mirror onto the org_subscriptions projection (best-effort, additive).
  await projectOrgSubscription(orgId, sub);

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
  return confirmSubscriptionTerminated(event, orgId, sub);
}

/**
 * A Stripe subscription has TERMINATED (customer.subscription.deleted, or an
 * `updated` carrying status "canceled").
 *
 * REVOKE ACCESS — exactly once. The access gate (requireOrgContext →
 * orgHasActiveAccess) authorises only on `organizations.status` (active/trial),
 * so a terminated subscription must flip it to `cancelled` or a churned tenant
 * keeps full product access. The flip is done by
 * confirm_subscription_cancellation (migration 20261317000000), under the org
 * row lock, and only for the FIRST confirmation of this subscription id:
 *
 *   • the owner cancelled in-app and the action already confirmed → this is a
 *     no-op (no second revoke, no second HQ alert, no second email);
 *   • this webhook arrives first (dashboard cancel, dunning exhausted, or the
 *     action timed out after Stripe accepted it) → it revokes, and the action,
 *     if still running, becomes the no-op;
 *   • the same event redelivered → already deduped by billing_events, and a
 *     no-op here regardless;
 *   • the org has since moved to a NEW live subscription (reactivated) → the
 *     old id is tombstoned but the new access is left alone.
 *
 * It also writes the TOMBSTONE that stops a late/out-of-order
 * customer.subscription.updated resurrecting this subscription (see
 * handleSubscriptionUpsert). This only GATES access (→ /access-pending and the
 * owner's /account/billing); it never deletes tenant data.
 */
async function confirmSubscriptionTerminated(
  event: Stripe.Event,
  orgId: string,
  sub: Stripe.Subscription,
): Promise<string[]> {
  const confirmed = await confirmCancellationRpc({
    orgId,
    subscriptionId: sub.id,
    via: "webhook",
    details: { stripe_event_type: event.type, stripe_status: sub.status },
  });

  await recordAdminActivity({
    actorId: null,
    actorEmail: null,
    action: "stripe.subscription_deleted",
    targetTable: "organizations",
    targetId: orgId,
    metadata: {
      stripe_subscription_id: sub.id,
      status: sub.status,
      event_type: event.type,
      newly_confirmed: confirmed.newlyConfirmed,
      access_revoked: confirmed.accessRevoked,
      cancellation_source: confirmed.source,
    },
  });

  // P3W2: mirror the terminal status onto the org_subscriptions projection
  // (best-effort, additive) so the tenant billing surface reflects the cancel.
  await projectOrgSubscription(orgId, sub);

  if (!confirmed.newlyConfirmed) {
    return ["subscription_deleted:already_confirmed"];
  }

  // Loud HQ notification — first confirmation only.
  await emitNotifications(
    notifyOnSubscriptionCancelled({
      org_id: orgId,
      stripe_subscription_id: sub.id,
    }),
  );

  // The owner cancelled in-app but the action never got to confirm (it timed
  // out after Stripe accepted the cancel, or lost the race to this webhook):
  // this is where they get their confirmation email — once.
  if (confirmed.source === "owner" && confirmed.requestedByEmail) {
    try {
      const org = await loadCancellationOrg(orgId);
      await sendCancellationConfirmationEmail({
        to: confirmed.requestedByEmail,
        orgName: org?.name ?? "your company",
        hadSubscription: true,
      });
    } catch (e) {
      console.error("[stripe-webhook] cancellation confirmation email failed", {
        org_id: orgId,
        subscription_id: sub.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  await recomputeHealthForOrg(orgId, "payment_change", null);
  return [
    confirmed.accessRevoked
      ? "subscription_deleted:org_cancelled"
      : "subscription_deleted:tombstoned_stale_subscription",
  ];
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
    kind: invoiceSubscriptionId(inv) ? "subscription" : "setup_fee",
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

  // A payment failure for a subscription the customer has ALREADY CANCELLED
  // (a late/out-of-order event, or a final dunning attempt Stripe had queued)
  // must not tell them to "update your payment method to avoid service
  // interruption" — they cancelled, and we promised not to collect. The
  // accounting row and the HQ alert are still written.
  const failedSubId = invoiceSubscriptionId(inv);
  const afterCancellation = failedSubId
    ? await isSubscriptionTombstoned(orgId, failedSubId)
    : false;

  await adminTable("billing_invoices")
    .update({
      status: "failed",
      failed_at: failedAt,
      failure_reason: failureReason,
    })
    .eq("stripe_invoice_id", inv.id);
  await adminTable("billing_invoices").insert({
    org_id: orgId,
    kind: invoiceSubscriptionId(inv) ? "subscription" : "setup_fee",
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
  const failedPaymentNotices = notifyOnFailedPayment({
    org_id: orgId,
    amount_gbp: amount,
    stripe_invoice_id: inv.id,
    reason: failureReason,
  });
  await emitNotifications(
    afterCancellation
      ? failedPaymentNotices.filter((n) => n.audience === "hq")
      : failedPaymentNotices,
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
      after_cancellation: afterCancellation,
    },
  });

  await recomputeHealthForOrg(orgId, "payment_change", null);
  return [
    afterCancellation
      ? `invoice_failed_after_cancellation:${inv.id}`
      : `invoice_failed:${inv.id}`,
  ];
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

/**
 * Mark an event TERMINALLY handled.
 *
 * `processed_at` is the "never run this again" flag: the duplicate branch in
 * processStripeEvent short-circuits on it, so it must be stamped ONLY when the
 * dispatch genuinely finished — success ("ok") or a deliberate no-op ("noop").
 * Failures go to markFailed, which leaves it NULL.
 *
 * error_message is cleared here on purpose: a successful retry of a previously
 * failed event should not leave the old error behind.
 */
async function markProcessed(eventId: string, note: string): Promise<void> {
  // Success is terminal: processed_at stamped (never reclaimed thereafter, even
  // with an old claimed_at) and any stale error cleared. claimed_at is left as
  // it is — processed_at, not the lease, is what makes a row terminal.
  const res = await adminTable("billing_events")
    .update({
      processed_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("event_id", eventId);
  void note;
  // Supabase returns { error } rather than throwing — check it explicitly.
  if (res.error) {
    console.error("[stripe-webhook] markProcessed failed", {
      event_id: eventId,
      message: res.error.message,
    });
  }
}

/**
 * Record a FAILED dispatch without marking the event processed.
 *
 * This is the crux of at-least-once delivery. Previously the failure path
 * called markProcessed, which stamped `processed_at` — and because the
 * duplicate branch short-circuited on row EXISTENCE, Stripe's retry then found
 * the row, returned "duplicate", and never ran the handler. A transient blip
 * (e.g. one flaky call inside handleCheckoutCompleted) permanently dropped the
 * event: the tenant had paid, but their org never activated, no billing_invoice
 * row was written and no notification fired. The only trace was
 * billing_events.error_message.
 *
 * Leaving `processed_at` NULL keeps the row retryable, so Stripe's at-least-once
 * delivery does what it is designed to do.
 */
async function markFailed(eventId: string, error: string): Promise<void> {
  // Release the claim without completing: error_message set, processed_at left
  // NULL. That combination is reclaimable IMMEDIATELY (the reclaim's
  // `error_message IS NOT NULL` branch) — a retry need not wait out the lease,
  // because a live handler recorded this and nothing is in flight.
  const res = await adminTable("billing_events")
    .update({ error_message: error })
    .eq("event_id", eventId);
  // Supabase returns { error } rather than throwing — check it explicitly.
  if (res.error) {
    console.error("[stripe-webhook] markFailed failed", {
      event_id: eventId,
      message: res.error.message,
    });
  }
}
