import { NextResponse, type NextRequest } from "next/server";

import { requireOrgContext } from "@/server/auth/session";
import { isPortalPaymentsConfigured } from "@/lib/payments/portal-stripe";
import { stripeConnectOps } from "@/lib/payments/stripe-connect";
import {
  refreshStripeConnectStatus,
  type RefreshStatusDeps,
} from "@/server/services/stripe-connect-onboarding";
import {
  loadOnboardingConnection,
  updateOrgPaymentStatus,
} from "@/server/services/org-payment-connections";

/**
 * Stripe Connect — onboarding RETURN callback. DARK (503).
 *
 * Stripe redirects the tenant here (the account link's return_url) after the
 * hosted onboarding form. Returning is NOT proof of completion — a tenant can
 * leave the form early — so this route RE-READS the account via accounts.retrieve
 * and maps Stripe's OWN capability flags onto the connection status
 * (charges_enabled → 'connected', else 'pending'). It never trusts a query
 * parameter for completion.
 *
 * DARK. When portal payments are not configured (flag off AND/OR platform Connect
 * key absent — ALWAYS today) the orchestration REFUSES before any Stripe call and
 * this route 503s without reading or writing anything.
 */

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

function backToIntegrations(origin: string, status: string): NextResponse {
  const u = new URL(`${origin}/settings/integrations`);
  u.searchParams.set("payments", status);
  return NextResponse.redirect(u);
}

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const origin = new URL(request.url).origin;

  const deps: RefreshStatusDeps = {
    isConfigured: () => isPortalPaymentsConfigured(),
    loadConnection: (orgId) => loadOnboardingConnection(orgId),
    stripe: { retrieveAccount: stripeConnectOps().retrieveAccount },
    updateStatus: (row) => updateOrgPaymentStatus(row),
  };

  const result = await refreshStripeConnectStatus(deps, { orgId: ctx.org.id });

  if (!result.ok) {
    if (result.reason === "feature_disabled") {
      // DARK: not configured → 503, no read, no write.
      return NextResponse.json(
        {
          ok: false,
          status: "not_configured",
          message: "Online payments are not configured; nothing was updated.",
        },
        { status: 503 },
      );
    }
    if (result.reason === "not_connected") {
      return backToIntegrations(origin, "not_connected");
    }
    // stripe_error — the status was already persisted as 'error' by the service.
    return backToIntegrations(origin, "error");
  }

  // 'connected' (chargeable) or 'pending' (onboarding not finished yet).
  return backToIntegrations(origin, result.status);
}
