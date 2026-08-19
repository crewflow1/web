import { NextResponse, type NextRequest } from "next/server";

import { requireOrgContext } from "@/server/auth/session";
import { isPortalPaymentsConfigured } from "@/lib/payments/portal-stripe";
import { stripeConnectOps } from "@/lib/payments/stripe-connect";
import {
  beginStripeConnectOnboarding,
  type BeginOnboardingDeps,
} from "@/server/services/stripe-connect-onboarding";
import {
  loadOnboardingConnection,
  upsertOrgPaymentConnection,
} from "@/server/services/org-payment-connections";

/**
 * Stripe Connect — onboarding link REFRESH. DARK (503).
 *
 * Stripe calls this route's URL (the account link's refresh_url) when a hosted
 * onboarding link expires or is revisited: we simply re-mint a fresh link for the
 * SAME connected account and 302 the tenant back into onboarding. It reuses the
 * bound account id, so no new account is created. Gated + dark-refusing exactly
 * like the connect route.
 */

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export async function GET(request: NextRequest) {
  const { ctx, user } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only an owner or admin may connect payments." },
      { status: 403 },
    );
  }

  const origin = new URL(request.url).origin;

  const deps: BeginOnboardingDeps = {
    isConfigured: () => isPortalPaymentsConfigured(),
    loadConnection: (orgId) => loadOnboardingConnection(orgId),
    stripe: stripeConnectOps(),
    upsertConnection: (row) => upsertOrgPaymentConnection(row),
  };

  const result = await beginStripeConnectOnboarding(deps, {
    orgId: ctx.org.id,
    userId: user.id,
    businessName: ctx.org.name ?? null,
    email: user.email ?? null,
    country: "GB",
    appOrigin: origin,
  });

  if (!result.ok) {
    if (result.reason === "feature_disabled") {
      return NextResponse.json(
        {
          ok: false,
          status: "not_configured",
          message: "Online payments are not configured; nothing to refresh.",
        },
        { status: 503 },
      );
    }
    const u = new URL(`${origin}/settings/integrations`);
    u.searchParams.set("payments", "error");
    return NextResponse.redirect(u);
  }

  return NextResponse.redirect(result.url);
}
