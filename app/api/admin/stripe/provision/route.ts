import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { provisionStripeProducts } from "@/lib/stripe/provisioning";
import { clearPriceCache } from "@/lib/stripe/prices";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { isSameOriginRequest } from "@/lib/security/same-origin";

/**
 * CrewFlow — Stripe products + prices provisioner.
 *
 *   POST /api/admin/stripe/provision
 *
 * Idempotent: creates the canonical CrewFlow Setup Fee + Subscription
 * products & prices in Stripe if they don't exist; verifies & returns
 * them if they do. Tagged with stable lookup_keys
 * (`crewflow_setup_fee`, `crewflow_subscription_monthly`) so the
 * price resolver can find them deterministically.
 *
 * Super-admin gated. Returns 404 on miss (no info leak).
 *
 * POST only, from a same-origin browser request: provisioning creates Stripe
 * objects, so it must never run on a GET (a link, a prefetch, an <img>, a
 * top-level navigation from another site). /admin/customers/<id> submits a
 * POST form; Next answers any GET with 405.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "cross_origin_refused" }, { status: 403 });
  }
  return handle();
}

async function handle(): Promise<NextResponse> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) {
    return NextResponse.json({ error: "not_authorised" }, { status: 404 });
  }

  const result = await provisionStripeProducts();

  // Invalidate the in-process price cache so the next checkout call
  // re-discovers the freshly-provisioned prices via lookup_key.
  clearPriceCache();

  // Audit row so the timeline records who provisioned + when.
  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "stripe.products_provisioned",
    targetTable: "organizations",
    targetId: "stripe", // not org-scoped — using a sentinel target id
    metadata: {
      ok: result.ok,
      items: result.items.map((i) => ({
        kind: i.kind,
        product_id: i.product_id,
        product_name: i.product_name,
        price_id: i.price_id,
        lookup_key: i.lookup_key,
        action: i.action,
      })),
      errors: result.errors,
    },
  });

  return NextResponse.json({
    ok: result.ok,
    livemode: result.livemode,
    stripe_account_id: result.stripe_account_id,
    items: result.items,
    errors: result.errors,
  });
}
