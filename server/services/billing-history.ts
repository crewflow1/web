import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { getStripe } from "@/lib/stripe/client";
import { wireSelfServeBillingDeps } from "@/server/services/self-serve-billing";

/**
 * BILLING HISTORY — the org's CrewFlow invoices and receipts.
 *
 * Available to an owner whatever the state of the subscription (active,
 * suspended, cancelled) and whatever the self-serve-billing flag says: a
 * customer is entitled to their invoices after they cancel, and a
 * founder-provisioned customer never had the self-serve surface at all.
 *
 * Two sources, in order:
 *   1. STRIPE (read-only `invoices.list` for the org's own Stripe customer) —
 *      gives the Stripe-hosted invoice page + PDF link. Used when the SaaS
 *      Stripe key is present and the org has a Stripe customer id.
 *   2. RECORDS — CrewFlow's own `billing_invoices` rows (written by the webhook
 *      and by HQ). No hosted link, but always available, and the fallback when
 *      Stripe is unreachable or the key lacks the Invoices read scope.
 *
 * Read-only. The caller must already have authorised the org from the session.
 */

export type BillingHistoryItem = {
  id: string;
  number: string | null;
  /** ISO date-time the invoice was created / paid. */
  date: string | null;
  status: string | null;
  /** Major units. */
  amount: number;
  currency: string;
  hostedUrl: string | null;
  pdfUrl: string | null;
};

export type BillingHistory = {
  source: "stripe" | "records";
  /** True when Stripe should have been the source but could not be read. */
  degraded: boolean;
  invoices: BillingHistoryItem[];
};

export type BillingHistoryDeps = {
  stripeAvailable: () => boolean;
  loadStripeCustomerId: (orgId: string) => Promise<string | null>;
  listStripeInvoices: (customerId: string) => Promise<BillingHistoryItem[]>;
  listRecordedInvoices: (orgId: string) => Promise<BillingHistoryItem[]>;
};

export async function loadBillingHistory(
  deps: BillingHistoryDeps,
  orgId: string,
): Promise<BillingHistory> {
  let degraded = false;
  if (deps.stripeAvailable()) {
    const customerId = await deps.loadStripeCustomerId(orgId);
    if (customerId) {
      try {
        return {
          source: "stripe",
          degraded: false,
          invoices: await deps.listStripeInvoices(customerId),
        };
      } catch (e) {
        degraded = true;
        console.error("[billing-history] stripe invoices unavailable — using records", {
          org_id: orgId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return {
    source: "records",
    degraded,
    invoices: await deps.listRecordedInvoices(orgId),
  };
}

/** Recorded statuses worth showing a customer (a `draft` is not yet theirs). */
const RECORDED_VISIBLE = ["sent", "paid", "failed", "refunded", "void"];

export function wireBillingHistoryDeps(): BillingHistoryDeps {
  return {
    stripeAvailable: () => getStripe() !== null,

    loadStripeCustomerId: async (orgId) => {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from("organizations")
        .select("stripe_customer_id" as never)
        .eq("id", orgId)
        .maybeSingle();
      if (error) throw readFailure("billing-history: organisation", error);
      return (data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? null;
    },

    listStripeInvoices: async (customerId) => {
      const rows = await wireSelfServeBillingDeps().stripe.listInvoices(customerId);
      return rows
        .filter((r) => r.status !== "draft")
        .map((r) => ({
          id: r.id,
          number: r.number,
          date: r.created,
          status: r.status,
          amount: r.status === "paid" ? r.amount_paid : r.amount_due,
          currency: r.currency,
          hostedUrl: r.hosted_invoice_url,
          pdfUrl: r.invoice_pdf,
        }));
    },

    listRecordedInvoices: async (orgId) => {
      const admin = createAdminClient();
      type Row = {
        id: string;
        status: string;
        amount_gbp: number | string;
        currency: string | null;
        paid_at: string | null;
        created_at: string;
      };
      const { data, error } = await (
        admin.from("billing_invoices" as never) as unknown as {
          select: (cols: string) => {
            eq: (k: string, v: unknown) => {
              in: (k: string, v: string[]) => {
                order: (
                  k: string,
                  o: { ascending: boolean },
                ) => {
                  limit: (n: number) => Promise<{
                    data: Row[] | null;
                    error: { message?: string | null; code?: string | null } | null;
                  }>;
                };
              };
            };
          };
        }
      )
        .select("id, status, amount_gbp, currency, paid_at, created_at")
        .eq("org_id", orgId)
        .in("status", RECORDED_VISIBLE)
        .order("created_at", { ascending: false })
        // The most recent 60 — five years of monthly billing — is the whole
        // history for any real account; this is a display list, not a ledger sum.
        .limit(60);
      if (error) throw readFailure("billing-history: billing_invoices", error);
      return (data ?? []).map((r) => ({
        id: r.id,
        number: null,
        date: r.paid_at ?? r.created_at,
        status: r.status,
        amount: Number(r.amount_gbp),
        currency: (r.currency ?? "GBP").toUpperCase(),
        hostedUrl: null,
        pdfUrl: null,
      }));
    },
  };
}
