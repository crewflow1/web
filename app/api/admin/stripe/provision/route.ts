import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { provisionStripeProducts } from "@/lib/stripe/provisioning";
import { clearPriceCache } from "@/lib/stripe/prices";
import { recordAdminActivity } from "@/server/services/hq-audit";

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
 * Also exposed as GET so the CEO can click a link from
 * /admin/customers/<id> and see the JSON directly. The provisioning
 * itself is side-effecting (creates Stripe objects) but idempotent —
 * re-running is harmless.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  return handle();
}

export async function GET(): Promise<NextResponse> {
  // GET is provided for convenience — the CEO can navigate to this
  // URL in a browser and see the JSON. The action is idempotent
  // (Stripe-side) so GET-as-mutation doesn't cause double-creation.
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
