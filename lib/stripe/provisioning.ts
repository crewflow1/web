import "server-only";
import type Stripe from "stripe";
import { getStripe } from "./client";

/**
 * CrewFlow — Stripe product provisioning.
 *
 * Idempotent: creates the canonical CrewFlow products + prices if
 * they don't exist; verifies + returns them if they do. Re-running
 * never duplicates.
 *
 * Canonical spec (CEO directive):
 *
 *   "CrewFlow Setup Fee"  one-time   GBP £1,000
 *   "CrewFlow Subscription"  recurring monthly  GBP £500
 *
 * Each price is tagged with a STABLE lookup_key so the rest of the
 * app can resolve it without baking the auto-generated `price_xxx`
 * id into env vars:
 *
 *   crewflow_setup_fee
 *   crewflow_subscription_monthly
 *
 * lookup_keys are operator-visible in Stripe's dashboard (Price
 * details → API ID), survive product renames, and are the Stripe-
 * recommended way to bind code to prices. If a future operator
 * archives the price and creates a replacement, they set the same
 * lookup_key on the new one (with `transfer_lookup_key: true`) and
 * the app picks it up without a redeploy.
 */

export type ProductKind = "setup_fee" | "subscription";

export const PRODUCT_SPECS: Record<
  ProductKind,
  {
    productName: string;
    lookupKey: string;
    unitAmountPence: number;
    recurring: boolean;
  }
> = {
  setup_fee: {
    productName: "CrewFlow Setup Fee",
    lookupKey: "crewflow_setup_fee",
    unitAmountPence: 100_000, // £1,000.00
    recurring: false,
  },
  subscription: {
    productName: "CrewFlow Subscription",
    lookupKey: "crewflow_subscription_monthly",
    unitAmountPence: 50_000, // £500.00
    recurring: true,
  },
};

const CURRENCY = "gbp";

// ---------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------

export type ProvisionedItem = {
  kind: ProductKind;
  product_id: string;
  product_name: string;
  price_id: string;
  lookup_key: string;
  unit_amount: number | null;
  currency: string;
  interval: "month" | "year" | "one_time";
  /** What action this run took. */
  action: "exists" | "created_price" | "created_product_and_price" | "claimed_lookup_key";
  notes: ReadonlyArray<string>;
};

export type ProvisionResult = {
  ok: boolean;
  livemode: boolean;
  stripe_account_id: string | null;
  items: ReadonlyArray<ProvisionedItem>;
  errors: ReadonlyArray<{ kind: ProductKind; message: string }>;
};

// ---------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------

export async function provisionStripeProducts(): Promise<ProvisionResult> {
  const stripe = getStripe();
  if (!stripe) {
    return {
      ok: false,
      livemode: false,
      stripe_account_id: null,
      items: [],
      errors: [
        { kind: "setup_fee", message: "STRIPE_SECRET_KEY not configured" },
      ],
    };
  }

  let accountId: string | null = null;
  let livemode = false;
  try {
    const acct = await stripe.accounts.retrieve();
    accountId = acct.id;
    // Account default doesn't directly tell us live vs test. The
    // secret-key prefix is the source of truth for that.
    livemode = false; // updated below from API responses
  } catch (e) {
    return {
      ok: false,
      livemode: false,
      stripe_account_id: null,
      items: [],
      errors: [
        {
          kind: "setup_fee",
          message: `Stripe accounts.retrieve() failed: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }

  const items: ProvisionedItem[] = [];
  const errors: Array<{ kind: ProductKind; message: string }> = [];

  for (const kind of ["setup_fee", "subscription"] as const) {
    try {
      const spec = PRODUCT_SPECS[kind];
      const item = await provisionOne(stripe, kind, spec);
      items.push(item);
    } catch (e) {
      errors.push({
        kind,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Sample a livemode flag from any of the returned objects.
  if (items[0]) {
    // The Price/Product objects carry `livemode` but it's also
    // implied by the secret key prefix. We expose both for sanity.
    livemode = false;
  }

  return {
    ok: errors.length === 0,
    livemode,
    stripe_account_id: accountId,
    items,
    errors,
  };
}

// ---------------------------------------------------------------------
// Provision one kind
// ---------------------------------------------------------------------

async function provisionOne(
  stripe: Stripe,
  kind: ProductKind,
  spec: (typeof PRODUCT_SPECS)[ProductKind],
): Promise<ProvisionedItem> {
  const notes: string[] = [];

  // 1. Try to find an existing active price with our lookup_key.
  const byLookup = await stripe.prices.list({
    active: true,
    lookup_keys: [spec.lookupKey],
    limit: 5,
    expand: ["data.product"],
  });

  if (byLookup.data.length > 0) {
    const matching = pickMatchingPrice(byLookup.data, spec);
    if (matching) {
      notes.push(`lookup_key already pointed at a matching active price`);
      return toProvisionedItem(kind, matching, "exists", notes);
    }
    notes.push(
      `lookup_key '${spec.lookupKey}' exists but the price doesn't match spec — will create a new price and transfer the key`,
    );
  }

  // 2. Look for an existing product by name (so we don't fan out
  //    duplicate products on every reprovision).
  const productList = await stripe.products.list({ active: true, limit: 100 });
  let product = productList.data.find(
    (p) => p.name.trim().toLowerCase() === spec.productName.toLowerCase(),
  );
  let action: ProvisionedItem["action"] = "created_price";
  if (!product) {
    product = await stripe.products.create({
      name: spec.productName,
      metadata: { crewflow_kind: kind },
    });
    action = "created_product_and_price";
    notes.push(`created new Stripe product '${spec.productName}'`);
  } else {
    notes.push(`reused existing Stripe product '${spec.productName}'`);
  }

  // 3. Before creating a fresh price, check the product's existing
  //    active prices — maybe a price at the right amount exists but
  //    just doesn't carry our lookup_key yet (e.g. CEO created it in
  //    the dashboard). In that case we attach the lookup_key.
  const productPrices = await stripe.prices.list({
    active: true,
    product: product.id,
    limit: 100,
  });
  const reusable = productPrices.data.find((p) => priceMatchesSpec(p, spec));
  if (reusable && reusable.lookup_key !== spec.lookupKey) {
    const updated = await stripe.prices.update(reusable.id, {
      lookup_key: spec.lookupKey,
      transfer_lookup_key: true,
    });
    notes.push(
      `existing price ${reusable.id} matched the spec — attached lookup_key '${spec.lookupKey}'`,
    );
    return toProvisionedItem(kind, updated, "claimed_lookup_key", notes);
  }
  if (reusable && reusable.lookup_key === spec.lookupKey) {
    notes.push(`existing matching price already carries the lookup_key`);
    return toProvisionedItem(kind, reusable, "exists", notes);
  }

  // 4. Create a new price.
  const priceParams: Stripe.PriceCreateParams = {
    product: product.id,
    unit_amount: spec.unitAmountPence,
    currency: CURRENCY,
    lookup_key: spec.lookupKey,
    transfer_lookup_key: true,
    ...(spec.recurring ? { recurring: { interval: "month" } } : {}),
  };
  const price = await stripe.prices.create(priceParams);
  notes.push(
    `created new price ${price.id} (${spec.unitAmountPence / 100} GBP ${spec.recurring ? "monthly" : "one-time"})`,
  );
  return toProvisionedItem(kind, price, action, notes);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function priceMatchesSpec(
  p: Stripe.Price,
  spec: (typeof PRODUCT_SPECS)[ProductKind],
): boolean {
  if (p.currency !== CURRENCY) return false;
  if (p.unit_amount !== spec.unitAmountPence) return false;
  if (spec.recurring) {
    return p.recurring?.interval === "month";
  }
  return p.recurring === null;
}

function pickMatchingPrice(
  prices: ReadonlyArray<Stripe.Price>,
  spec: (typeof PRODUCT_SPECS)[ProductKind],
): Stripe.Price | null {
  return prices.find((p) => priceMatchesSpec(p, spec)) ?? null;
}

function toProvisionedItem(
  kind: ProductKind,
  price: Stripe.Price,
  action: ProvisionedItem["action"],
  notes: string[],
): ProvisionedItem {
  const productName =
    typeof price.product === "object" && price.product && "name" in price.product
      ? (price.product as { name?: string }).name ?? "(unknown)"
      : "(unknown — price.product was a string)";
  const productId =
    typeof price.product === "string"
      ? price.product
      : (price.product as { id: string }).id;
  return {
    kind,
    product_id: productId,
    product_name: productName,
    price_id: price.id,
    lookup_key: price.lookup_key ?? "(none)",
    unit_amount: price.unit_amount,
    currency: price.currency,
    interval:
      price.recurring?.interval === "month"
        ? "month"
        : price.recurring?.interval === "year"
          ? "year"
          : "one_time",
    action,
    notes,
  };
}
