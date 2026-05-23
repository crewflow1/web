"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/client";
import {
  resolveSetupFeePrice,
  resolveSubscriptionPrice,
} from "@/lib/stripe/prices";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { env } from "@/lib/env";
import type {
  CheckoutSessionMetadata,
} from "@/lib/stripe/events";

/**
 * Customer detail — Stripe checkout server actions (Stripe go-live).
 *
 * Two operator-triggered flows from /admin/customers/[id]:
 *
 *   1. createSetupCheckout(org_id)
 *      → £1,000 one-off Checkout Session in "payment" mode.
 *
 *   2. createSubscriptionCheckout(org_id)
 *      → £500/mo Checkout Session in "subscription" mode.
 *
 * Both:
 *   - Re-check isSuperAdminEmail (defence in depth).
 *   - Resolve the org's billing email (memberships → users → email).
 *   - Reuse existing organizations.stripe_customer_id when set so we
 *     don't fan out duplicate customer records.
 *   - Attach metadata { org_id, kind, actor_id } so the webhook
 *     handler knows what to do once payment completes.
 *   - Write a row to admin_activity_log capturing the operator
 *     intent + the Stripe session id.
 *   - Redirect the operator's browser to the hosted Checkout URL.
 *
 * The customer's browser ends up on Stripe's domain. After payment
 * the customer is bounced back to NEXT_PUBLIC_APP_URL/admin/customers/<id>?stripe=success.
 * The webhook is the source of truth for "did the payment land" —
 * we don't trust the URL bounce.
 */

async function requireAdmin(): Promise<{ id: string; email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) {
    redirect("/dashboard");
  }
  return { id: user.id, email: user.email ?? "" };
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

type OrgCheckoutInfo = {
  id: string;
  name: string;
  email: string | null;
  stripe_customer_id: string | null;
};

type AnyQuery = {
  eq: (k: string, v: unknown) => AnyQuery & {
    maybeSingle: () => Promise<{
      data: unknown | null;
      error: { message: string } | null;
    }>;
  };
};

function adminTable(name: string) {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as {
    select: (cols: string) => AnyQuery;
    update: (payload: unknown) => {
      eq: (k: string, v: unknown) => Promise<{
        error: { message: string } | null;
      }>;
    };
  };
}

async function loadOrgForCheckout(orgId: string): Promise<OrgCheckoutInfo | null> {
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("id, name, billing_email, stripe_customer_id" as never)
    .eq("id", orgId)
    .maybeSingle();
  if (!org) return null;
  const o = org as unknown as {
    id: string;
    name: string;
    billing_email: string | null;
    stripe_customer_id: string | null;
  };

  // Prefer billing_email when set, else fall back to the owner user.
  let email = o.billing_email ?? null;
  if (!email) {
    const { data: ownerRow } = await admin
      .from("memberships")
      .select("user:users ( email )")
      .eq("org_id", orgId)
      .eq("role", "owner")
      .maybeSingle();
    email = ownerRow?.user?.email ?? null;
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
  if (!stripe) throw new Error("Stripe SDK not configured");
  if (org.stripe_customer_id) return org.stripe_customer_id;

  const customer = await stripe.customers.create({
    name: org.name,
    email: org.email ?? undefined,
    metadata: { org_id: org.id },
  });
  // Persist the new id so the next checkout reuses it.
  await adminTable("organizations")
    .update({ stripe_customer_id: customer.id })
    .eq("id", org.id);
  return customer.id;
}

const orgIdSchema = z.string().uuid();

// --------------------------------------------------------------------
// createSetupCheckout — one-off £1,000
// --------------------------------------------------------------------

export async function createSetupCheckout(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = orgIdSchema.safeParse(formData.get("org_id"));
  if (!parsed.success) redirect("/admin/customers?error=invalid_input");

  const stripe = getStripe();
  if (!stripe) redirect(`/admin/customers/${parsed.data}?error=stripe_not_configured`);

  const setup = await resolveSetupFeePrice();
  if (!setup.ok) {
    console.error("[checkout] setup price unresolved", setup.error);
    redirect(`/admin/customers/${parsed.data}?error=setup_price_unresolved`);
  }

  const org = await loadOrgForCheckout(parsed.data);
  if (!org) redirect(`/admin/customers?error=org_not_found`);

  const customerId = await ensureStripeCustomer(org);

  const metadata: CheckoutSessionMetadata = {
    org_id: org.id,
    kind: "setup_fee",
    actor_id: admin.id,
  };

  const session = await stripe!.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [{ price: setup.price.price_id, quantity: 1 }],
    metadata,
    payment_intent_data: { metadata },
    success_url: `${env.NEXT_PUBLIC_APP_URL}/admin/customers/${org.id}?stripe=success&kind=setup_fee`,
    cancel_url: `${env.NEXT_PUBLIC_APP_URL}/admin/customers/${org.id}?stripe=cancelled`,
  });

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "stripe.checkout_created",
    targetTable: "organizations",
    targetId: org.id,
    metadata: {
      kind: "setup_fee",
      session_id: session.id,
      price_id: setup.price.price_id,
    },
  });

  if (!session.url) {
    redirect(`/admin/customers/${org.id}?error=stripe_no_session_url`);
  }
  redirect(session.url);
}

// --------------------------------------------------------------------
// createSubscriptionCheckout — recurring £500/mo
// --------------------------------------------------------------------

export async function createSubscriptionCheckout(
  formData: FormData,
): Promise<void> {
  const admin = await requireAdmin();
  const parsed = orgIdSchema.safeParse(formData.get("org_id"));
  if (!parsed.success) redirect("/admin/customers?error=invalid_input");

  const stripe = getStripe();
  if (!stripe) redirect(`/admin/customers/${parsed.data}?error=stripe_not_configured`);

  const sub = await resolveSubscriptionPrice();
  if (!sub.ok) {
    console.error("[checkout] subscription price unresolved", sub.error);
    redirect(`/admin/customers/${parsed.data}?error=subscription_price_unresolved`);
  }

  const org = await loadOrgForCheckout(parsed.data);
  if (!org) redirect(`/admin/customers?error=org_not_found`);

  const customerId = await ensureStripeCustomer(org);

  const metadata: CheckoutSessionMetadata = {
    org_id: org.id,
    kind: "subscription",
    actor_id: admin.id,
  };

  const session = await stripe!.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: sub.price.price_id, quantity: 1 }],
    metadata,
    subscription_data: { metadata },
    success_url: `${env.NEXT_PUBLIC_APP_URL}/admin/customers/${org.id}?stripe=success&kind=subscription`,
    cancel_url: `${env.NEXT_PUBLIC_APP_URL}/admin/customers/${org.id}?stripe=cancelled`,
  });

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "stripe.checkout_created",
    targetTable: "organizations",
    targetId: org.id,
    metadata: {
      kind: "subscription",
      session_id: session.id,
      price_id: sub.price.price_id,
    },
  });

  if (!session.url) {
    redirect(`/admin/customers/${org.id}?error=stripe_no_session_url`);
  }
  redirect(session.url);
}
