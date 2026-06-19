"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireHq } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/client";
import {
  resolveSetupFeePrice,
  resolveSubscriptionPrice,
  type PriceLookup,
} from "@/lib/stripe/prices";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { env } from "@/lib/env";
import type { CheckoutSessionMetadata } from "@/lib/stripe/events";

/**
 * Customer detail — Stripe checkout server actions (Stripe go-live).
 *
 * Two operator-triggered flows from /admin/customers/[id]:
 *
 *   1. createSetupCheckout(org_id)        → £1,000 one-off
 *   2. createSubscriptionCheckout(org_id) → £500/mo recurring
 *
 * Architecture:
 *
 *   - The inner `runCheckout` helper does all the WORK (Stripe SDK,
 *     DB writes, audit log). It returns the destination URL or
 *     throws a typed `CheckoutError` with a machine-readable code.
 *
 *   - The outer action wraps `runCheckout` in try/catch and only
 *     calls `redirect()` AFTER the helper returns/throws. This is
 *     critical: `redirect()` throws NEXT_REDIRECT internally, so
 *     putting it inside a `try` would let the catch swallow Next's
 *     own redirect signal.
 *
 *   - Every failure path logs a structured `[stripe-checkout]` line
 *     so we can grep Vercel logs for the root cause. The operator
 *     also gets a `?error=<code>` redirect so /admin/customers/[id]
 *     can surface a helpful banner.
 *
 * Hard requirement: this file MUST run on Node (Stripe SDK uses
 * Node's `net`). The customer detail page is a server component
 * which defaults to Node. We don't need an explicit `runtime`
 * export here — but the importing page must not opt into Edge.
 */

// --------------------------------------------------------------------
// Local error type — carries a machine code + human detail.
// --------------------------------------------------------------------

class CheckoutError extends Error {
  readonly code: string;
  readonly detail: string;
  readonly cause?: unknown;
  constructor(code: string, detail: string, cause?: unknown) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
    this.cause = cause;
  }
}

// --------------------------------------------------------------------
// DB helpers (admin client cast — billing_invoices not in typed schema)
// --------------------------------------------------------------------

function adminUpdate(table: string) {
  const admin = createAdminClient();
  return admin.from(table as never) as unknown as {
    update: (payload: unknown) => {
      eq: (k: string, v: unknown) => Promise<{
        error: { message: string } | null;
      }>;
    };
  };
}

type OrgCheckoutInfo = {
  id: string;
  name: string;
  email: string | null;
  stripe_customer_id: string | null;
};

async function loadOrgForCheckout(
  orgId: string,
): Promise<OrgCheckoutInfo | null> {
  const admin = createAdminClient();
  const { data: org, error } = await admin
    .from("organizations")
    .select("id, name, billing_email, stripe_customer_id" as never)
    .eq("id", orgId)
    .maybeSingle();
  if (error) {
    throw new CheckoutError(
      "db_org_load_failed",
      `organizations.select failed: ${error.message}`,
      error,
    );
  }
  if (!org) return null;
  const o = org as unknown as {
    id: string;
    name: string;
    billing_email: string | null;
    stripe_customer_id: string | null;
  };

  let email = o.billing_email ?? null;
  if (!email) {
    const { data: ownerRow, error: mErr } = await admin
      .from("memberships")
      .select("user:users ( email )")
      .eq("org_id", orgId)
      .eq("role", "owner")
      .maybeSingle();
    if (mErr) {
      // Don't throw — owner email is best-effort. Stripe accepts a
      // customer with no email; the audit row will still record the
      // checkout attempt.
      console.warn(
        "[stripe-checkout] owner-email lookup failed",
        { org_id: orgId, error: mErr.message },
      );
    } else {
      email = ownerRow?.user?.email ?? null;
    }
  }
  return {
    id: o.id,
    name: o.name,
    email,
    stripe_customer_id: o.stripe_customer_id,
  };
}

async function ensureStripeCustomer(
  org: OrgCheckoutInfo,
): Promise<string> {
  const stripe = getStripe();
  if (!stripe) {
    throw new CheckoutError("stripe_not_configured", "Stripe SDK is null");
  }
  if (org.stripe_customer_id) return org.stripe_customer_id;

  let customer;
  try {
    customer = await stripe.customers.create({
      name: org.name,
      email: org.email ?? undefined,
      metadata: { org_id: org.id },
    });
  } catch (e) {
    throw new CheckoutError(
      "stripe_customer_create_failed",
      e instanceof Error ? e.message : String(e),
      e,
    );
  }

  const upd = await adminUpdate("organizations")
    .update({ stripe_customer_id: customer.id })
    .eq("id", org.id);
  if (upd.error) {
    // The customer was created at Stripe but we couldn't persist the
    // id. Log loudly — manual reconciliation may be needed.
    console.error(
      "[stripe-checkout] failed to persist stripe_customer_id",
      {
        org_id: org.id,
        stripe_customer_id: customer.id,
        error: upd.error.message,
      },
    );
  }
  return customer.id;
}

// --------------------------------------------------------------------
// Core: build a checkout session for a given kind, return the URL.
// Throws CheckoutError on any expected failure.
// --------------------------------------------------------------------

type CheckoutKind = "setup_fee" | "subscription";

async function runCheckout(
  kind: CheckoutKind,
  formData: FormData,
): Promise<string> {
  const admin = await requireHq();

  const orgIdSchema = z.string().uuid();
  const parsed = orgIdSchema.safeParse(formData.get("org_id"));
  if (!parsed.success) {
    throw new CheckoutError(
      "invalid_input",
      `org_id is not a uuid: ${JSON.stringify(formData.get("org_id"))}`,
    );
  }
  const orgId = parsed.data;

  const stripe = getStripe();
  if (!stripe) {
    throw new CheckoutError(
      "stripe_not_configured",
      "STRIPE_SECRET_KEY missing — getStripe() returned null",
    );
  }

  // 1. Price discovery (the resolver catches its own Stripe errors
  //    and returns a structured result — it never throws).
  const lookup: PriceLookup =
    kind === "setup_fee"
      ? await resolveSetupFeePrice()
      : await resolveSubscriptionPrice();
  if (!lookup.ok) {
    throw new CheckoutError(
      `${kind}_price_unresolved`,
      `${lookup.error.reason} (candidates: ${JSON.stringify(lookup.error.candidates)})`,
    );
  }

  // 2. Org lookup.
  const org = await loadOrgForCheckout(orgId);
  if (!org) {
    throw new CheckoutError(
      "org_not_found",
      `No organizations row for id=${orgId}`,
    );
  }

  // 3. Stripe customer.
  const customerId = await ensureStripeCustomer(org);

  // 4. Checkout session.
  const metadata: CheckoutSessionMetadata = {
    org_id: org.id,
    kind,
    actor_id: admin.id,
  };
  const baseSession = {
    customer: customerId,
    line_items: [{ price: lookup.price.price_id, quantity: 1 }],
    metadata,
    success_url: `${env.NEXT_PUBLIC_APP_URL}/admin/customers/${org.id}?stripe=success&kind=${kind}`,
    cancel_url: `${env.NEXT_PUBLIC_APP_URL}/admin/customers/${org.id}?stripe=cancelled`,
  };

  let session;
  try {
    session =
      kind === "setup_fee"
        ? await stripe.checkout.sessions.create({
            ...baseSession,
            mode: "payment",
            payment_intent_data: { metadata },
          })
        : await stripe.checkout.sessions.create({
            ...baseSession,
            mode: "subscription",
            subscription_data: { metadata },
          });
  } catch (e) {
    throw new CheckoutError(
      "stripe_session_create_failed",
      e instanceof Error ? e.message : String(e),
      e,
    );
  }

  // 5. Audit trail.
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "stripe.checkout_created",
    targetTable: "organizations",
    targetId: org.id,
    metadata: {
      kind,
      session_id: session.id,
      price_id: lookup.price.price_id,
      stripe_customer_id: customerId,
    },
  });

  if (!session.url) {
    throw new CheckoutError(
      "stripe_no_session_url",
      `Stripe returned session.id=${session.id} with no url`,
    );
  }
  return session.url;
}

// --------------------------------------------------------------------
// Helper: NEXT_REDIRECT detection so try/catch doesn't swallow it.
// We don't use it today (we keep redirect() outside try/catch
// entirely) but kept for future call sites that need it.
// --------------------------------------------------------------------

function isNextRedirect(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "digest" in e &&
    typeof (e as { digest?: unknown }).digest === "string" &&
    (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

// --------------------------------------------------------------------
// PUBLIC: setup-fee checkout (£1,000 one-off)
// --------------------------------------------------------------------

export async function createSetupCheckout(formData: FormData): Promise<void> {
  const orgIdForRedirect = stringOrEmpty(formData.get("org_id"));
  let target: string;
  try {
    target = await runCheckout("setup_fee", formData);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    const { code, detail } = errorParts(e);
    console.error("[stripe-checkout][setup_fee] failed", {
      org_id: orgIdForRedirect,
      code,
      detail,
      stack: e instanceof Error ? e.stack : undefined,
    });
    target = `/admin/customers/${encodeURIComponent(orgIdForRedirect)}?error=${encodeURIComponent(code)}&detail=${encodeURIComponent(detail.slice(0, 240))}`;
  }
  redirect(target);
}

// --------------------------------------------------------------------
// PUBLIC: subscription checkout (£500/mo recurring)
// --------------------------------------------------------------------

export async function createSubscriptionCheckout(
  formData: FormData,
): Promise<void> {
  const orgIdForRedirect = stringOrEmpty(formData.get("org_id"));
  let target: string;
  try {
    target = await runCheckout("subscription", formData);
  } catch (e) {
    if (isNextRedirect(e)) throw e;
    const { code, detail } = errorParts(e);
    console.error("[stripe-checkout][subscription] failed", {
      org_id: orgIdForRedirect,
      code,
      detail,
      stack: e instanceof Error ? e.stack : undefined,
    });
    target = `/admin/customers/${encodeURIComponent(orgIdForRedirect)}?error=${encodeURIComponent(code)}&detail=${encodeURIComponent(detail.slice(0, 240))}`;
  }
  redirect(target);
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function stringOrEmpty(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

function errorParts(e: unknown): { code: string; detail: string } {
  if (e instanceof CheckoutError) {
    return { code: e.code, detail: e.detail };
  }
  return {
    code: "unhandled_exception",
    detail: e instanceof Error ? e.message : String(e),
  };
}
