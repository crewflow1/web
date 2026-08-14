"use server";

import { redirect } from "next/navigation";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import { env } from "@/lib/env";
import { loadCustomerByPortalToken } from "./_helpers";
import {
  getInvoiceStripe,
  isPortalPaymentsConfigured,
} from "@/lib/payments/portal-stripe";
import {
  createInvoiceCheckout,
  type CreateCheckoutDeps,
  type InvoiceForPayment,
  type OrgPaymentConnection,
} from "@/server/services/portal-invoice-payments";

/**
 * Portal "Pay now" — start an online payment for an invoice.
 *
 * The customer clicks Pay now; we (1) validate the portal token, (2) rate-limit,
 * (3) refuse-before-fetch unless the feature is configured AND the tenant has a
 * connected Stripe account, (4) mint a Checkout Session ON the tenant's connected
 * account, and (5) redirect the customer to Stripe. On success Stripe calls the
 * dedicated /api/webhooks/stripe-invoice endpoint, which records the payment into
 * the existing invoice_payments ledger idempotently. The manual bank-transfer
 * proof path is completely unaffected.
 */

const ERR_BACK: Record<string, string> = {
  feature_disabled: "payments_unavailable",
  org_not_connected: "payments_unavailable",
  invoice_not_found: "invoice_not_yours",
  not_your_invoice: "invoice_not_yours",
  nothing_due: "nothing_due",
  stripe_error: "payment_start_failed",
};

function backTo(token: string, invoiceId: string, error?: string): never {
  const base = `/customer-portal/${token}/invoices`;
  const qs = error ? `?error=${encodeURIComponent(error)}` : "";
  redirect(`${base}${qs}#inv-${invoiceId}`);
}

export async function startInvoicePayment(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const invoiceId = String(formData.get("invoice_id") ?? "");
  if (!token || !invoiceId) {
    redirect(`/customer-portal/${token}/invoices?error=missing_fields`);
  }

  // Throttle per token to block abuse of the session-minting path.
  const rl = await consume("portal_write", token, DEFAULT_LIMITS.portal_write);
  if (!rl.allowed) {
    backTo(token, invoiceId, "too_many_requests");
  }

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    backTo(token, invoiceId, "invalid_token");
  }
  const { customer } = loaded;

  const admin = createAdminClient();
  const stripe = getInvoiceStripe();

  const deps: CreateCheckoutDeps = {
    // Two-switch config gate — the FIRST guard in createInvoiceCheckout, so a
    // dark feature refuses before any connection/invoice/Stripe I/O.
    isConfigured: () => isPortalPaymentsConfigured() && stripe !== null,

    loadConnection: async (orgId): Promise<OrgPaymentConnection | null> => {
      const { data, error } = await admin
        .from("org_payment_connections" as never)
        .select("org_id, status, stripe_account_id, default_currency")
        .eq("org_id", orgId)
        .eq("provider", "stripe")
        .maybeSingle();
      if (error) throw readFailure("portal pay: connection", error);
      return (data as unknown as OrgPaymentConnection | null) ?? null;
    },

    loadInvoice: async (orgId, invId) => {
      const { data, error } = await admin
        .from("invoices")
        .select(
          "id, org_id, number, total, status, customer_id, quote:quotes ( customer_id )",
        )
        .eq("id", invId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (error) throw readFailure("portal pay: invoice", error);
      if (!data) return null;
      // Paid-so-far — F-1 paged so a long payment history can't under-count.
      const { data: pays, error: payErr } = await fetchAllRows<{
        amount: number | string | null;
      }>((from, to) =>
        admin
          .from("invoice_payments")
          .select("amount")
          .eq("invoice_id", invId)
          .eq("org_id", orgId)
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
          data: { amount: number | string | null }[] | null;
          error: unknown;
        }>,
      );
      if (payErr) throw readFailure("portal pay: paid-so-far", payErr);
      const paid = pays.reduce((s, p) => s + Number(p.amount ?? 0), 0);
      return { invoice: data as unknown as InvoiceForPayment, paid };
    },

    stripe: {
      createSession: async (args) => {
        // The `{ stripeAccount }` request option creates the session ON the
        // tenant's connected account, so funds settle to that tenant only.
        const session = await stripe!.checkout.sessions.create(
          {
            mode: "payment",
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: args.currency,
                  unit_amount: args.amountMinor,
                  product_data: { name: `Invoice ${args.invoiceNumber}` },
                },
              },
            ],
            metadata: args.metadata,
            // Mirror metadata onto the PaymentIntent so a PI-level event can also
            // resolve the intent.
            payment_intent_data: { metadata: args.metadata },
            success_url: args.successUrl,
            cancel_url: args.cancelUrl,
          },
          { stripeAccount: args.connectedAccountId, idempotencyKey: args.idempotencyKey },
        );
        const pi = session.payment_intent as string | Stripe.PaymentIntent | null;
        return {
          id: session.id,
          url: session.url,
          paymentIntentId: typeof pi === "string" ? pi : (pi?.id ?? null),
        };
      },
    },

    saveIntent: async (row) => {
      // Upsert on session id so a re-click (same Stripe idempotency key → same
      // session) does not violate the unique constraint or double-insert.
      const { error } = await (
        admin.from("invoice_payment_intents" as never) as unknown as {
          upsert: (
            r: unknown,
            opts: { onConflict: string; ignoreDuplicates: boolean },
          ) => Promise<{ error: unknown }>;
        }
      ).upsert(
        {
          org_id: row.orgId,
          invoice_id: row.invoiceId,
          customer_id: row.customerId,
          stripe_account_id: row.stripeAccountId,
          stripe_checkout_session_id: row.sessionId,
          stripe_payment_intent_id: row.paymentIntentId,
          amount: row.amount,
          currency: row.currency,
          status: "created",
        },
        { onConflict: "stripe_checkout_session_id", ignoreDuplicates: true },
      );
      if (error) throw readFailure("portal pay: save intent", error);
    },
  };

  const result = await createInvoiceCheckout(deps, {
    orgId: customer.org_id,
    customerId: customer.id,
    invoiceId,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    token,
  });

  if (!result.ok) {
    backTo(token, invoiceId, ERR_BACK[result.reason] ?? "payment_start_failed");
  }

  // Off to Stripe's hosted Checkout.
  redirect(result.url);
}
