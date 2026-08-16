"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOrgContext } from "@/server/auth/session";
import { env } from "@/lib/env";
import {
  wireSelfServeBillingDeps,
  createBillingPortalSession,
  createPlanChangeCheckout,
} from "@/server/services/self-serve-billing";

/**
 * /settings/billing server actions — self-serve tenant plan management (DARK).
 *
 *   openBillingPortal — mint a Stripe Billing Portal session (manage payment
 *                       method, view invoices, cancel / downgrade) and redirect
 *                       the admin to it.
 *   changePlan        — start a subscription Checkout for a target plan
 *                       (upgrade / downgrade) and redirect to it.
 *
 * BOTH are admin-gated (owner/admin) and REFUSE-before-fetch while the feature
 * is dark: the service's isConfigured() guard runs FIRST, so a disabled feature
 * returns feature_disabled with no Stripe call. redirect() is called OUTSIDE the
 * try/catch so its NEXT_REDIRECT signal is never swallowed (the _stripe-actions
 * idiom).
 */

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

const BILLING = "/settings/billing";

export async function openBillingPortal(): Promise<void> {
  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    redirect(`${BILLING}?error=forbidden`);
  }

  let target: string;
  try {
    const res = await createBillingPortalSession(wireSelfServeBillingDeps(), {
      orgId: ctx.org.id,
      returnUrl: `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}${BILLING}`,
    });
    target = res.ok ? res.url : `${BILLING}?error=${encodeURIComponent(res.reason)}`;
  } catch (e) {
    console.error("[settings/billing] portal failed", {
      org_id: ctx.org.id,
      error: e instanceof Error ? e.message : String(e),
    });
    target = `${BILLING}?error=portal_failed`;
  }
  redirect(target);
}

const planSchema = z.object({
  plan_key: z.enum(["starter", "pro", "enterprise"]),
});

export async function changePlan(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    redirect(`${BILLING}?error=forbidden`);
  }

  const parsed = planSchema.safeParse({ plan_key: formData.get("plan_key") });
  if (!parsed.success) {
    redirect(`${BILLING}?error=invalid_plan`);
  }

  let target: string;
  try {
    const res = await createPlanChangeCheckout(wireSelfServeBillingDeps(), {
      orgId: ctx.org.id,
      targetPlanKey: parsed.data.plan_key,
      appUrl: env.NEXT_PUBLIC_APP_URL,
    });
    target = res.ok ? res.url : `${BILLING}?error=${encodeURIComponent(res.reason)}`;
  } catch (e) {
    console.error("[settings/billing] plan change failed", {
      org_id: ctx.org.id,
      plan_key: parsed.data.plan_key,
      error: e instanceof Error ? e.message : String(e),
    });
    target = `${BILLING}?error=change_failed`;
  }
  redirect(target);
}
