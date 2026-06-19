import "server-only";
import { getStripe } from "./client";
import { resolveSetupFeePrice } from "./prices";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import type { CheckoutSessionMetadata } from "./events";
import { SETUP_FEE_GBP } from "@/lib/hq/customer-financials";

/**
 * CrewFlow — demo setup-fee Stripe Checkout.
 *
 * Launch-blocker fix (CEO directive 2026-05-29): the Demos CRM
 * "Send setup payment" action must hand the prospect a REAL, clickable
 * Stripe Checkout link — not a "reply for instructions" white-glove
 * fallback. The customer pays immediately; the webhook
 * (checkout.session.completed) then flips the demo to payment_received
 * with NO manual intervention.
 *
 * Why a bespoke helper instead of the org-based runCheckout():
 *   - At "Send setup payment" time the customer ORG DOES NOT EXIST yet
 *     (it's provisioned later, by "Move to onboarding"). The org flow in
 *     app/admin/customers/[id]/_stripe-actions.ts keys everything on a
 *     persisted org + stripe_customer_id, which we don't have.
 *   - So we key the session on the DEMO instead: metadata.demo_id +
 *     customer_email. The webhook finds the demo by id.
 *
 * Create-or-reuse (idempotent UX):
 *   - If the demo already has a still-OPEN Checkout Session we return its
 *     URL again rather than spawning a duplicate on every click.
 *   - If the stored session is expired/complete (or none exists) we mint
 *     a fresh one and persist it on the demo row.
 *
 * Never throws — returns a structured result so the lifecycle service can
 * fall back to the manual white-glove email when Stripe is unconfigured
 * or a price can't be resolved.
 */

export type DemoCheckoutResult =
  | {
      ok: true;
      url: string;
      sessionId: string;
      reused: boolean;
      amountGbp: number;
    }
  | {
      // Already paid — don't resend a payment link. Caller decides copy.
      ok: true;
      url: null;
      sessionId: string | null;
      reused: true;
      amountGbp: number;
      alreadyPaid: true;
    }
  | { ok: false; reason: string };

type DemoStripeRow = {
  id: string;
  email: string;
  company: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_status: string | null;
};

const APP_URL = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

/**
 * Create (or reuse) a Stripe Checkout Session for a demo's one-off setup
 * fee and persist it on the demo row.
 */
export async function createOrReuseDemoSetupCheckout(args: {
  demoId: string;
}): Promise<DemoCheckoutResult> {
  const stripe = getStripe();
  if (!stripe) {
    return { ok: false, reason: "STRIPE_SECRET_KEY not configured" };
  }

  const admin = createAdminClient();

  // Load the demo + any previously-minted session.
  const { data: rowRaw, error: loadErr } = await admin
    .from("demo_requests")
    .select(
      "id, email, company, stripe_checkout_session_id, stripe_payment_status" as never,
    )
    .eq("id", args.demoId)
    .maybeSingle();
  if (loadErr) {
    return { ok: false, reason: `demo load failed: ${loadErr.message}` };
  }
  const demo = rowRaw as unknown as DemoStripeRow | null;
  if (!demo) {
    return { ok: false, reason: `demo ${args.demoId} not found` };
  }

  // Already paid — short-circuit so we never re-bill or re-send a link.
  if (demo.stripe_payment_status === "paid") {
    return {
      ok: true,
      url: null,
      sessionId: demo.stripe_checkout_session_id,
      reused: true,
      amountGbp: SETUP_FEE_GBP,
      alreadyPaid: true,
    };
  }

  // Reuse a still-open session if we have one.
  if (demo.stripe_checkout_session_id) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(
        demo.stripe_checkout_session_id,
      );
      if (existing.status === "open" && existing.url) {
        return {
          ok: true,
          url: existing.url,
          sessionId: existing.id,
          reused: true,
          amountGbp: SETUP_FEE_GBP,
        };
      }
      // complete / expired → fall through and mint a fresh one.
    } catch {
      // Stale/deleted session id → mint a fresh one.
    }
  }

  // Resolve the £1,000 one-off price (auto-discovers by lookup_key /
  // amount, or honours STRIPE_SETUP_PRICE_ID). Never throws.
  const price = await resolveSetupFeePrice();
  if (!price.ok) {
    return {
      ok: false,
      reason: price.error.reason,
    };
  }

  const metadata: CheckoutSessionMetadata = {
    kind: "setup_fee",
    demo_id: demo.id,
    company: demo.company,
  };

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: demo.email,
      line_items: [{ price: price.price.price_id, quantity: 1 }],
      metadata,
      // Mirror metadata onto the PaymentIntent so a charge-level webhook
      // (payment_intent.succeeded) can also resolve the demo if needed.
      payment_intent_data: { metadata },
      success_url: `${APP_URL}/payment/success?company=${encodeURIComponent(demo.company)}`,
      cancel_url: `${APP_URL}/payment/cancelled`,
    });
  } catch (e) {
    return {
      ok: false,
      reason: `stripe.checkout.sessions.create failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!session.url) {
    return {
      ok: false,
      reason: `Stripe returned session ${session.id} with no url`,
    };
  }

  // Persist so a re-send reuses this link and the webhook can find the
  // demo by session id.
  const { error: updErr } = await admin
    .from("demo_requests")
    .update({
      stripe_checkout_session_id: session.id,
      stripe_checkout_url: session.url,
      stripe_payment_status: "pending",
    } as never)
    .eq("id", demo.id);
  if (updErr) {
    // The session is live at Stripe; we just couldn't persist it. The
    // link still works — log and return it rather than failing the send.
    console.error("[demo-checkout] failed to persist session", {
      demo_id: demo.id,
      session_id: session.id,
      error: updErr.message,
    });
  }

  return {
    ok: true,
    url: session.url,
    sessionId: session.id,
    reused: false,
    amountGbp: SETUP_FEE_GBP,
  };
}
