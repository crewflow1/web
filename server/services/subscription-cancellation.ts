import "server-only";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { getStripe } from "@/lib/stripe/client";
import { sendEmail } from "@/lib/email/send";
import { env } from "@/lib/env";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import {
  wireSelfServeBillingDeps,
  syncOrgSubscriptionFromStripe,
} from "@/server/services/self-serve-billing";
import type { NotificationCreate } from "@/lib/notifications/types";
import type { StripeSubscriptionShape } from "@/lib/billing/subscription-state";
import {
  cancellationIdempotencyKey,
  classifyStripeCancelError,
  computeRefundReview,
  isLiveStripeSubscriptionStatus,
  isSelfServeCancellationDisabled,
  type RefundReview,
} from "@/lib/billing/cancellation";
import { buildCancellationEmail } from "@/lib/billing/cancellation-email";

/**
 * Self-serve subscription CANCELLATION — the service.
 *
 * An org owner cancels CrewFlow; the Stripe subscription is terminated
 * IMMEDIATELY, access is revoked exactly once, and they are never charged
 * again. Design: docs/programme/cancellation/CANCELLATION-DESIGN.md.
 *
 * DEPENDENCY-INJECTED (the self-serve-billing idiom) so every branch — already
 * cancelled, no subscription, Stripe refusal, Stripe timeout, a concurrent
 * claim, a foreign subscription id — is provable with NO Stripe and NO
 * database. The concrete wiring is wireCancellationDeps() at the bottom.
 *
 * ── INVARIANTS ──────────────────────────────────────────────────────────────
 *  I1  The caller passes an org id it derived from the SESSION + the caller's
 *      own membership. This module never reads an org id from request input.
 *  I2  We never tell the customer "cancelled" unless Stripe confirmed
 *      termination, or there is provably nothing in Stripe to terminate. If the
 *      org is linked to Stripe and Stripe is unreachable/unconfigured, the
 *      answer is a refusal and NOTHING changes locally.
 *  I3  STRIPE IS THE TRUTH FOR "CAN STILL BILL". We cancel every LIVE
 *      subscription on the org's Stripe customer, not just the id we happen to
 *      have stored — a stale local id must not leave a second subscription
 *      charging.
 *  I4  We never cancel a subscription we cannot tie to this org (customer id
 *      match, or metadata.org_id when the org has no customer id).
 *  I5  No money moves. `prorate: false`, `invoice_now: false`; no refund, no
 *      credit note, no void. Refunds owed under the terms are flagged for a
 *      human (refund_review = 'pending').
 *  I6  Revocation and the owner's confirmation email happen ONCE, whichever of
 *      this action and the Stripe webhook confirms first
 *      (confirm_subscription_cancellation, migration 20261317000000). HQ is
 *      told at least once; if the webhook wins the race it sends its generic
 *      alert and this action still sends the detailed one (refund review,
 *      invoices) — two HQ notices for one cancellation, never zero.
 *
 * NOT gated on the self-serve-billing flag: the published terms promise
 * "cancel at any time from the settings page" to founder-provisioned customers.
 * The only switch is the incident kill switch
 * (BILLING_SELF_SERVE_CANCELLATION_DISABLED).
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type CancellationOrg = {
  id: string;
  name: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

export type CancelActor = { userId: string; email: string | null };

/**
 * Who started the cancellation. `owner` = the org's owner, self-serve. `hq` = a
 * CrewFlow operator using the HQ "Cancel" lifecycle action. Same Stripe call,
 * same ledger, same refund-review flag; they differ only in: the kill switch
 * (self-serve only), the audit action name, and the confirmation email (an HQ
 * operator is not sent "you cancelled").
 */
export type CancelInitiator = "owner" | "hq";

/** The subset of a Stripe Subscription this module reasons about. */
export type SubscriptionSnapshot = {
  id: string;
  status: string;
  customerId: string | null;
  metadataOrgId: string | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  unitAmountMinor: number | null;
  quantity: number | null;
  currency: string | null;
  /** The raw object, for the org_subscriptions projection. */
  shape: StripeSubscriptionShape;
};

export type ClaimOutcome = "claimed" | "in_flight" | "already_confirmed" | "org_not_found";

export type ConfirmResult = {
  newlyConfirmed: boolean;
  accessRevoked: boolean;
  cancellationId: string | null;
  source: string | null;
  requestedByEmail: string | null;
  priorOrgStatus: string | null;
};

export type InvoiceCollectionResult = {
  /** Invoice ids whose automatic collection was switched off. */
  stopped: string[];
  /** Invoice ids (or a sentinel) we could NOT switch off — HQ must check. */
  failed: string[];
};

export type CancellationAudit = {
  action: string;
  orgId: string;
  actor: CancelActor | null;
  metadata: Record<string, unknown>;
};

export type CancellationDeps = {
  isDisabled: () => boolean;
  /** True when the SaaS Stripe client can be constructed (key present). */
  stripeAvailable: () => boolean;
  /** Unix seconds. */
  now: () => number;
  loadOrg: (orgId: string) => Promise<CancellationOrg | null>;
  claim: (args: {
    orgId: string;
    subscriptionId: string | null;
    actor: CancelActor;
    reason: string | null;
    source: CancelInitiator;
  }) => Promise<{ outcome: ClaimOutcome; cancellationId: string | null }>;
  confirm: (args: {
    orgId: string;
    subscriptionId: string | null;
    via: "action" | "webhook";
    details: Record<string, unknown>;
    cancellationId?: string | null;
    forceRevoke?: boolean;
    refundReview?: "pending" | "not_applicable" | null;
  }) => Promise<ConfirmResult>;
  release: (cancellationId: string, error: string) => Promise<void>;
  stripe: {
    /** The customer's subscriptions that Stripe has NOT cancelled. */
    listCustomerSubscriptions: (customerId: string) => Promise<SubscriptionSnapshot[]>;
    /** null when Stripe has no such subscription. */
    retrieveSubscription: (subscriptionId: string) => Promise<SubscriptionSnapshot | null>;
    cancelSubscription: (
      subscriptionId: string,
      opts: { idempotencyKey: string },
    ) => Promise<SubscriptionSnapshot>;
    stopInvoiceCollection: (subscriptionId: string) => Promise<InvoiceCollectionResult>;
    /** Count of pending (un-invoiced) invoice items on the customer. */
    countPendingInvoiceItems: (customerId: string) => Promise<number>;
  };
  projectSubscription: (orgId: string, shape: StripeSubscriptionShape) => Promise<void>;
  recordAudit: (entry: CancellationAudit) => Promise<void>;
  notifyHq: (notice: NotificationCreate) => Promise<void>;
  sendOwnerEmail: (args: {
    to: string;
    orgName: string;
    hadSubscription: boolean;
  }) => Promise<{ sent: boolean; reason?: string }>;
};

export type CancelFailureReason =
  | "disabled"
  | "org_not_found"
  | "in_progress"
  | "billing_unavailable"
  | "billing_mismatch"
  | "stripe_timeout"
  | "stripe_error";

export type CancelResult =
  | {
      ok: true;
      outcome: "cancelled" | "already_cancelled";
      accessRevoked: boolean;
      /** Stripe subscription ids terminated by THIS call. */
      subscriptionsCancelled: string[];
      refundReview: "pending" | "not_applicable";
      emailSent: boolean;
    }
  | { ok: false; reason: CancelFailureReason };

const fail = (reason: CancelFailureReason): CancelResult => ({ ok: false, reason });

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// HQ notices
// ---------------------------------------------------------------------------

function gbpFromMinor(minor: number | null, currency: string | null): string {
  if (minor === null) return "unknown";
  return `${(minor / 100).toFixed(2)} ${currency ?? "GBP"}`;
}

function hqNotice(
  org: CancellationOrg,
  type: string,
  priority: "high" | "urgent",
  title: string,
  body: string,
  sourceId: string | null,
  metadata: Record<string, unknown>,
): NotificationCreate {
  return {
    org_id: org.id,
    user_id: null,
    audience: "hq",
    type,
    category: "stripe",
    priority,
    title,
    body,
    action_url: `/admin/customers/${org.id}`,
    source_module: "stripe",
    source_id: sourceId,
    metadata,
    // Also by email to the configured HQ recipients (none configured → nothing
    // is queued): a cancellation can carry a refund obligation with a deadline.
    email: {},
  };
}

// ---------------------------------------------------------------------------
// Target resolution — which Stripe subscriptions must be terminated
// ---------------------------------------------------------------------------

type Targets =
  | { kind: "ok"; live: SubscriptionSnapshot[]; recordedDead: SubscriptionSnapshot | null }
  | { kind: "mismatch"; detail: string };

async function resolveTargets(
  deps: CancellationDeps,
  org: CancellationOrg,
): Promise<Targets> {
  const subs: SubscriptionSnapshot[] = org.stripe_customer_id
    ? await deps.stripe.listCustomerSubscriptions(org.stripe_customer_id)
    : [];

  const recordedId = org.stripe_subscription_id;
  if (recordedId && !subs.some((s) => s.id === recordedId)) {
    const recorded = await deps.stripe.retrieveSubscription(recordedId);
    if (recorded) {
      // I4 — never act on a subscription we cannot tie to this org.
      const owned = org.stripe_customer_id
        ? recorded.customerId === org.stripe_customer_id
        : recorded.metadataOrgId === org.id;
      if (!owned) {
        return {
          kind: "mismatch",
          detail: org.stripe_customer_id
            ? "recorded subscription belongs to a different Stripe customer"
            : "recorded subscription carries no matching org_id metadata and the org has no Stripe customer id",
        };
      }
      subs.push(recorded);
    }
  }

  return {
    kind: "ok",
    live: subs.filter((s) => isLiveStripeSubscriptionStatus(s.status)),
    recordedDead:
      subs.find((s) => s.id === recordedId && !isLiveStripeSubscriptionStatus(s.status)) ?? null,
  };
}

// ---------------------------------------------------------------------------
// cancelOrgSubscription
// ---------------------------------------------------------------------------

export async function cancelOrgSubscription(
  deps: CancellationDeps,
  args: {
    orgId: string;
    actor: CancelActor;
    reason?: string | null;
    initiator?: CancelInitiator;
  },
): Promise<CancelResult> {
  const initiator: CancelInitiator = args.initiator ?? "owner";
  // The kill switch turns off SELF-SERVE cancellation. HQ must still be able to
  // stop a customer's billing during the very incident it exists for.
  if (initiator === "owner" && deps.isDisabled()) return fail("disabled");

  const org = await deps.loadOrg(args.orgId);
  if (!org) return fail("org_not_found");

  const reason = args.reason?.trim() ? args.reason.trim().slice(0, 1000) : null;
  const linkedToStripe = Boolean(org.stripe_customer_id || org.stripe_subscription_id);

  let live: SubscriptionSnapshot[] = [];
  let recordedDead: SubscriptionSnapshot | null = null;

  if (linkedToStripe) {
    // I2 — linked to Stripe but we cannot talk to Stripe: refuse, change nothing.
    if (!deps.stripeAvailable()) {
      await deps.recordAudit({
        action: "billing.subscription_cancel_failed",
        orgId: org.id,
        actor: args.actor,
        metadata: { reason: "billing_unavailable", detail: "stripe not configured" },
      });
      return fail("billing_unavailable");
    }
    let targets: Targets;
    try {
      targets = await resolveTargets(deps, org);
    } catch (e) {
      await deps.recordAudit({
        action: "billing.subscription_cancel_failed",
        orgId: org.id,
        actor: args.actor,
        metadata: { reason: "billing_unavailable", detail: errText(e) },
      });
      return fail("billing_unavailable");
    }
    if (targets.kind === "mismatch") {
      await deps.recordAudit({
        action: "billing.subscription_cancel_failed",
        orgId: org.id,
        actor: args.actor,
        metadata: { reason: "billing_mismatch", detail: targets.detail },
      });
      await deps.notifyHq(
        hqNotice(
          org,
          "stripe.subscription_cancel_blocked",
          "urgent",
          "Owner tried to cancel — subscription could not be matched",
          `The owner asked to cancel but ${targets.detail}. Nothing was cancelled. Cancel the subscription for them in Stripe and mark the workspace cancelled.`,
          org.stripe_subscription_id,
          { detail: targets.detail },
        ),
      );
      return fail("billing_mismatch");
    }
    live = targets.live;
    recordedDead = targets.recordedDead;
  }

  // ── Nothing in Stripe can still bill ──────────────────────────────────────
  if (live.length === 0) {
    const alreadyCancelled: CancelResult = {
      ok: true,
      outcome: "already_cancelled",
      accessRevoked: false,
      subscriptionsCancelled: [],
      refundReview: "not_applicable",
      emailSent: false,
    };

    // The recorded subscription is already dead at Stripe but was never
    // tombstoned here (a webhook missed, or a cancellation that pre-dates the
    // ledger). Tombstone that id now.
    if (recordedDead) {
      const claim = await deps.claim({
        orgId: org.id,
        subscriptionId: recordedDead.id,
        actor: args.actor,
        reason,
        source: initiator,
      });
      if (claim.outcome === "org_not_found") return fail("org_not_found");
      if (claim.outcome === "in_flight") return fail("in_progress");
      if (claim.outcome === "claimed") {
        const confirmed = await deps.confirm({
          orgId: org.id,
          subscriptionId: recordedDead.id,
          via: "action",
          forceRevoke: true,
          refundReview: "not_applicable",
          details: { note: "subscription already terminated at Stripe", stripe_status: recordedDead.status },
        });
        // The org was already cancelled: this only recorded what was already
        // true. No alert, no email — nothing happened that anyone needs telling.
        if (org.status === "cancelled") return alreadyCancelled;
        return finish(deps, org, args.actor, reason, initiator, {
          confirms: [confirmed],
          subscriptionsCancelled: [],
          refund: null,
          collection: null,
          pendingItems: null,
          hadSubscription: true,
        });
      }
      // already_confirmed: that id is tombstoned. If the org is nonetheless not
      // cancelled it was reactivated by hand with no new subscription — fall
      // through to a local-only cancellation.
    }

    if (org.status === "cancelled") return alreadyCancelled;

    const claim = await deps.claim({
      orgId: org.id,
      subscriptionId: null,
      actor: args.actor,
      reason,
      source: initiator,
    });
    if (claim.outcome === "org_not_found") return fail("org_not_found");
    if (claim.outcome === "in_flight") return fail("in_progress");
    if (claim.outcome === "already_confirmed") return alreadyCancelled;
    const confirmed = await deps.confirm({
      orgId: org.id,
      subscriptionId: null,
      cancellationId: claim.cancellationId,
      via: "action",
      forceRevoke: true,
      refundReview: "not_applicable",
      details: { note: "no live Stripe subscription", linked_to_stripe: linkedToStripe },
    });
    return finish(deps, org, args.actor, reason, initiator, {
      confirms: [confirmed],
      subscriptionsCancelled: [],
      refund: null,
      collection: null,
      pendingItems: null,
      hadSubscription: false,
    });
  }

  // ── Terminate every live subscription ─────────────────────────────────────
  const confirms: ConfirmResult[] = [];
  const cancelledIds: string[] = [];
  const collection: InvoiceCollectionResult = { stopped: [], failed: [] };
  let refund: RefundReview | null = null;
  let confirmFailed = false;

  for (let i = 0; i < live.length; i++) {
    const sub = live[i]!;
    const claim = await deps.claim({
      orgId: org.id,
      subscriptionId: sub.id,
      actor: args.actor,
      reason,
      source: initiator,
    });
    if (claim.outcome === "org_not_found") return fail("org_not_found");
    if (claim.outcome === "in_flight") return fail("in_progress");
    // `already_confirmed` with a subscription Stripe says is LIVE is a
    // contradiction; Stripe is the truth (I3), so we still terminate it.
    const holdsClaim = claim.outcome === "claimed" && claim.cancellationId !== null;

    let cancelled: SubscriptionSnapshot;
    try {
      cancelled = await deps.stripe.cancelSubscription(sub.id, {
        idempotencyKey: cancellationIdempotencyKey(org.id, sub.id),
      });
    } catch (e) {
      const kind = classifyStripeCancelError(e);
      // Whatever Stripe said, ask it what the subscription's state IS. A cancel
      // that raced another cancel reports an error on a subscription that is,
      // in fact, terminated — which is success.
      let after: SubscriptionSnapshot | null | undefined;
      try {
        after = await deps.stripe.retrieveSubscription(sub.id);
      } catch {
        after = undefined; // could not verify
      }
      const terminated =
        after === null || (after !== undefined && !isLiveStripeSubscriptionStatus(after.status));
      if (!terminated) {
        if (holdsClaim) await deps.release(claim.cancellationId!, `${kind}: ${errText(e)}`);
        await deps.recordAudit({
          action: "billing.subscription_cancel_failed",
          orgId: org.id,
          actor: args.actor,
          metadata: {
            reason: kind === "timeout" ? "stripe_timeout" : "stripe_error",
            stripe_error_kind: kind,
            stripe_subscription_id: sub.id,
            detail: errText(e),
            verified_state: after === undefined ? "unverified" : (after?.status ?? "missing"),
          },
        });
        return fail(kind === "timeout" ? "stripe_timeout" : "stripe_error");
      }
      cancelled = after ?? { ...sub, status: "canceled" };
    }

    if (isLiveStripeSubscriptionStatus(cancelled.status)) {
      // Stripe answered 200 but the subscription is still live. Never report
      // that as cancelled.
      if (holdsClaim) {
        await deps.release(claim.cancellationId!, `stripe returned status ${cancelled.status}`);
      }
      await deps.recordAudit({
        action: "billing.subscription_cancel_failed",
        orgId: org.id,
        actor: args.actor,
        metadata: {
          reason: "stripe_error",
          stripe_subscription_id: sub.id,
          detail: `cancel returned status ${cancelled.status}`,
        },
      });
      return fail("stripe_error");
    }
    cancelledIds.push(sub.id);

    // Belt and braces on "never charged again": Stripe documents that it stops
    // automatic collection of finalized invoices on cancel; we also switch it
    // off explicitly for this subscription's open AND draft invoices, so a
    // past-due invoice stops retrying and a just-created renewal draft never
    // finalises. Best-effort — a failure is reported to HQ, never to the user.
    try {
      const c = await deps.stripe.stopInvoiceCollection(sub.id);
      collection.stopped.push(...c.stopped);
      collection.failed.push(...c.failed);
    } catch (e) {
      collection.failed.push(`list_failed:${sub.id}`);
      console.error("[subscription-cancellation] stopInvoiceCollection failed", {
        org_id: org.id,
        subscription_id: sub.id,
        error: errText(e),
      });
    }

    const review = computeRefundReview({
      statusBeforeCancel: sub.status,
      currentPeriodStart: cancelled.currentPeriodStart ?? sub.currentPeriodStart,
      currentPeriodEnd: cancelled.currentPeriodEnd ?? sub.currentPeriodEnd,
      unitAmountMinor: cancelled.unitAmountMinor ?? sub.unitAmountMinor,
      quantity: cancelled.quantity ?? sub.quantity,
      currency: cancelled.currency ?? sub.currency,
      cancelledAt: deps.now(),
    });
    if (!refund || review.review === "pending") refund = review;

    try {
      confirms.push(
        await deps.confirm({
          orgId: org.id,
          subscriptionId: sub.id,
          via: "action",
          // The last one forces the revoke: every live subscription is now gone.
          forceRevoke: i === live.length - 1,
          refundReview: review.review,
          details: {
            stripe_status_before: sub.status,
            refund_basis: review.basis,
            refund_estimate_minor: review.estimateMinor,
            refund_currency: review.currency,
            unused_fraction: review.unusedFraction,
            period_start: review.periodStart,
            period_end: review.periodEnd,
            invoices_collection_stopped: collection.stopped,
            invoices_collection_stop_failed: collection.failed,
          },
        }),
      );
    } catch (e) {
      // Stripe HAS terminated the subscription; only our own bookkeeping failed.
      // The customer is no longer billable, which is what they asked for, so
      // this is not reported to them as a failure. The
      // customer.subscription.deleted webhook confirms + revokes (I6).
      confirmFailed = true;
      console.error("[subscription-cancellation] confirm failed after Stripe cancel", {
        org_id: org.id,
        subscription_id: sub.id,
        error: errText(e),
      });
      await deps.recordAudit({
        action: "billing.subscription_cancel_confirm_deferred",
        orgId: org.id,
        actor: args.actor,
        metadata: { stripe_subscription_id: sub.id, detail: errText(e) },
      });
    }

    try {
      await deps.projectSubscription(org.id, cancelled.shape);
    } catch (e) {
      console.error("[subscription-cancellation] projection failed", {
        org_id: org.id,
        subscription_id: sub.id,
        error: errText(e),
      });
    }
  }

  let pendingItems: number | null = null;
  if (org.stripe_customer_id) {
    try {
      pendingItems = await deps.stripe.countPendingInvoiceItems(org.stripe_customer_id);
    } catch {
      pendingItems = null;
    }
  }

  return finish(deps, org, args.actor, reason, initiator, {
    confirms,
    subscriptionsCancelled: cancelledIds,
    refund,
    collection,
    pendingItems,
    hadSubscription: true,
    confirmFailed,
  });
}

/** Audit + HQ alert + owner email, once, then the result. */
async function finish(
  deps: CancellationDeps,
  org: CancellationOrg,
  actor: CancelActor,
  reason: string | null,
  initiator: CancelInitiator,
  r: {
    confirms: ConfirmResult[];
    subscriptionsCancelled: string[];
    refund: RefundReview | null;
    collection: InvoiceCollectionResult | null;
    pendingItems: number | null;
    hadSubscription: boolean;
    confirmFailed?: boolean;
  },
): Promise<CancelResult> {
  const newly = r.confirms.some((c) => c.newlyConfirmed);
  const revoked = r.confirms.some((c) => c.accessRevoked);
  const refundReview = r.refund?.review ?? "not_applicable";
  let emailSent = false;

  // I6: `newly` is true for exactly one confirmer per subscription id.
  const actedOnStripe = r.subscriptionsCancelled.length > 0;
  if (newly || revoked || actedOnStripe) {
    await deps.recordAudit({
      action:
        initiator === "hq"
          ? "billing.subscription_cancelled_by_hq"
          : "billing.subscription_cancelled_by_owner",
      orgId: org.id,
      actor,
      metadata: {
        stripe_subscription_ids: r.subscriptionsCancelled,
        access_revoked: revoked,
        prior_org_status: r.confirms.find((c) => c.priorOrgStatus)?.priorOrgStatus ?? org.status,
        had_subscription: r.hadSubscription,
        refund_review: refundReview,
        refund_basis: r.refund?.basis ?? null,
        refund_estimate_minor: r.refund?.estimateMinor ?? null,
        refund_currency: r.refund?.currency ?? null,
        invoices_collection_stopped: r.collection?.stopped ?? [],
        invoices_collection_stop_failed: r.collection?.failed ?? [],
        pending_invoice_items: r.pendingItems,
        local_confirm_deferred_to_webhook: r.confirmFailed === true,
        reason_given: reason !== null,
      },
    });
  }

  // HQ always hears from the caller that terminated the subscription, because
  // only it knows the refund review and which invoices it stopped collecting.
  if (newly || revoked || actedOnStripe) {
    const who =
      initiator === "hq"
        ? `HQ (${actor.email ?? "unknown operator"}) cancelled this workspace.`
        : "The owner cancelled in-app.";
    const lines: string[] = [
      r.hadSubscription
        ? `${who} Stripe subscription terminated immediately; workspace access ${revoked ? "revoked" : "was already revoked"}.`
        : `${who} There was no live Stripe subscription; workspace access ${revoked ? "revoked" : "was already revoked"}. Check for any manual billing arrangement.`,
    ];
    if (refundReview === "pending") {
      lines.push(
        `REFUND REVIEW DUE (terms: pro-rata for unused prepaid time). Estimate ${gbpFromMinor(r.refund?.estimateMinor ?? null, r.refund?.currency ?? null)} before tax/discounts — nothing was refunded automatically.`,
      );
    }
    if (r.collection && r.collection.stopped.length > 0) {
      lines.push(
        `Automatic collection switched off on ${r.collection.stopped.length} unpaid/draft invoice(s); they remain outstanding — decide whether to chase or void.`,
      );
    }
    if (r.collection && r.collection.failed.length > 0) {
      lines.push(
        `COULD NOT switch off collection on ${r.collection.failed.length} invoice(s) — check the customer's invoices in Stripe now.`,
      );
    }
    if (r.pendingItems && r.pendingItems > 0) {
      lines.push(
        `${r.pendingItems} pending invoice item(s) remain on the Stripe customer — delete them or Stripe may still invoice them.`,
      );
    }
    if (reason) lines.push(`Reason given: ${reason}`);
    await deps.notifyHq(
      hqNotice(
        org,
        "stripe.subscription_cancelled",
        "urgent",
        initiator === "hq" ? "Subscription cancelled by HQ" : "Subscription cancelled by owner",
        lines.join(" "),
        r.subscriptionsCancelled[0] ?? null,
        {
          refund_review: refundReview,
          refund_estimate_minor: r.refund?.estimateMinor ?? null,
          stripe_subscription_ids: r.subscriptionsCancelled,
        },
      ),
    );
  }

  // The owner's email is keyed on `newly` alone: if the webhook confirmed first
  // it has already sent it (see confirmSubscriptionTerminated).
  // …and it goes to an OWNER who cancelled. An HQ operator is the actor on an
  // HQ cancel; they must not be emailed "your subscription is cancelled".
  if (newly && initiator === "owner" && actor.email) {
    try {
      const sent = await deps.sendOwnerEmail({
        to: actor.email,
        orgName: org.name,
        hadSubscription: r.hadSubscription,
      });
      emailSent = sent.sent;
    } catch (e) {
      console.error("[subscription-cancellation] owner email failed", {
        org_id: org.id,
        error: errText(e),
      });
    }
  }

  return {
    ok: true,
    outcome: "cancelled",
    accessRevoked: revoked,
    subscriptionsCancelled: r.subscriptionsCancelled,
    refundReview,
    emailSent,
  };
}

// ---------------------------------------------------------------------------
// HQ-initiated cancellation — stop billing BEFORE the org is marked cancelled
// ---------------------------------------------------------------------------

/**
 * What an HQ operator is told when billing could NOT be stopped. In every one
 * of these cases the organisation is LEFT AS IT WAS.
 */
export const HQ_CANCEL_ERROR_COPY: Record<CancelFailureReason, string> = {
  disabled: "Cancellation is switched off.",
  org_not_found: "That organisation no longer exists.",
  in_progress:
    "A cancellation for this customer is already in flight (the owner may have just clicked cancel). Reload in a moment — nothing was changed by this click.",
  billing_unavailable:
    "NOT cancelled. Stripe could not be reached (or the Stripe key is not set in this environment), so billing could not be stopped. Try again, or cancel the subscription in the Stripe dashboard — the workspace is marked cancelled automatically when Stripe confirms.",
  billing_mismatch:
    "NOT cancelled. The subscription id recorded for this organisation could not be matched to its Stripe customer, so nothing was touched. Check the customer in the Stripe dashboard and cancel the subscription there.",
  stripe_timeout:
    "NOT cancelled. Stripe did not confirm the cancellation in time. Try again — it is safe to repeat. If Stripe did accept it, the workspace is marked cancelled automatically when the webhook arrives.",
  stripe_error:
    "NOT cancelled. Stripe refused to cancel the subscription, so billing is still active. Check the customer in the Stripe dashboard.",
};

export type HqCancelResult =
  | { ok: true; result: Extract<CancelResult, { ok: true }> }
  | { ok: false; reason: CancelFailureReason; message: string };

/**
 * The gate every HQ "mark cancelled" action must pass FIRST.
 *
 * Before this existed, HQ's cancel flipped organizations.status to 'cancelled'
 * and never touched Stripe: the customer was locked out of the product and
 * still charged every month.
 *
 * It runs the SAME path as the owner's self-serve cancel — every live
 * subscription terminated immediately, invoice collection stopped, the refund
 * review flagged, the ledger tombstoned, the org revoked by
 * confirm_subscription_cancellation. On success the org is ALREADY 'cancelled'
 * when this returns.
 *
 * ON FAILURE THE ORG IS NOT MARKED CANCELLED. That is the safer of the two
 * options ("refuse" vs "cancel but flag billing-still-active"), because
 * 'cancelled' is the state that locks the customer out: locked-out-and-billed
 * is exactly the harm being closed, and a flag on a cancelled org is something
 * an operator can miss, whereas an org that is visibly still active with an
 * error on screen is not. The operator retries or cancels in Stripe; the
 * webhook then revokes access on its own.
 */
export async function stopBillingForHqCancellation(
  deps: CancellationDeps,
  args: { orgId: string; actor: CancelActor; reason?: string | null },
): Promise<HqCancelResult> {
  let result: CancelResult;
  try {
    result = await cancelOrgSubscription(deps, { ...args, initiator: "hq" });
  } catch (e) {
    console.error("[subscription-cancellation] HQ cancel threw", {
      org_id: args.orgId,
      error: errText(e),
    });
    return {
      ok: false,
      reason: "stripe_error",
      message:
        "NOT cancelled. Something failed while stopping billing; check the customer in the Stripe dashboard and reload this page before trying again.",
    };
  }
  if (!result.ok) {
    return { ok: false, reason: result.reason, message: HQ_CANCEL_ERROR_COPY[result.reason] };
  }
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// Reactivation request (self-serve signup is off → HQ re-provisions)
// ---------------------------------------------------------------------------

export type ReactivationDeps = {
  loadOrg: (orgId: string) => Promise<CancellationOrg | null>;
  /** ISO time of the most recent reactivation request for this org, if any. */
  lastReactivationRequestAt: (orgId: string) => Promise<string | null>;
  now: () => number;
  recordAudit: (entry: CancellationAudit) => Promise<void>;
  notifyHq: (notice: NotificationCreate) => Promise<void>;
};

export type ReactivationResult =
  | { ok: true; outcome: "requested" | "already_requested" }
  | { ok: false; reason: "org_not_found" | "not_cancelled" };

/** A repeat request inside this window does not re-alert HQ. */
export const REACTIVATION_REQUEST_DEDUPE_SECONDS = 24 * 60 * 60;

/**
 * Record that the owner of a CANCELLED org wants it back and alert HQ, who
 * re-provision through the existing /admin/customers/[id] subscription
 * checkout (a NEW Stripe subscription — the cancelled one is terminal). No
 * billing happens here.
 */
export async function requestReactivation(
  deps: ReactivationDeps,
  args: { orgId: string; actor: CancelActor },
): Promise<ReactivationResult> {
  const org = await deps.loadOrg(args.orgId);
  if (!org) return { ok: false, reason: "org_not_found" };
  if (org.status !== "cancelled") return { ok: false, reason: "not_cancelled" };

  const last = await deps.lastReactivationRequestAt(org.id);
  if (last) {
    const age = deps.now() - Math.floor(new Date(last).getTime() / 1000);
    if (age >= 0 && age < REACTIVATION_REQUEST_DEDUPE_SECONDS) {
      return { ok: true, outcome: "already_requested" };
    }
  }

  await deps.recordAudit({
    action: "billing.reactivation_requested",
    orgId: org.id,
    actor: args.actor,
    metadata: { org_status: org.status },
  });
  await deps.notifyHq(
    hqNotice(
      org,
      "stripe.reactivation_requested",
      "high",
      "Reactivation requested",
      `The owner (${args.actor.email ?? "unknown email"}) of this cancelled workspace asked to reactivate. Send a new subscription checkout from this customer page; the workspace reactivates when it is paid.`,
      null,
      {},
    ),
  );
  return { ok: true, outcome: "requested" };
}

// ===========================================================================
// CONCRETE WIRING — real Stripe SDK + admin Supabase client. Never imported by
// the hermetic tests; they build their own deps.
// ===========================================================================

/** Per-request Stripe options: fail fast, retry once (network errors only). */
const STRIPE_REQ = { timeout: 12_000, maxNetworkRetries: 1 } as const;

function snapshot(sub: Stripe.Subscription): SubscriptionSnapshot {
  const item = sub.items?.data?.[0];
  // The pinned API version carries the period on the subscription; newer
  // account versions carry it on the item. Read both.
  const itemPeriod = item as unknown as
    | { current_period_start?: number; current_period_end?: number }
    | undefined;
  const top = sub as unknown as { current_period_start?: number; current_period_end?: number };
  return {
    id: sub.id,
    status: sub.status,
    customerId: typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null),
    metadataOrgId: sub.metadata?.org_id ?? null,
    currentPeriodStart: top.current_period_start ?? itemPeriod?.current_period_start ?? null,
    currentPeriodEnd: top.current_period_end ?? itemPeriod?.current_period_end ?? null,
    unitAmountMinor: item?.price?.unit_amount ?? null,
    quantity: item?.quantity ?? null,
    currency: sub.currency ?? item?.price?.currency ?? null,
    shape: sub as unknown as StripeSubscriptionShape,
  };
}

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string | null; code?: string | null } | null }>;
};

function rpcClient(): RpcClient {
  return createAdminClient() as unknown as RpcClient;
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return (data as T | null) ?? null;
}

/** Shared by the action wiring and the webhook handler. */
export async function confirmCancellationRpc(args: {
  orgId: string;
  subscriptionId: string | null;
  via: "action" | "webhook";
  details: Record<string, unknown>;
  cancellationId?: string | null;
  forceRevoke?: boolean;
  refundReview?: "pending" | "not_applicable" | null;
}): Promise<ConfirmResult> {
  const res = await rpcClient().rpc("confirm_subscription_cancellation", {
    p_org_id: args.orgId,
    p_subscription_id: args.subscriptionId,
    p_via: args.via,
    p_details: args.details,
    p_cancellation_id: args.cancellationId ?? null,
    p_force_revoke: args.forceRevoke === true,
    p_refund_review: args.refundReview ?? null,
  });
  if (res.error) {
    throw new Error(`confirm_subscription_cancellation failed: ${res.error.message ?? "unknown"}`);
  }
  const row = firstRow<{
    newly_confirmed: boolean;
    access_revoked: boolean;
    cancellation_id: string | null;
    source: string | null;
    requested_by_email: string | null;
    prior_org_status: string | null;
  }>(res.data);
  if (!row) throw new Error("confirm_subscription_cancellation returned no row");
  return {
    newlyConfirmed: row.newly_confirmed === true,
    accessRevoked: row.access_revoked === true,
    cancellationId: row.cancellation_id,
    source: row.source,
    requestedByEmail: row.requested_by_email,
    priorOrgStatus: row.prior_org_status,
  };
}

export type ApplySubscriptionStateOutcome =
  | "applied"
  | "ignored_cancelled_subscription"
  | "org_not_found";

/**
 * The webhook's access-granting subscription write (subscription.created /
 * .updated, and checkout.session.completed for a subscription): atomic with the
 * tombstone check, so a late or out-of-order event for a cancelled subscription
 * can never lift the org back to active.
 */
export async function applyStripeSubscriptionState(args: {
  orgId: string;
  subscriptionId: string;
  customerId: string | null;
  /** organizations.status to set; null leaves it alone (incomplete / paused). */
  status: "active" | "suspended" | null;
  nextRenewalAt: string | null;
}): Promise<ApplySubscriptionStateOutcome> {
  const res = await rpcClient().rpc("apply_stripe_subscription_state", {
    p_org_id: args.orgId,
    p_subscription_id: args.subscriptionId,
    p_customer_id: args.customerId,
    p_org_status: args.status,
    p_next_renewal_at: args.nextRenewalAt,
  });
  if (res.error) {
    throw new Error(`apply_stripe_subscription_state failed: ${res.error.message ?? "unknown"}`);
  }
  return res.data as ApplySubscriptionStateOutcome;
}

/** Has this Stripe subscription id been confirmed cancelled for this org? */
export async function isSubscriptionTombstoned(
  orgId: string,
  subscriptionId: string,
): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("subscription_cancellations" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => {
              maybeSingle: () => Promise<{
                data: { id: string } | null;
                error: { message?: string | null; code?: string | null } | null;
              }>;
            };
          };
        };
      };
    }
  )
    .select("id")
    .eq("org_id", orgId)
    .eq("stripe_subscription_id", subscriptionId)
    .eq("state", "confirmed")
    .maybeSingle();
  if (error) throw readFailure("subscription-cancellation: tombstone", error);
  return data !== null;
}

export type CancellationSummary = {
  confirmedAt: string | null;
  source: string;
  refundReview: string;
  hadSubscription: boolean;
};

/**
 * The org's most recent CONFIRMED cancellation, for the owner's billing page.
 * Org-pinned; the caller has already authorised the org from the session.
 */
export async function loadLatestCancellation(orgId: string): Promise<CancellationSummary | null> {
  const admin = createAdminClient();
  type Row = {
    confirmed_at: string | null;
    source: string;
    refund_review: string;
    stripe_subscription_id: string | null;
  };
  const { data, error } = await (
    admin.from("subscription_cancellations" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            order: (
              k: string,
              o: { ascending: boolean },
            ) => {
              limit: (n: number) => {
                maybeSingle: () => Promise<{
                  data: Row | null;
                  error: { message?: string | null; code?: string | null } | null;
                }>;
              };
            };
          };
        };
      };
    }
  )
    .select("confirmed_at, source, refund_review, stripe_subscription_id")
    .eq("org_id", orgId)
    .eq("state", "confirmed")
    .order("confirmed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw readFailure("subscription-cancellation: latest cancellation", error);
  if (!data) return null;
  return {
    confirmedAt: data.confirmed_at,
    source: data.source,
    refundReview: data.refund_review,
    hadSubscription: data.stripe_subscription_id !== null,
  };
}

export async function loadCancellationOrg(orgId: string): Promise<CancellationOrg | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("id, name, status, stripe_customer_id, stripe_subscription_id" as never)
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw readFailure("subscription-cancellation: organisation", error);
  if (!data) return null;
  const o = data as unknown as {
    id: string;
    name: string;
    status: string | null;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  };
  return {
    id: o.id,
    name: o.name,
    status: o.status ?? "active",
    stripe_customer_id: o.stripe_customer_id,
    stripe_subscription_id: o.stripe_subscription_id,
  };
}

/** Send the owner's cancellation confirmation through the email abstraction. */
export async function sendCancellationConfirmationEmail(args: {
  to: string;
  orgName: string;
  hadSubscription: boolean;
}): Promise<{ sent: boolean; reason?: string }> {
  const mail = buildCancellationEmail({
    orgName: args.orgName,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    hadSubscription: args.hadSubscription,
  });
  const result = await sendEmail({
    to: args.to,
    // The notify@ mailbox, as the other owner-facing lifecycle emails use, so
    // the message is not dropped as a self-loop.
    from: env.RESEND_NOTIFICATIONS_FROM || "CrewFlow Notifications <notify@crewflow.uk>",
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!result.sent) {
    console.warn("[subscription-cancellation] confirmation email not sent", {
      reason: result.reason,
    });
    return { sent: false, reason: result.reason };
  }
  return { sent: true };
}

async function auditEntry(entry: CancellationAudit): Promise<void> {
  await recordAdminActivity({
    actorId: entry.actor?.userId ?? null,
    actorEmail: entry.actor?.email ?? null,
    action: entry.action,
    targetTable: "organizations",
    targetId: entry.orgId,
    metadata: entry.metadata,
  });
}

function requireStripe(): Stripe {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripe not configured");
  return stripe;
}

export function wireCancellationDeps(): CancellationDeps {
  return {
    isDisabled: isSelfServeCancellationDisabled,
    stripeAvailable: () => getStripe() !== null,
    now: () => Math.floor(Date.now() / 1000),
    loadOrg: loadCancellationOrg,

    claim: async ({ orgId, subscriptionId, actor, reason, source }) => {
      const res = await rpcClient().rpc("claim_subscription_cancellation", {
        p_org_id: orgId,
        p_subscription_id: subscriptionId,
        p_user_id: actor.userId,
        p_user_email: actor.email,
        p_reason: reason,
        p_source: source,
      });
      if (res.error) {
        throw new Error(`claim_subscription_cancellation failed: ${res.error.message ?? "unknown"}`);
      }
      const row = firstRow<{ outcome: ClaimOutcome; cancellation_id: string | null }>(res.data);
      if (!row) throw new Error("claim_subscription_cancellation returned no row");
      return { outcome: row.outcome, cancellationId: row.cancellation_id };
    },

    confirm: confirmCancellationRpc,

    release: async (cancellationId, error) => {
      const admin = createAdminClient();
      const res = await (
        admin.from("subscription_cancellations" as never) as unknown as {
          update: (payload: unknown) => {
            eq: (k: string, v: unknown) => {
              eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
            };
          };
        }
      )
        .update({ state: "failed", last_error: error.slice(0, 500) })
        .eq("id", cancellationId)
        // Only an un-confirmed claim can be released: if the webhook confirmed
        // it in the meantime, the cancellation stands.
        .eq("state", "requested");
      if (res.error) {
        console.error("[subscription-cancellation] release failed", {
          cancellation_id: cancellationId,
          error: res.error.message,
        });
      }
    },

    stripe: {
      listCustomerSubscriptions: async (customerId) => {
        // No `status` filter = Stripe's default: every subscription that has
        // not been cancelled. 100 is the API maximum and far beyond any real
        // customer; a cancelled recorded id is fetched separately by id.
        const list = await requireStripe().subscriptions.list(
          { customer: customerId, limit: 100 },
          STRIPE_REQ,
        );
        return list.data.map(snapshot);
      },
      retrieveSubscription: async (subscriptionId) => {
        try {
          return snapshot(await requireStripe().subscriptions.retrieve(subscriptionId, STRIPE_REQ));
        } catch (e) {
          if (classifyStripeCancelError(e) === "gone") return null;
          throw e;
        }
      },
      cancelSubscription: async (subscriptionId, { idempotencyKey }) => {
        // IMMEDIATE termination. No proration credit (prorate:false), no final
        // invoice for un-invoiced items (invoice_now:false) — no money moves.
        const sub = await requireStripe().subscriptions.cancel(
          subscriptionId,
          { prorate: false, invoice_now: false },
          { ...STRIPE_REQ, idempotencyKey },
        );
        return snapshot(sub);
      },
      stopInvoiceCollection: async (subscriptionId) => {
        const stripe = requireStripe();
        const out: InvoiceCollectionResult = { stopped: [], failed: [] };
        for (const status of ["open", "draft"] as const) {
          const list = await stripe.invoices.list(
            { subscription: subscriptionId, status, limit: 20 },
            STRIPE_REQ,
          );
          for (const inv of list.data) {
            if (!inv.id || inv.auto_advance === false) continue;
            try {
              await stripe.invoices.update(
                inv.id,
                { auto_advance: false },
                { ...STRIPE_REQ, idempotencyKey: `crewflow-cancel-inv:${inv.id}` },
              );
              out.stopped.push(inv.id);
            } catch (e) {
              out.failed.push(inv.id);
              console.error("[subscription-cancellation] invoice auto_advance off failed", {
                invoice_id: inv.id,
                error: errText(e),
              });
            }
          }
        }
        return out;
      },
      countPendingInvoiceItems: async (customerId) => {
        const list = await requireStripe().invoiceItems.list(
          { customer: customerId, pending: true, limit: 20 },
          STRIPE_REQ,
        );
        return list.data.length;
      },
    },

    projectSubscription: async (orgId, shape) => {
      await syncOrgSubscriptionFromStripe(wireSelfServeBillingDeps(), {
        orgId,
        subscription: shape,
      });
    },

    recordAudit: auditEntry,
    notifyHq: async (notice) => {
      await emitNotifications([notice]);
    },
    sendOwnerEmail: sendCancellationConfirmationEmail,
  };
}

export function wireReactivationDeps(): ReactivationDeps {
  return {
    loadOrg: loadCancellationOrg,
    now: () => Math.floor(Date.now() / 1000),
    lastReactivationRequestAt: async (orgId) => {
      const admin = createAdminClient();
      const { data, error } = await (
        admin.from("admin_activity_log" as never) as unknown as {
          select: (cols: string) => {
            eq: (k: string, v: unknown) => {
              eq: (k: string, v: unknown) => {
                eq: (k: string, v: unknown) => {
                  order: (
                    k: string,
                    o: { ascending: boolean },
                  ) => {
                    limit: (n: number) => {
                      maybeSingle: () => Promise<{
                        data: { created_at: string } | null;
                        error: { message?: string | null; code?: string | null } | null;
                      }>;
                    };
                  };
                };
              };
            };
          };
        }
      )
        .select("created_at")
        .eq("target_table", "organizations")
        .eq("target_id", orgId)
        .eq("action", "billing.reactivation_requested")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw readFailure("subscription-cancellation: reactivation request", error);
      return data?.created_at ?? null;
    },
    recordAudit: auditEntry,
    notifyHq: async (notice) => {
      await emitNotifications([notice]);
    },
  };
}
