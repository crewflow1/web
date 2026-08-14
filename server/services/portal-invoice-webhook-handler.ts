import "server-only";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";
import {
  settleInvoicePayment,
  type IntentRow,
  type SettleDeps,
} from "@/server/services/portal-invoice-payments";

/**
 * Portal invoice payments — the Stripe webhook HANDLER (real I/O).
 *
 * Wires the RLS-bypassing service-role admin client + the (already
 * signature-verified) Stripe event onto the dependency-injected
 * `settleInvoicePayment` orchestration. It:
 *
 *   1. classifies the event (success → settle; terminal failure → mark status;
 *      anything else → ignore),
 *   2. extracts the settlement facts (ids, amount, metadata, connected account),
 *   3. delegates the idempotent + tenant-isolated recording to the service.
 *
 * Nothing here is reachable dark: the route refuses (503) before verifying a
 * signature unless the feature is configured, and only a Stripe-signed event
 * reaches this handler. It writes ONLY to invoice_payment_intents +
 * invoice_payments — never anywhere near CrewFlow's SaaS billing_events.
 */

/** Unix seconds → YYYY-MM-DD (UTC), the deterministic settlement date. */
function eventDateIso(event: Stripe.Event): string {
  return new Date(event.created * 1000).toISOString().slice(0, 10);
}

function buildDeps(): SettleDeps {
  const admin = createAdminClient();

  return {
    findIntent: async ({ sessionId, paymentIntentId }) => {
      // Look the intent up by whichever Stripe id the event carries. We only
      // ever act on an intent WE created, so a foreign id resolves to nothing.
      let query = admin
        .from("invoice_payment_intents" as never)
        .select(
          "id, org_id, invoice_id, stripe_account_id, stripe_checkout_session_id, stripe_payment_intent_id, amount, currency, status, invoice_payment_id",
        );
      if (paymentIntentId) {
        query = (query as { eq: (k: string, v: unknown) => typeof query }).eq(
          "stripe_payment_intent_id",
          paymentIntentId,
        );
      } else if (sessionId) {
        query = (query as { eq: (k: string, v: unknown) => typeof query }).eq(
          "stripe_checkout_session_id",
          sessionId,
        );
      } else {
        return null;
      }
      const { data, error } = await (
        query as unknown as {
          maybeSingle: () => Promise<{ data: IntentRow | null; error: unknown }>;
        }
      ).maybeSingle();
      if (error) throw readFailure("portal invoice webhook: intent lookup", error);
      return (data as IntentRow | null) ?? null;
    },

    loadInvoice: async (orgId, invoiceId) => {
      const { data, error } = await admin
        .from("invoices")
        .select("id, org_id")
        .eq("id", invoiceId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (error) throw readFailure("portal invoice webhook: invoice lookup", error);
      return data ?? null;
    },

    insertInvoicePayment: async (row) => {
      const { data, error } = await admin
        .from("invoice_payments")
        .insert({
          org_id: row.orgId,
          invoice_id: row.invoiceId,
          amount: row.amount,
          paid_at: row.paidAt,
          reference: row.reference,
          notes: `Online card payment (Stripe event ${row.eventId})`,
          source: "stripe",
        })
        .select("id")
        .single();
      if (error) throw readFailure("portal invoice webhook: payment insert", error);
      return { id: (data as { id: string }).id };
    },

    claimSettlement: async (intentId, invoicePaymentId, eventId) => {
      // Set the link ONLY while it is still null — the atomic idempotency claim.
      const { data, error } = await (
        admin.from("invoice_payment_intents" as never) as unknown as {
          update: (row: unknown) => {
            eq: (k: string, v: unknown) => {
              is: (k: string, v: unknown) => {
                select: (cols: string) => Promise<{ data: unknown[] | null; error: unknown }>;
              };
            };
          };
        }
      )
        .update({
          invoice_payment_id: invoicePaymentId,
          status: "succeeded",
          settled_event_id: eventId,
        })
        .eq("id", intentId)
        .is("invoice_payment_id", null)
        .select("id");
      if (error) throw readFailure("portal invoice webhook: settlement claim", error);
      return Array.isArray(data) && data.length > 0;
    },

    deleteInvoicePayment: async (paymentId) => {
      await admin.from("invoice_payments").delete().eq("id", paymentId);
    },

    markStatus: async (intentId, status, eventId) => {
      // Never downgrade a settled intent — only advance a not-yet-succeeded one.
      await (
        admin.from("invoice_payment_intents" as never) as unknown as {
          update: (row: unknown) => {
            eq: (k: string, v: unknown) => {
              neq: (k: string, v: unknown) => Promise<{ error: unknown }>;
            };
          };
        }
      )
        .update({ status, settled_event_id: eventId })
        .eq("id", intentId)
        .neq("status", "succeeded");
    },
  };
}

export type WebhookProcessResult = {
  handled: boolean;
  outcome: string;
};

/**
 * Process a verified Stripe event for the portal-invoice endpoint. Returns a
 * small result for the route to echo; throws only on a DB failure (→ 500 → Stripe
 * retries, which the idempotent settle path absorbs).
 */
export async function processPortalInvoiceStripeEvent(
  event: Stripe.Event,
): Promise<WebhookProcessResult> {
  const deps = buildDeps();
  const account = (event as Stripe.Event & { account?: string }).account ?? null;
  const paidAt = eventDateIso(event);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status !== "paid") {
        return { handled: true, outcome: "session_unpaid_ignored" };
      }
      const res = await settleInvoicePayment(deps, {
        eventId: event.id,
        connectedAccountId: account,
        sessionId: session.id,
        paymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null),
        amountReceivedMinor: session.amount_total ?? 0,
        currency: session.currency ?? null,
        metadata: session.metadata ?? null,
        paidAt,
      });
      await emitIfRecorded(res, event.id);
      return { handled: true, outcome: describeSettle(res) };
    }

    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const res = await settleInvoicePayment(deps, {
        eventId: event.id,
        connectedAccountId: account,
        paymentIntentId: pi.id,
        amountReceivedMinor: pi.amount_received ?? pi.amount ?? 0,
        currency: pi.currency ?? null,
        metadata: (pi.metadata as Record<string, string> | null) ?? null,
        paidAt,
      });
      await emitIfRecorded(res, event.id);
      return { handled: true, outcome: describeSettle(res) };
    }

    case "payment_intent.payment_failed":
    case "payment_intent.canceled": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const intent = await deps.findIntent({ paymentIntentId: pi.id });
      if (intent && !intent.invoice_payment_id && deps.markStatus) {
        await deps.markStatus(
          intent.id,
          event.type === "payment_intent.canceled" ? "canceled" : "failed",
          event.id,
        );
      }
      return { handled: true, outcome: "status_marked" };
    }

    default:
      return { handled: false, outcome: "ignored" };
  }
}

function describeSettle(
  res: Awaited<ReturnType<typeof settleInvoicePayment>>,
): string {
  if (res.ok && res.recorded) return "recorded";
  if (res.ok && !res.recorded) return res.reason;
  return res.reason;
}

/**
 * Fire the SAME domain event the manual path fires, so a Stripe-settled payment
 * drives automations identically. Best-effort: a dispatch failure never fails the
 * (already-recorded, already-idempotent) webhook. Emitted only on a fresh record,
 * so a redelivered event does not re-fire.
 */
async function emitIfRecorded(
  res: Awaited<ReturnType<typeof settleInvoicePayment>>,
  eventId: string,
): Promise<void> {
  if (!(res.ok && res.recorded)) return;
  try {
    const admin = createAdminClient();
    // Bind the error (loud): a failed read here just skips the best-effort
    // automation dispatch — it must never render as a healthy empty state, and
    // the payment is already recorded regardless.
    const { data, error } = await admin
      .from("invoice_payments")
      .select("org_id, invoice_id, amount")
      .eq("id", res.invoicePaymentId)
      .maybeSingle();
    if (error || !data) return;
    await dispatchAutomation({
      type: "payment.recorded",
      org_id: data.org_id,
      source_table: "invoice_payments",
      source_id: res.invoicePaymentId,
      payload: {
        amount: data.amount,
        invoice_id: data.invoice_id,
        source: "stripe",
      },
      actor_email: null,
    });
  } catch (e) {
    console.error("[stripe-invoice-webhook] automation dispatch failed", {
      eventId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
