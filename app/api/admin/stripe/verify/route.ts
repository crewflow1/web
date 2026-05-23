import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { getStripe, isLiveMode } from "@/lib/stripe/client";
import {
  resolveSetupFeePrice,
  resolveSubscriptionPrice,
} from "@/lib/stripe/prices";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * CrewFlow — Stripe integration verifier.
 *
 *   GET /api/admin/stripe/verify
 *
 * Super-admin only. Runs a battery of read-only checks against the
 * live Stripe API + the local DB so the CEO can confirm everything
 * is wired before sending real customers through checkout.
 *
 * Checks:
 *   1. STRIPE_SECRET_KEY is set and the SDK initialises.
 *   2. STRIPE_WEBHOOK_SECRET is set.
 *   3. NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is set.
 *   4. stripe.accounts.retrieve() succeeds (key actually works).
 *   5. The £1,000 setup-fee price resolves.
 *   6. The £500/mo subscription price resolves.
 *   7. billing_events table is reachable + has expected columns.
 *
 * Returns 200 with { ok, env_mode, checks, blockers } in all cases —
 * the operator can read the JSON to see what's wrong. Returns 404
 * for non-super-admin to avoid leaking env state.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Check = { name: string; ok: boolean; detail?: unknown };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) {
    return NextResponse.json({ error: "not_authorised" }, { status: 404 });
  }

  const checks: Check[] = [];

  // 1. Env: secret key
  checks.push({
    name: "STRIPE_SECRET_KEY set",
    ok: !!env.STRIPE_SECRET_KEY,
    detail: env.STRIPE_SECRET_KEY
      ? {
          prefix: env.STRIPE_SECRET_KEY.slice(0, 8),
          mode: isLiveMode() ? "live" : "test",
        }
      : "missing",
  });

  // 2. Env: webhook secret
  checks.push({
    name: "STRIPE_WEBHOOK_SECRET set",
    ok: !!env.STRIPE_WEBHOOK_SECRET,
    detail: env.STRIPE_WEBHOOK_SECRET
      ? { prefix: env.STRIPE_WEBHOOK_SECRET.slice(0, 7) }
      : "missing",
  });

  // 3. Env: publishable key
  checks.push({
    name: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY set",
    ok: !!env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    detail: env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
      ? { prefix: env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.slice(0, 8) }
      : "missing",
  });

  // 4. Stripe SDK round-trip — accounts.retrieve()
  const stripe = getStripe();
  if (!stripe) {
    checks.push({
      name: "Stripe SDK reachable",
      ok: false,
      detail: "SDK not initialised (STRIPE_SECRET_KEY missing)",
    });
  } else {
    try {
      const acct = await stripe.accounts.retrieve();
      checks.push({
        name: "Stripe SDK reachable",
        ok: true,
        detail: {
          account_id: acct.id,
          country: acct.country,
          charges_enabled: acct.charges_enabled,
          default_currency: acct.default_currency,
        },
      });
    } catch (e) {
      checks.push({
        name: "Stripe SDK reachable",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 5. Setup-fee price discovery
  const setupLookup = await resolveSetupFeePrice();
  checks.push({
    name: "£1,000 setup-fee price resolves",
    ok: setupLookup.ok,
    detail: setupLookup.ok ? setupLookup.price : setupLookup.error,
  });

  // 6. Subscription price discovery
  const subLookup = await resolveSubscriptionPrice();
  checks.push({
    name: "£500/mo subscription price resolves",
    ok: subLookup.ok,
    detail: subLookup.ok ? subLookup.price : subLookup.error,
  });

  // 7. billing_events table reachable
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("billing_events" as never)
      .select("id" as never)
      .limit(1);
    checks.push({
      name: "billing_events table reachable",
      ok: !error,
      detail: error?.message ?? { row_count_probe: (data ?? []).length },
    });
  } catch (e) {
    checks.push({
      name: "billing_events table reachable",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // Optional: also try creating a real Checkout Session as proof
  // that the full flow works end-to-end. Triggered with
  // `?sample_checkout=setup_fee` or `?sample_checkout=subscription`.
  // Real session — appears in Stripe dashboard, expires in 24h,
  // safe in test mode.
  let sampleCheckout:
    | {
        kind: string;
        org_id: string;
        session_id: string;
        url: string | null;
        amount_total: number | null;
      }
    | { error: string }
    | null = null;
  const sampleKind = request.nextUrl.searchParams.get("sample_checkout");
  const sampleOrgId = request.nextUrl.searchParams.get("org_id");
  if (sampleKind && stripe) {
    try {
      const priceLookup =
        sampleKind === "setup_fee"
          ? await resolveSetupFeePrice()
          : sampleKind === "subscription"
            ? await resolveSubscriptionPrice()
            : null;
      if (!priceLookup) {
        sampleCheckout = { error: `unknown kind '${sampleKind}'` };
      } else if (!priceLookup.ok) {
        sampleCheckout = {
          error: `price_unresolved: ${priceLookup.error.reason}`,
        };
      } else if (!sampleOrgId) {
        sampleCheckout = { error: "missing ?org_id=<uuid>" };
      } else {
        // Find/create a Stripe customer for this org.
        const admin = createAdminClient();
        const { data: orgRow } = await admin
          .from("organizations")
          .select(
            "id, name, billing_email, stripe_customer_id" as never,
          )
          .eq("id", sampleOrgId)
          .maybeSingle();
        const org = orgRow as unknown as {
          id: string;
          name: string;
          billing_email: string | null;
          stripe_customer_id: string | null;
        } | null;
        if (!org) {
          sampleCheckout = { error: `org ${sampleOrgId} not found` };
        } else {
          let customerId = org.stripe_customer_id;
          if (!customerId) {
            const c = await stripe.customers.create({
              name: org.name,
              email: org.billing_email ?? undefined,
              metadata: { org_id: org.id, source: "verify_endpoint_sample" },
            });
            customerId = c.id;
            await admin
              .from("organizations")
              .update({ stripe_customer_id: customerId } as never)
              .eq("id", org.id);
          }
          const params = {
            customer: customerId,
            line_items: [{ price: priceLookup.price.price_id, quantity: 1 }],
            metadata: { org_id: org.id, kind: sampleKind, source: "verify_sample" },
            success_url: `${env.NEXT_PUBLIC_APP_URL}/admin/customers/${org.id}?stripe=success&kind=${sampleKind}`,
            cancel_url: `${env.NEXT_PUBLIC_APP_URL}/admin/customers/${org.id}?stripe=cancelled`,
          };
          const session =
            sampleKind === "subscription"
              ? await stripe.checkout.sessions.create({
                  ...params,
                  mode: "subscription",
                })
              : await stripe.checkout.sessions.create({
                  ...params,
                  mode: "payment",
                });
          sampleCheckout = {
            kind: sampleKind,
            org_id: org.id,
            session_id: session.id,
            url: session.url,
            amount_total: session.amount_total,
          };
        }
      }
    } catch (e) {
      sampleCheckout = {
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const allOk = checks.every((c) => c.ok);
  const blockers = checks.filter((c) => !c.ok).map((c) => c.name);

  return NextResponse.json({
    ok: allOk,
    env_mode: isLiveMode() ? "LIVE" : "TEST",
    provision_url: `${env.NEXT_PUBLIC_APP_URL}/api/admin/stripe/provision`,
    ...(sampleCheckout !== null ? { sample_checkout: sampleCheckout } : {}),
    app_url: env.NEXT_PUBLIC_APP_URL,
    webhook_endpoint: `${env.NEXT_PUBLIC_APP_URL}/api/webhooks/stripe`,
    checks,
    blockers,
  });
}
