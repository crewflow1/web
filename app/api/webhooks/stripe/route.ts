import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe/client";
import { env } from "@/lib/env";
import { processStripeEvent } from "@/server/services/stripe-webhook-handler";

/**
 * CrewFlow — Stripe webhook receiver.
 *
 *   POST /api/webhooks/stripe
 *
 * Verifies the Stripe-Signature header, then delegates to the
 * webhook handler service. Always returns 200 to Stripe even when
 * the event is unhandled — the handler stores everything in
 * billing_events so we can replay later. The only 500 path is when
 * the database itself is unreachable.
 *
 * Signature verification is mandatory: missing/invalid → 401.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stripe webhooks deliver the raw body — we MUST not let Next.js
// parse JSON for us, or signature verification fails.
export const preferredRegion = "lhr1";

export async function POST(request: Request): Promise<NextResponse> {
  const stripe = getStripe();
  if (!stripe) {
    return NextResponse.json(
      { error: "stripe_not_configured" },
      { status: 503 },
    );
  }

  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "webhook_secret_not_configured" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "missing_stripe_signature" },
      { status: 401 },
    );
  }

  let event: Stripe.Event;
  const rawBody = await request.text();
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (e) {
    console.error(
      "[stripe-webhook] signature verification failed",
      e instanceof Error ? e.message : String(e),
    );
    return NextResponse.json(
      { error: "signature_verification_failed" },
      { status: 401 },
    );
  }

  try {
    const result = await processStripeEvent(event);
    return NextResponse.json({
      ok: true,
      event_type: event.type,
      ...result,
    });
  } catch (e) {
    console.error(
      "[stripe-webhook] handler failed",
      event.id,
      event.type,
      e instanceof Error ? e.message : String(e),
    );
    // 500 → Stripe retries. We've already stored the event in
    // billing_events so the retry will hit the dedupe path.
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
