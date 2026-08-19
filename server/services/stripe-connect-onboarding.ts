/**
 * Tenant Stripe Connect ONBOARDING — the create + refresh ORCHESTRATION (DI).
 *
 * The missing half of the portal invoice-payment path (20261120): that path can
 * take a customer's payment ON a tenant's connected account, but NOTHING created
 * that account or wrote org_payment_connections. This module is that flow's
 * decision logic, split from its I/O so it is deterministic and unit-testable
 * WITHOUT a database or a real Stripe call:
 *
 *   - `beginStripeConnectOnboarding` — refuse-before-fetch, then ensure the org
 *     has a Stripe connected account (create one if absent), mint a hosted
 *     account-onboarding LINK, and persist/refresh the org_payment_connections
 *     row. The order of the guards is the dark contract: the injected Stripe deps
 *     are reached only AFTER the config gate passes, so with the feature dark no
 *     Stripe call is possible.
 *
 *   - `refreshStripeConnectStatus` — retrieve the account and map Stripe's OWN
 *     capability flags (charges_enabled / payouts_enabled / details_submitted)
 *     onto a connection status. status='connected' is bound to charges_enabled:
 *     the pay-now gate (status === 'connected') can never open on an account
 *     Stripe would refuse.
 *
 * The connect / callback / refresh routes wire the REAL Stripe client + the
 * caller's org-pinned Supabase client onto these; tests wire fakes. Nothing here
 * imports server-only or touches the network directly.
 *
 * TENANT ISOLATION. Every function takes the caller's active org id and the row
 * it loads/writes is `.eq("org_id", orgId)` — the injected deps never widen past
 * the pinned org. The connected-account handle is bound to that org's row, so a
 * customer paying can only ever credit the org whose account the intent is on.
 */

/** The account provider column value — Stripe Connect is the only one today. */
export const STRIPE_CONNECT_PROVIDER = "stripe" as const;

/**
 * The connection row projection the orchestration needs. Capability flags come
 * from migration 20261181; account_name/default_currency from 20261120. No secret
 * columns — a Stripe connected-account id is a public handle, not a credential.
 */
export type OnboardingConnectionRow = {
  org_id: string;
  status: string;
  stripe_account_id: string | null;
  account_name: string | null;
  default_currency: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
};

/** The subset of a Stripe Account object this flow reads. */
export type StripeAccountShape = {
  id: string;
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  details_submitted?: boolean | null;
  default_currency?: string | null;
  business_profile?: { name?: string | null } | null;
};

/**
 * Map Stripe's capability flags onto a connection status.
 *   charges_enabled → 'connected'  (the account can actually take a payment)
 *   account exists, not chargeable → 'pending' (onboarding not finished)
 * status='connected' is deliberately tied to charges_enabled so the pay-now gate
 * cannot open on an account Stripe would refuse to charge.
 */
export function statusForAccount(account: StripeAccountShape): "connected" | "pending" {
  return account.charges_enabled === true ? "connected" : "pending";
}

// ---------------------------------------------------------------------------
// beginStripeConnectOnboarding — create/continue the hosted onboarding
// ---------------------------------------------------------------------------

export type BeginOnboardingDeps = {
  /** Switch-1+2 config gate (flag AND platform Connect key). No network. */
  isConfigured: () => boolean;
  /** The org's connection row, or null when none exists yet. */
  loadConnection: (orgId: string) => Promise<OnboardingConnectionRow | null>;
  /** The dedicated Stripe Connect client operations. */
  stripe: {
    /** Create a NEW connected (Express) account; returns at least its id. */
    createAccount: (args: {
      orgId: string;
      email: string | null;
      businessName: string | null;
      country: string;
    }) => Promise<StripeAccountShape>;
    /** Mint a hosted account-onboarding link the tenant is redirected to. */
    createAccountLink: (args: {
      accountId: string;
      refreshUrl: string;
      returnUrl: string;
    }) => Promise<{ url: string }>;
  };
  /** Upsert the org's connection row (status + account + capability state). */
  upsertConnection: (row: {
    orgId: string;
    connectedBy: string;
    status: string;
    stripeAccountId: string;
    accountName: string | null;
    defaultCurrency: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
  }) => Promise<void>;
};

export type BeginOnboardingInput = {
  orgId: string;
  userId: string;
  /** The org's display name — seeds the Stripe account's business profile. */
  businessName: string | null;
  /** The admin's email — seeds the Stripe account (optional). */
  email: string | null;
  /** ISO 3166-1 alpha-2 country for a NEW account (default GB). */
  country: string;
  /** Absolute origin, e.g. https://app.crewflow.uk — builds return/refresh URLs. */
  appOrigin: string;
};

export type BeginOnboardingResult =
  | { ok: true; url: string; accountId: string; created: boolean }
  | { ok: false; reason: "feature_disabled" | "stripe_error"; message?: string };

/**
 * Begin (or continue) tenant Stripe Connect onboarding.
 *
 * GUARD 1 — the two-switch config gate. Refuse BEFORE any Stripe call or DB
 * write, so with the feature dark this returns feature_disabled and creates
 * nothing. GUARD 2+ are Stripe/DB I/O reached only past the gate.
 *
 * Reuses an existing connected account when one is already bound (continue
 * onboarding / re-link after an expired link); otherwise creates a fresh Express
 * account and records it as 'pending'. Then mints a hosted onboarding link.
 */
export async function beginStripeConnectOnboarding(
  deps: BeginOnboardingDeps,
  input: BeginOnboardingInput,
): Promise<BeginOnboardingResult> {
  // GUARD 1 — dark gate. No I/O, no Stripe, no write while unconfigured.
  if (!deps.isConfigured()) return { ok: false, reason: "feature_disabled" };

  const origin = input.appOrigin.replace(/\/$/, "");
  const returnUrl = `${origin}/api/integrations/stripe-connect/callback`;
  const refreshUrl = `${origin}/api/integrations/stripe-connect/refresh`;

  try {
    const existing = await deps.loadConnection(input.orgId);

    // Reuse a bound account (continue onboarding / expired-link re-mint). We only
    // reuse the id — the fresh capability state is re-read on return by the
    // callback, so a stale flag never sticks.
    let accountId = existing?.stripe_account_id ?? null;
    let created = false;
    let accountName = existing?.account_name ?? input.businessName;
    let defaultCurrency = existing?.default_currency ?? "gbp";
    let chargesEnabled = existing?.charges_enabled ?? false;
    let payoutsEnabled = existing?.payouts_enabled ?? false;
    let detailsSubmitted = existing?.details_submitted ?? false;

    if (!accountId) {
      const account = await deps.stripe.createAccount({
        orgId: input.orgId,
        email: input.email,
        businessName: input.businessName,
        country: input.country,
      });
      accountId = account.id;
      created = true;
      accountName = account.business_profile?.name ?? input.businessName;
      defaultCurrency = normaliseCurrency(account.default_currency) ?? defaultCurrency;
      chargesEnabled = account.charges_enabled === true;
      payoutsEnabled = account.payouts_enabled === true;
      detailsSubmitted = account.details_submitted === true;
    }

    // Persist BEFORE the redirect so a bound account is never orphaned (the
    // tenant leaves for Stripe, and we already hold its id). A freshly-created,
    // not-yet-complete account is 'pending'; a reused account keeps whatever it
    // last synced to (its status is refreshed on return).
    const status = created
      ? statusForAccount({
          id: accountId,
          charges_enabled: chargesEnabled,
        })
      : existing?.status && existing.status !== "disconnected"
        ? existing.status
        : "pending";

    await deps.upsertConnection({
      orgId: input.orgId,
      connectedBy: input.userId,
      status,
      stripeAccountId: accountId,
      accountName,
      defaultCurrency,
      chargesEnabled,
      payoutsEnabled,
      detailsSubmitted,
    });

    const link = await deps.stripe.createAccountLink({
      accountId,
      refreshUrl,
      returnUrl,
    });
    if (!link.url) {
      return { ok: false, reason: "stripe_error", message: "no_account_link_url" };
    }
    return { ok: true, url: link.url, accountId, created };
  } catch (e) {
    return {
      ok: false,
      reason: "stripe_error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// refreshStripeConnectStatus — poll accounts.retrieve, map capability → status
// ---------------------------------------------------------------------------

export type RefreshStatusDeps = {
  isConfigured: () => boolean;
  loadConnection: (orgId: string) => Promise<OnboardingConnectionRow | null>;
  stripe: {
    /** Retrieve the connected account's current capability state. */
    retrieveAccount: (accountId: string) => Promise<StripeAccountShape>;
  };
  /** Write the refreshed capability state + status onto the org's row. */
  updateStatus: (row: {
    orgId: string;
    status: string;
    accountName: string | null;
    defaultCurrency: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    lastError: string | null;
  }) => Promise<void>;
};

export type RefreshStatusResult =
  | {
      ok: true;
      status: "connected" | "pending";
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      detailsSubmitted: boolean;
    }
  | {
      ok: false;
      reason: "feature_disabled" | "not_connected" | "stripe_error";
      message?: string;
    };

/**
 * Poll the tenant's Stripe account and refresh its capability state.
 *
 * GUARD 1 — dark gate (refuse before any Stripe call). GUARD 2 — the org must
 * have a bound account id; a disconnected org has nothing to poll. Then
 * accounts.retrieve → map charges_enabled onto status. On a Stripe error the row
 * is marked 'error' with the message so the panel shows "reconnect required"
 * rather than silently staying stale.
 */
export async function refreshStripeConnectStatus(
  deps: RefreshStatusDeps,
  input: { orgId: string },
): Promise<RefreshStatusResult> {
  if (!deps.isConfigured()) return { ok: false, reason: "feature_disabled" };

  const connection = await deps.loadConnection(input.orgId);
  if (!connection || !connection.stripe_account_id) {
    return { ok: false, reason: "not_connected" };
  }

  let account: StripeAccountShape;
  try {
    account = await deps.stripe.retrieveAccount(connection.stripe_account_id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Persist the failure loudly — never leave a stale 'connected' on a broken
    // account. The pay-now gate then closes until the tenant reconnects.
    await deps.updateStatus({
      orgId: input.orgId,
      status: "error",
      accountName: connection.account_name,
      defaultCurrency: connection.default_currency,
      chargesEnabled: connection.charges_enabled,
      payoutsEnabled: connection.payouts_enabled,
      detailsSubmitted: connection.details_submitted,
      lastError: message,
    });
    return { ok: false, reason: "stripe_error", message };
  }

  const chargesEnabled = account.charges_enabled === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const detailsSubmitted = account.details_submitted === true;
  const status = statusForAccount(account);

  await deps.updateStatus({
    orgId: input.orgId,
    status,
    accountName: account.business_profile?.name ?? connection.account_name,
    defaultCurrency:
      normaliseCurrency(account.default_currency) ?? connection.default_currency,
    chargesEnabled,
    payoutsEnabled,
    detailsSubmitted,
    lastError: null,
  });

  return { ok: true, status, chargesEnabled, payoutsEnabled, detailsSubmitted };
}

/** Lower-case a non-empty ISO 4217 currency, or null. */
function normaliseCurrency(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim().toLowerCase() : null;
}
