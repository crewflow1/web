import { NextResponse } from "next/server";
import { isMaintenanceMode } from "@/lib/maintenance";
import type Stripe from "stripe";
import { env } from "@/lib/env";
import {
  getInvoiceStripe,
  isPortalPaymentsConfigured,
} from "@/lib/payments/portal-stripe";
import { processPortalInvoiceStripeEvent } from "@/server/services/portal-invoice-webhook-handler";

/**
 * CrewFlow — Portal invoice payments Stripe webhook receiver.
 *
 *   POST /api/webhooks/stripe-invoice
 *
 * DEDICATED + SEPARATE from the SaaS-billing webhook (/api/webhooks/stripe):
 * a different endpoint, a different signing secret (STRIPE_INVOICE_WEBHOOK_SECRET,
 * never STRIPE_WEBHOOK_SECRET), and a different Stripe client (the Connect key).
 * It records a customer's online invoice payment into the invoice_payments
 * ledger, idempotently, and NEVER touches billing_events.
 *
 * REFUSE-BEFORE-VERIFY (dark): while the feature is not configured (flag off OR
 * the platform Connect key absent) OR the dedicated webhook secret is absent, the
 * route returns 503 BEFORE constructing/verifying anything — no event is
 * processed and no Stripe call is made.
 *
 * Signature verification is mandatory: missing/invalid → 401.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stripe delivers the raw body — never let Next parse JSON, or verification fails.
export const preferredRegion = "lhr1";

export async function POST(request: Request): Promise<NextResponse> {
  // Maintenance-window gate: retry-safe 503 so Stripe re-delivers after cutover.
  if (isMaintenanceMode()) {
    return NextResponse.json(
      { ok: false, maintenance: true, message: "Scheduled maintenance — retry shortly." },
      { status: 503, headers: { "retry-after": "120", "cache-control": "no-store" } },
    );
  }

  // DARK GATE — refuse before touching Stripe or the body. Two switches: the
  // feature flag AND the platform Connect key (isPortalPaymentsConfigured), plus
  // the dedicated webhook secret. Any unmet ⇒ 503, nothing processed.
  if (!isPortalPaymentsConfigured()) {
    return NextResponse.json({ error: "portal_payments_not_configured" }, { status: 503 });
  }
  const stripe = getInvoiceStripe();
  if (!stripe) {
    return NextResponse.json({ error: "stripe_not_configured" }, { status: 503 });
  }
  const secret = env.STRIPE_INVOICE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "webhook_secret_not_configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing_stripe_signature" }, { status: 401 });
  }

  let event: Stripe.Event;
  const rawBody = await request.text();
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (e) {
    console.error(
      "[stripe-invoice-webhook] signature verification failed",
      e instanceof Error ? e.message : String(e),
    );
    return NextResponse.json({ error: "signature_verification_failed" }, { status: 401 });
  }

  try {
    const result = await processPortalInvoiceStripeEvent(event);
    return NextResponse.json({ ok: true, event_type: event.type, ...result });
  } catch (e) {
    console.error(
      "[stripe-invoice-webhook] handler failed",
      event.id,
      event.type,
      e instanceof Error ? e.message : String(e),
    );
    // 500 → Stripe retries; the idempotent settle path absorbs the redelivery.
    return NextResponse.json(
      {
        ok: false,
        event_id: event.id,
        event_type: event.type,
        error: e instanceof Error ? e.message : "unknown",
      },
      { status: 500 },
    );
  }
}
