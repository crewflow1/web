import "server-only";
import type Stripe from "stripe";
import { getStripe } from "./client";
import { env } from "@/lib/env";
import { PRODUCT_SPECS } from "./provisioning";

/**
 * Stripe price discovery.
 *
 * The CEO created two products in the Stripe dashboard:
 *   - £1,000 one-off setup fee
 *   - £500 / month recurring subscription
 *
 * Rather than baking price IDs into env vars (one more thing to
 * misconfigure), we auto-discover them from Stripe by matching:
 *
 *   setup_fee     → price.recurring === null AND unit_amount === 100_000 AND currency === 'gbp'
 *   subscription  → price.recurring.interval === 'month' AND unit_amount === 50_000 AND currency === 'gbp'
 *
 * If a single match is found, it's used. If 0 or 2+ matches are found
 * the lookup returns an error string so the diagnostic endpoint can
 * surface the problem (the operator then sets STRIPE_SETUP_PRICE_ID /
 * STRIPE_SUBSCRIPTION_PRICE_ID env vars to disambiguate).
 *
 * Results are memoised per-process — Stripe prices don't change often,
 * and we want a fast path for /api/admin/customers/* server actions
 * that create Checkout Sessions on every click.
 */

export const PRICE_KIND = ["setup_fee", "subscription"] as const;
export type PriceKind = (typeof PRICE_KIND)[number];

type Resolved = {
  kind: PriceKind;
  price_id: string;
  unit_amount: number | null;
  currency: string;
  interval: "month" | "year" | "one_time";
  product_name: string | null;
  source: "env_override" | "auto_discovery";
};

type DiscoveryError = {
  kind: PriceKind;
  reason: string;
  candidates: ReadonlyArray<{ id: string; unit_amount: number | null; currency: string; nickname: string | null }>;
};

export type PriceLookup =
  | { ok: true; price: Resolved }
  | { ok: false; error: DiscoveryError };

// Module-level memo — cleared by tests via clearPriceCache().
let cache: { setup_fee?: PriceLookup; subscription?: PriceLookup } = {};

export function clearPriceCache(): void {
  cache = {};
}

const SETUP_AMOUNT_PENCE = 100_000; // £1,000.00
const SUBSCRIPTION_AMOUNT_PENCE = 50_000; // £500.00
const CURRENCY = "gbp";

export async function resolveSetupFeePrice(): Promise<PriceLookup> {
  if (cache.setup_fee) return cache.setup_fee;
  cache.setup_fee = await resolve("setup_fee", env.STRIPE_SETUP_PRICE_ID);
  return cache.setup_fee;
}

export async function resolveSubscriptionPrice(): Promise<PriceLookup> {
  if (cache.subscription) return cache.subscription;
  cache.subscription = await resolve(
    "subscription",
    env.STRIPE_SUBSCRIPTION_PRICE_ID,
  );
  return cache.subscription;
}

async function resolve(
  kind: PriceKind,
  override: string | undefined,
): Promise<PriceLookup> {
  const stripe = getStripe();
  if (!stripe) {
    return {
      ok: false,
      error: {
        kind,
        reason: "STRIPE_SECRET_KEY not configured",
        candidates: [],
      },
    };
  }

  // 1. Honour explicit env override.
  if (override) {
    try {
      const price = await stripe.prices.retrieve(override, {
        expand: ["product"],
      });
      return {
        ok: true,
        price: {
          kind,
          price_id: price.id,
          unit_amount: price.unit_amount,
          currency: price.currency,
          interval: price.recurring?.interval === "month"
            ? "month"
            : price.recurring?.interval === "year"
              ? "year"
              : "one_time",
          product_name:
            typeof price.product === "object" && price.product && "name" in price.product
              ? (price.product as { name?: string }).name ?? null
              : null,
          source: "env_override",
        },
      };
    } catch (e) {
      return {
        ok: false,
        error: {
          kind,
          reason: `Override env var price ${override} could not be retrieved: ${e instanceof Error ? e.message : String(e)}`,
          candidates: [],
        },
      };
    }
  }

  // 2. Stable lookup_key — the recommended Stripe pattern. The
  //    /api/admin/stripe/provision endpoint sets these on the
  //    canonical CrewFlow prices, and they survive renames / price
  //    rotation. Always check this BEFORE falling back to
  //    amount-matching.
  const lookupKey = PRODUCT_SPECS[kind].lookupKey;
  try {
    const byLookup = await stripe.prices.list({
      active: true,
      lookup_keys: [lookupKey],
      limit: 5,
      expand: ["data.product"],
    });
    if (byLookup.data.length === 1) {
      const m = byLookup.data[0]!;
      return {
        ok: true,
        price: {
          kind,
          price_id: m.id,
          unit_amount: m.unit_amount,
          currency: m.currency,
          interval:
            m.recurring?.interval === "month"
              ? "month"
              : m.recurring?.interval === "year"
                ? "year"
                : "one_time",
          product_name:
            typeof m.product === "object" && m.product && "name" in m.product
              ? (m.product as { name?: string }).name ?? null
              : null,
          source: "auto_discovery",
        },
      };
    }
    // 0 or 2+ matches: fall through to amount-matching so the
    // operator gets a useful disambiguation error from there.
  } catch (e) {
    return {
      ok: false,
      error: {
        kind,
        reason: `Stripe prices.list({lookup_keys}) failed: ${e instanceof Error ? e.message : String(e)}`,
        candidates: [],
      },
    };
  }

  // 3. Fallback: discover by amount + currency.
  const targetAmount =
    kind === "setup_fee" ? SETUP_AMOUNT_PENCE : SUBSCRIPTION_AMOUNT_PENCE;
  const requireRecurring = kind === "subscription";
  // Wrap the Stripe SDK call so an auth failure / rate limit / network
  // error returns a clean error result instead of throwing all the way
  // up to the server-action layer (which would surface as a generic
  // "Something went wrong" page with no diagnostic context).
  let prices: Stripe.ApiList<Stripe.Price>;
  try {
    prices = await stripe.prices.list({
      active: true,
      limit: 100,
      type: requireRecurring ? "recurring" : "one_time",
      currency: CURRENCY,
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        kind,
        reason: `Stripe prices.list() failed: ${e instanceof Error ? e.message : String(e)}`,
        candidates: [],
      },
    };
  }

  const matches = prices.data.filter(
    (p) =>
      p.unit_amount === targetAmount &&
      p.currency === CURRENCY &&
      (kind === "setup_fee"
        ? p.recurring === null
        : p.recurring?.interval === "month"),
  );

  if (matches.length === 1) {
    const m = matches[0]!;
    return {
      ok: true,
      price: {
        kind,
        price_id: m.id,
        unit_amount: m.unit_amount,
        currency: m.currency,
        interval: m.recurring?.interval === "month" ? "month" : "one_time",
        product_name: null,
        source: "auto_discovery",
      },
    };
  }

  if (matches.length === 0) {
    return {
      ok: false,
      error: {
        kind,
        reason: `No active ${kind === "setup_fee" ? "one-time" : "monthly"} GBP price at £${targetAmount / 100}. Click 'Provision Stripe products' on /admin/customers/<id> (or POST /api/admin/stripe/provision) to create them with the stable lookup_key '${lookupKey}'.`,
        candidates: prices.data.slice(0, 5).map((p) => ({
          id: p.id,
          unit_amount: p.unit_amount,
          currency: p.currency,
          nickname: p.nickname,
        })),
      },
    };
  }

  return {
    ok: false,
    error: {
      kind,
      reason: `Multiple (${matches.length}) candidate prices match — set ${kind === "setup_fee" ? "STRIPE_SETUP_PRICE_ID" : "STRIPE_SUBSCRIPTION_PRICE_ID"} to disambiguate.`,
      candidates: matches.slice(0, 5).map((p) => ({
        id: p.id,
        unit_amount: p.unit_amount,
        currency: p.currency,
        nickname: p.nickname,
      })),
    },
  };
}
