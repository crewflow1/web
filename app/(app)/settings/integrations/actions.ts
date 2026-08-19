"use server";

import { revalidatePath } from "next/cache";

import { requireOrgContext } from "@/server/auth/session";
import { disconnectCalendarProvider } from "@/server/services/calendar-connections";
import { CALENDAR_PROVIDERS, type CalendarProvider } from "@/lib/integrations/calendar/oauth";
import { disconnectBankProvider } from "@/server/services/bank-connections";
import { BANKING_PROVIDERS, type BankingProvider } from "@/lib/integrations/banking/oauth";
import { disconnectTelematicsProvider } from "@/server/services/telematics-connections";
import {
  TELEMATICS_PROVIDERS,
  type TelematicsProvider,
} from "@/lib/integrations/telematics/oauth";
import { disconnectMerchantProvider } from "@/server/services/merchant-connections";
import {
  isMerchantProvider,
  type MerchantProvider,
} from "@/lib/integrations/merchants/connect";
import { isPortalPaymentsConfigured } from "@/lib/payments/portal-stripe";
import { stripeConnectOps } from "@/lib/payments/stripe-connect";
import {
  disconnectOrgPaymentConnection,
  loadOnboardingConnection,
  updateOrgPaymentStatus,
} from "@/server/services/org-payment-connections";
import {
  refreshStripeConnectStatus,
  type RefreshStatusDeps,
} from "@/server/services/stripe-connect-onboarding";

/**
 * Calendar integration actions — the admin disconnect that wires the panel's
 * "Disconnect" control to `disconnectCalendarProvider`. Clears the tokens +
 * account handle and returns the row to `disconnected`.
 *
 * AUTHORISATION IS DOUBLED. The role check here refuses a non-admin loudly; the
 * admin-write RLS on calendar_connections (20261097) is the real boundary for the
 * UPDATE, which runs under the caller's JWT. Org-pinned via ctx.org.id. LOUD: a
 * failed disconnect throws rather than silently reporting success.
 *
 * A plain form-action (FormData → void) so the panel needs no client JS; on
 * success the page is revalidated so the connected state disappears.
 */

function isCalendarProvider(v: string): v is CalendarProvider {
  return (CALENDAR_PROVIDERS as readonly string[]).includes(v);
}

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export async function disconnectCalendarConnection(formData: FormData): Promise<void> {
  const providerRaw = String(formData.get("provider") ?? "");
  if (!isCalendarProvider(providerRaw)) {
    throw new Error("Unknown calendar provider.");
  }
  const provider = providerRaw;

  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    throw new Error("Only an owner or admin may disconnect a calendar provider.");
  }

  const res = await disconnectCalendarProvider(ctx.org.id, provider);
  if (!res.ok) {
    throw new Error(res.error ?? "Disconnect failed.");
  }

  revalidatePath("/settings/integrations");
}

function isBankingProvider(v: string): v is BankingProvider {
  return (BANKING_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Bank integration disconnect — wires the panel's "Disconnect" control to
 * `disconnectBankProvider`. Clears the tokens + connection handle and returns the
 * row to `disconnected`.
 *
 * AUTHORISATION IS DOUBLED. The role check here refuses a non-admin loudly; the
 * admin-write RLS on bank_connections (20261100) is the real boundary for the
 * UPDATE, which runs under the caller's JWT. Org-pinned via ctx.org.id. LOUD.
 */
export async function disconnectBankConnection(formData: FormData): Promise<void> {
  const providerRaw = String(formData.get("provider") ?? "");
  if (!isBankingProvider(providerRaw)) {
    throw new Error("Unknown bank provider.");
  }
  const provider = providerRaw;

  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    throw new Error("Only an owner or admin may disconnect a bank.");
  }

  const res = await disconnectBankProvider(ctx.org.id, provider);
  if (!res.ok) {
    throw new Error(res.error ?? "Disconnect failed.");
  }

  revalidatePath("/settings/integrations");
}

function isTelematicsProvider(v: string): v is TelematicsProvider {
  return (TELEMATICS_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Telematics integration disconnect — wires the panel's "Disconnect" control to
 * `disconnectTelematicsProvider`. Clears the tokens + account handle and returns
 * the row to `disconnected`.
 *
 * AUTHORISATION IS DOUBLED. The role check here refuses a non-admin loudly; the
 * admin-write RLS on telematics_connections (20261103) is the real boundary for
 * the UPDATE, which runs under the caller's JWT. Org-pinned via ctx.org.id. LOUD.
 */
export async function disconnectTelematicsConnection(formData: FormData): Promise<void> {
  const providerRaw = String(formData.get("provider") ?? "");
  if (!isTelematicsProvider(providerRaw)) {
    throw new Error("Unknown telematics provider.");
  }
  const provider = providerRaw;

  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    throw new Error("Only an owner or admin may disconnect a telematics account.");
  }

  const res = await disconnectTelematicsProvider(ctx.org.id, provider);
  if (!res.ok) {
    throw new Error(res.error ?? "Disconnect failed.");
  }

  revalidatePath("/settings/integrations");
}

/**
 * Merchant integration disconnect — wires the panel's "Disconnect" control to
 * `disconnectMerchantProvider`. Clears the account secret + connection handle and
 * returns the row to `disconnected`.
 *
 * AUTHORISATION IS DOUBLED. The role check here refuses a non-admin loudly; the
 * admin-write RLS on merchant_connections (20261124000000) is the real boundary
 * for the UPDATE, which runs under the caller's JWT. Org-pinned via ctx.org.id.
 * LOUD.
 */
export async function disconnectMerchantConnection(formData: FormData): Promise<void> {
  const providerRaw = String(formData.get("provider") ?? "");
  if (!isMerchantProvider(providerRaw)) {
    throw new Error("Unknown merchant.");
  }
  const provider: MerchantProvider = providerRaw;

  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    throw new Error("Only an owner or admin may disconnect a merchant.");
  }

  const res = await disconnectMerchantProvider(ctx.org.id, provider);
  if (!res.ok) {
    throw new Error(res.error ?? "Disconnect failed.");
  }

  revalidatePath("/settings/integrations");
}

/**
 * Stripe Connect (payments) disconnect — wires the panel's "Disconnect" control to
 * `disconnectOrgPaymentConnection`. Unbinds the connected account + clears the
 * capability state, returning the row to `disconnected` so the pay-now gate closes.
 * A later reconnect creates a fresh account.
 *
 * AUTHORISATION IS DOUBLED. The role check here refuses a non-admin loudly; the
 * admin-write RLS on org_payment_connections (20261120) is the real boundary for
 * the UPDATE, which runs under the caller's JWT. Org-pinned via ctx.org.id. LOUD.
 */
export async function disconnectStripeConnect(): Promise<void> {
  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    throw new Error("Only an owner or admin may disconnect payments.");
  }

  const res = await disconnectOrgPaymentConnection(ctx.org.id);
  if (!res.ok) {
    throw new Error(res.error ?? "Disconnect failed.");
  }

  revalidatePath("/settings/integrations");
}

/**
 * Stripe Connect (payments) status refresh — polls accounts.retrieve and re-maps
 * the tenant's capability state onto the connection status (charges_enabled →
 * 'connected'). Wired to the panel's "Refresh status" control.
 *
 * DARK. `isPortalPaymentsConfigured()` gates the refresh: while the feature flag is
 * off or the platform Connect key is absent the orchestration refuses before any
 * Stripe call and nothing is written. Admin-gated + org-pinned + LOUD.
 */
export async function refreshStripeConnectStatusAction(): Promise<void> {
  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    throw new Error("Only an owner or admin may refresh the payments connection.");
  }

  const deps: RefreshStatusDeps = {
    isConfigured: () => isPortalPaymentsConfigured(),
    loadConnection: (orgId) => loadOnboardingConnection(orgId),
    stripe: { retrieveAccount: stripeConnectOps().retrieveAccount },
    updateStatus: (row) => updateOrgPaymentStatus(row),
  };

  // A dark/not-connected refusal is not an error the admin needs to see thrown —
  // the panel already shows the dark/disconnected state. Only a genuine Stripe
  // failure (which the service persists as 'error') surfaces via the row.
  await refreshStripeConnectStatus(deps, { orgId: ctx.org.id });

  revalidatePath("/settings/integrations");
}
