import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/client";
import { isSelfServeBillingConfigured } from "@/lib/billing/self-serve";
import { getPlan, isPlanKey, type PlanKey } from "@/lib/billing/plans";
import {
  assertPlanChangeAllowed,
  reduceStripeSubscription,
  type StripeSubscriptionShape,
} from "@/lib/billing/subscription-state";

/**
 * Self-serve billing SERVICE — plan changes, the Stripe Billing Portal, the SaaS
 * invoice list, and the org_subscriptions projection sync.
 *
 * DEPENDENCY-INJECTED so the trust-boundary proofs (refuse-when-dark, plan-state
 * machine, org isolation) run with NO Stripe and NO database — the portal-
 * invoice-payments idiom. The concrete wiring (real Stripe SDK + admin client)
 * is assembled by wireSelfServeBillingDeps() at the bottom, behind `server-only`.
 *
 * REFUSE-BEFORE-FETCH: every entry point checks deps.isConfigured() FIRST and
 * returns a structured refusal before any Stripe call or connection lookup, so
 * while the two-switch gate is dark there is no path to a network call.
 *
 * This reuses CrewFlow's OWN SaaS Stripe integration (STRIPE_SECRET_KEY via
 * getStripe) — SEPARATE from the demo setup-fee checkout and from P2 portal
 * invoice payments (STRIPE_CONNECT_SECRET_KEY, a different client + route).
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type BillingOrg = {
  id: string;
  name: string;
  billing_email: string | null;
  stripe_customer_id: string | null;
  /** organizations.plan — the coarse fallback when no subscription row exists. */
  plan: string;
};

export type SubscriptionRow = {
  org_id: string;
  plan_key: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

export type SaasInvoice = {
  id: string;
  number: string | null;
  amount_due: number; // GBP
  amount_paid: number; // GBP
  currency: string;
  status: string | null;
  created: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
};

export type SelfServeBillingDeps = {
  isConfigured: () => boolean;
  loadOrg: (orgId: string) => Promise<BillingOrg | null>;
  loadSubscription: (orgId: string) => Promise<SubscriptionRow | null>;
  /** Resolve a plan's recurring Stripe price id by its lookup_key. */
  resolvePlanPriceId: (
    lookupKey: string,
  ) => Promise<{ ok: true; priceId: string } | { ok: false; reason: string }>;
  stripe: {
    ensureCustomer: (org: BillingOrg) => Promise<string>;
    createPortalSession: (args: {
      customerId: string;
      returnUrl: string;
    }) => Promise<{ url: string }>;
    createCheckoutSession: (args: {
      customerId: string;
      priceId: string;
      orgId: string;
      planKey: PlanKey;
      successUrl: string;
      cancelUrl: string;
    }) => Promise<{ url: string | null }>;
    listInvoices: (customerId: string) => Promise<SaasInvoice[]>;
  };
  persistCustomerId: (orgId: string, customerId: string) => Promise<void>;
  upsertSubscription: (row: {
    orgId: string;
    projection: ReturnType<typeof reduceStripeSubscription>;
    /** Kept when the projection can't resolve a plan_key from the price. */
    fallbackPlanKey: PlanKey | null;
  }) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Plan resolution
// ---------------------------------------------------------------------------

/** The org's current plan_key: subscription projection wins, else org.plan. */
export function resolveCurrentPlanKey(
  org: BillingOrg,
  sub: SubscriptionRow | null,
): PlanKey {
  if (sub && isPlanKey(sub.plan_key)) return sub.plan_key;
  if (isPlanKey(org.plan)) return org.plan;
  return "trial";
}

// ---------------------------------------------------------------------------
// createBillingPortalSession — manage payment method / cancel / downgrade
// ---------------------------------------------------------------------------

export type PortalResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason: "feature_disabled" | "org_not_found" | "no_customer";
    };

export async function createBillingPortalSession(
  deps: SelfServeBillingDeps,
  args: { orgId: string; returnUrl: string },
): Promise<PortalResult> {
  if (!deps.isConfigured()) return { ok: false, reason: "feature_disabled" };
  const org = await deps.loadOrg(args.orgId);
  if (!org) return { ok: false, reason: "org_not_found" };
  if (!org.stripe_customer_id) return { ok: false, reason: "no_customer" };
  const session = await deps.stripe.createPortalSession({
    customerId: org.stripe_customer_id,
    returnUrl: args.returnUrl,
  });
  return { ok: true, url: session.url };
}

// ---------------------------------------------------------------------------
// createPlanChangeCheckout — upgrade / downgrade via a subscription Checkout
// ---------------------------------------------------------------------------

export type PlanChangeResult =
  | { ok: true; url: string; kind: "upgrade" | "downgrade" }
  | {
      ok: false;
      reason:
        | "feature_disabled"
        | "org_not_found"
        | "invalid_plan"
        | "same_plan"
        | "not_purchasable"
        | "price_unresolved"
        | "no_session_url";
    };

export async function createPlanChangeCheckout(
  deps: SelfServeBillingDeps,
  args: { orgId: string; targetPlanKey: string; appUrl: string },
): Promise<PlanChangeResult> {
  if (!deps.isConfigured()) return { ok: false, reason: "feature_disabled" };

  const org = await deps.loadOrg(args.orgId);
  if (!org) return { ok: false, reason: "org_not_found" };
  const sub = await deps.loadSubscription(args.orgId);
  const currentPlanKey = resolveCurrentPlanKey(org, sub);

  const decision = assertPlanChangeAllowed(currentPlanKey, args.targetPlanKey);
  if (!decision.ok) return { ok: false, reason: decision.reason };

  const plan = getPlan(decision.target)!;
  // decision.ok guarantees a purchasable plan → lookup_key is non-null.
  const priced = await deps.resolvePlanPriceId(plan.stripeLookupKey as string);
  if (!priced.ok) return { ok: false, reason: "price_unresolved" };

  const customerId = await deps.stripe.ensureCustomer(org);
  const base = args.appUrl.replace(/\/$/, "");
  const session = await deps.stripe.createCheckoutSession({
    customerId,
    priceId: priced.priceId,
    orgId: org.id,
    planKey: decision.target,
    successUrl: `${base}/settings/billing?change=success&plan=${decision.target}`,
    cancelUrl: `${base}/settings/billing?change=cancelled`,
  });
  if (!session.url) return { ok: false, reason: "no_session_url" };
  return { ok: true, url: session.url, kind: decision.kind };
}

// ---------------------------------------------------------------------------
// listOrgSaasInvoices — the tenant's CrewFlow invoices/receipts (read Stripe)
// ---------------------------------------------------------------------------

export type InvoicesResult =
  | { ok: true; invoices: SaasInvoice[] }
  | { ok: false; reason: "feature_disabled" | "org_not_found" | "no_customer" };

export async function listOrgSaasInvoices(
  deps: SelfServeBillingDeps,
  args: { orgId: string },
): Promise<InvoicesResult> {
  if (!deps.isConfigured()) return { ok: false, reason: "feature_disabled" };
  const org = await deps.loadOrg(args.orgId);
  if (!org) return { ok: false, reason: "org_not_found" };
  if (!org.stripe_customer_id) return { ok: false, reason: "no_customer" };
  const invoices = await deps.stripe.listInvoices(org.stripe_customer_id);
  return { ok: true, invoices };
}

// ---------------------------------------------------------------------------
// syncOrgSubscriptionFromStripe — project a Stripe subscription onto the table
// ---------------------------------------------------------------------------

/**
 * Called (best-effort) by the Stripe webhook handler on customer.subscription.*
 * events. Idempotent by construction: it upserts one row per org keyed on
 * org_id, and the reduce is a pure function of the event body, so a redelivered
 * event writes the same projection. Never a source of new access-granting state
 * that Stripe didn't already assert.
 */
export async function syncOrgSubscriptionFromStripe(
  deps: SelfServeBillingDeps,
  args: { orgId: string; subscription: StripeSubscriptionShape },
): Promise<void> {
  const projection = reduceStripeSubscription(args.subscription);
  await deps.upsertSubscription({
    orgId: args.orgId,
    projection,
    fallbackPlanKey: projection.plan_key,
  });
}

// ===========================================================================
// CONCRETE WIRING — real Stripe SDK + admin Supabase client. Never imported by
// the hermetic tests; they build their own deps.
// ===========================================================================

function adminTable(name: string) {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as {
    select: (cols: string) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
      };
    };
    update: (payload: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
    upsert: (
      payload: unknown,
      opts: { onConflict: string },
    ) => Promise<{ error: { message: string } | null }>;
  };
}

export function wireSelfServeBillingDeps(): SelfServeBillingDeps {
  return {
    isConfigured: isSelfServeBillingConfigured,

    loadOrg: async (orgId) => {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from("organizations")
        .select("id, name, billing_email, stripe_customer_id, plan" as never)
        .eq("id", orgId)
        .maybeSingle();
      if (error) throw new Error(`org load failed: ${error.message}`);
      if (!data) return null;
      const o = data as unknown as {
        id: string;
        name: string;
        billing_email: string | null;
        stripe_customer_id: string | null;
        plan: string | null;
      };
      return {
        id: o.id,
        name: o.name,
        billing_email: o.billing_email,
        stripe_customer_id: o.stripe_customer_id,
        plan: o.plan ?? "trial",
      };
    },

    loadSubscription: async (orgId) => {
      const { data, error } = await adminTable("org_subscriptions")
        .select(
          "org_id, plan_key, status, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end",
        )
        .eq("org_id", orgId)
        .maybeSingle();
      if (error) throw new Error(`subscription load failed: ${error.message}`);
      return (data as SubscriptionRow | null) ?? null;
    },

    resolvePlanPriceId: async (lookupKey) => {
      const stripe = getStripe();
      if (!stripe) return { ok: false, reason: "STRIPE_SECRET_KEY not configured" };
      try {
        const list = await stripe.prices.list({
          active: true,
          lookup_keys: [lookupKey],
          limit: 2,
        });
        if (list.data.length === 1) return { ok: true, priceId: list.data[0]!.id };
        return {
          ok: false,
          reason:
            list.data.length === 0
              ? `No active price with lookup_key '${lookupKey}'. Set the plan price in Stripe with that lookup_key.`
              : `Multiple prices carry lookup_key '${lookupKey}' — deduplicate in Stripe.`,
        };
      } catch (e) {
        return {
          ok: false,
          reason: `Stripe prices.list failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },

    stripe: {
      ensureCustomer: async (org) => {
        const stripe = getStripe();
        if (!stripe) throw new Error("Stripe not configured");
        if (org.stripe_customer_id) return org.stripe_customer_id;
        const customer = await stripe.customers.create({
          name: org.name,
          email: org.billing_email ?? undefined,
          metadata: { org_id: org.id },
        });
        // Persist so the next flow reuses it (best-effort; the customer exists
        // at Stripe regardless).
        try {
          await adminTable("organizations")
            .update({ stripe_customer_id: customer.id })
            .eq("id", org.id);
        } catch (e) {
          console.error("[self-serve-billing] persist customer id failed", {
            org_id: org.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        return customer.id;
      },
      createPortalSession: async ({ customerId, returnUrl }) => {
        const stripe = getStripe();
        if (!stripe) throw new Error("Stripe not configured");
        const session = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: returnUrl,
        });
        return { url: session.url };
      },
      createCheckoutSession: async ({
        customerId,
        priceId,
        orgId,
        planKey,
        successUrl,
        cancelUrl,
      }) => {
        const stripe = getStripe();
        if (!stripe) throw new Error("Stripe not configured");
        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          customer: customerId,
          line_items: [{ price: priceId, quantity: 1 }],
          metadata: { org_id: orgId, kind: "subscription", plan_key: planKey },
          subscription_data: {
            metadata: { org_id: orgId, kind: "subscription", plan_key: planKey },
          },
          success_url: successUrl,
          cancel_url: cancelUrl,
        });
        return { url: session.url };
      },
      listInvoices: async (customerId) => {
        const stripe = getStripe();
        if (!stripe) throw new Error("Stripe not configured");
        const list = await stripe.invoices.list({ customer: customerId, limit: 24 });
        return list.data.map((inv) => ({
          id: inv.id ?? "",
          number: inv.number ?? null,
          amount_due: (inv.amount_due ?? 0) / 100,
          amount_paid: (inv.amount_paid ?? 0) / 100,
          currency: (inv.currency ?? "gbp").toUpperCase(),
          status: inv.status ?? null,
          created:
            typeof inv.created === "number"
              ? new Date(inv.created * 1000).toISOString()
              : null,
          hosted_invoice_url: inv.hosted_invoice_url ?? null,
          invoice_pdf: inv.invoice_pdf ?? null,
        }));
      },
    },

    persistCustomerId: async (orgId, customerId) => {
      const { error } = await adminTable("organizations")
        .update({ stripe_customer_id: customerId })
        .eq("id", orgId);
      if (error) throw new Error(`persist customer id failed: ${error.message}`);
    },

    upsertSubscription: async ({ orgId, projection, fallbackPlanKey }) => {
      const row: Record<string, unknown> = {
        org_id: orgId,
        status: projection.status,
        stripe_customer_id: projection.stripe_customer_id,
        stripe_subscription_id: projection.stripe_subscription_id,
        stripe_price_id: projection.stripe_price_id,
        current_period_start: projection.current_period_start,
        current_period_end: projection.current_period_end,
        cancel_at_period_end: projection.cancel_at_period_end,
        canceled_at: projection.canceled_at,
      };
      // Only set plan_key when we could resolve one — otherwise keep whatever
      // the existing row holds (don't stomp a good plan_key with a guess).
      const planKey = fallbackPlanKey;
      if (planKey) row.plan_key = planKey;
      const { error } = await adminTable("org_subscriptions").upsert(row, {
        onConflict: "org_id",
      });
      if (error) throw new Error(`subscription upsert failed: ${error.message}`);
    },
  };
}
