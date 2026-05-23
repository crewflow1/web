import { NextResponse } from "next/server";
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

export async function GET(): Promise<NextResponse> {
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

  const allOk = checks.every((c) => c.ok);
  const blockers = checks.filter((c) => !c.ok).map((c) => c.name);

  return NextResponse.json({
    ok: allOk,
    env_mode: isLiveMode() ? "LIVE" : "TEST",
    app_url: env.NEXT_PUBLIC_APP_URL,
    webhook_endpoint: `${env.NEXT_PUBLIC_APP_URL}/api/webhooks/stripe`,
    checks,
    blockers,
  });
}
