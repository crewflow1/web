import "server-only";
import type Stripe from "stripe";

import { getInvoiceStripe } from "./portal-stripe";
import type { StripeAccountShape } from "@/server/services/stripe-connect-onboarding";

/**
 * Tenant Stripe CONNECT onboarding — the real Stripe I/O, wrapped for injection.
 *
 * These are the three Connect operations the onboarding flow needs, mapped onto
 * the dedicated portal-payments Stripe client (getInvoiceStripe → the platform
 * Connect key, NEVER the SaaS-billing key). Each is called ONLY past the
 * onboarding orchestration's config gate, but every entry also DEFENSIVELY throws
 * if the client is null — so a wiring mistake can never fall through to a silent
 * no-op or reach for a different key.
 *
 *   - createAccount    — an EXPRESS connected account (Stripe hosts onboarding +
 *                        a lightweight dashboard). Requests card_payments +
 *                        transfers so the tenant can take card payments on the
 *                        account (direct charges via the Stripe-Account header, as
 *                        the pay-now action does). The org id is stamped in
 *                        metadata for cross-reference.
 *   - createAccountLink— a single-use hosted account-onboarding link the tenant is
 *                        redirected to.
 *   - retrieveAccount  — poll the account's capability flags to refresh status.
 *
 * DARK. getInvoiceStripe() returns null until the platform Connect key is set, so
 * none of these can run today; the orchestration refuses before reaching them.
 */

function requireConnectClient(): Stripe {
  const stripe = getInvoiceStripe();
  if (!stripe) {
    // Unreachable past the config gate, but never fall through to another key.
    throw new Error(
      "Stripe Connect client is not configured (STRIPE_CONNECT_SECRET_KEY missing).",
    );
  }
  return stripe;
}

function toShape(account: Stripe.Account): StripeAccountShape {
  return {
    id: account.id,
    charges_enabled: account.charges_enabled ?? false,
    payouts_enabled: account.payouts_enabled ?? false,
    details_submitted: account.details_submitted ?? false,
    default_currency: account.default_currency ?? null,
    business_profile: account.business_profile
      ? { name: account.business_profile.name ?? null }
      : null,
  };
}

export type StripeConnectOps = {
  createAccount: (args: {
    orgId: string;
    email: string | null;
    businessName: string | null;
    country: string;
  }) => Promise<StripeAccountShape>;
  createAccountLink: (args: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }) => Promise<{ url: string }>;
  retrieveAccount: (accountId: string) => Promise<StripeAccountShape>;
};

/** The real Connect operations, ready to inject onto the onboarding orchestration. */
export function stripeConnectOps(): StripeConnectOps {
  return {
    createAccount: async ({ orgId, email, businessName, country }) => {
      const account = await requireConnectClient().accounts.create({
        type: "express",
        country,
        email: email ?? undefined,
        business_profile: businessName ? { name: businessName } : undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { crewflow_org_id: orgId },
      });
      return toShape(account);
    },

    createAccountLink: async ({ accountId, refreshUrl, returnUrl }) => {
      const link = await requireConnectClient().accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: "account_onboarding",
      });
      return { url: link.url };
    },

    retrieveAccount: async (accountId) =>
      toShape(await requireConnectClient().accounts.retrieve(accountId)),
  };
}
