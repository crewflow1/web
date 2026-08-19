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
 * Stripe Connect — tenant onboarding INITIATION. DARK (503).
 *
 * Starts (or continues) the "connect payments" flow: gate the caller
 * (authenticated + org + admin), then create/reuse the org's Stripe connected
 * account and mint a hosted account-onboarding link. When portal payments are not
 * configured — ALWAYS, today, because NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS is off
 * AND/OR the platform Connect key (STRIPE_CONNECT_SECRET_KEY) is absent — the
 * onboarding orchestration REFUSES before any Stripe call and this route returns a
 * clean 503 `not_configured` JSON state WITHOUT creating an account or writing a
 * row.
 *
 * When live, it 302s the tenant to Stripe's hosted onboarding. On return Stripe
 * calls the callback route (return_url) which refreshes the capability state; if
 * the link expires Stripe calls the refresh route (refresh_url) to re-mint one.
 */

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export async function GET(request: NextRequest) {
  // Auth + org gate (redirects to /login or /onboarding when absent).
  const { ctx, user } = await requireOrgContext();
  // Admin gate — connecting payments is an admin act. The DB RLS on
  // org_payment_connections is the real boundary for the write; this is the
  // surface-level refusal so a non-admin never even starts the flow.
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only an owner or admin may connect payments." },
      { status: 403 },
    );
  }

  const origin = new URL(request.url).origin;

  const deps: BeginOnboardingDeps = {
    // Two-switch config gate — the FIRST guard in beginStripeConnectOnboarding,
    // so a dark feature refuses before any Stripe call or DB write.
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
      // DARK: not configured → 503, no account, no row.
      return NextResponse.json(
        {
          ok: false,
          status: "not_configured",
          message:
            "Online payments are not configured; the connection was not started.",
        },
        { status: 503 },
      );
    }
    // A live Stripe failure — back to settings with an error code.
    const u = new URL(`${origin}/settings/integrations`);
    u.searchParams.set("payments", "error");
    return NextResponse.redirect(u);
  }

  // LIVE (unreachable dark): off to Stripe's hosted onboarding.
  return NextResponse.redirect(result.url);
}
