import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PRODUCT_SPECS } from "@/lib/stripe/provisioning";

/**
 * Stripe product-provisioning contract tests.
 *
 * Pins:
 *   1. PRODUCT_SPECS — the canonical CrewFlow product/price spec.
 *      The CEO directive's exact wording becomes a test: setup fee
 *      is one-time GBP £1,000, subscription is recurring monthly
 *      GBP £500. If anyone changes these, this file fails — that's
 *      intentional, it should require a CEO directive.
 *
 *   2. lookup_keys are stable, snake_case, and prefixed `crewflow_`
 *      so they can't collide with another tenant's prices if the
 *      Stripe account is ever shared.
 *
 *   3. The provisioner is idempotent — re-running yields the same
 *      result (existing or claimed_lookup_key), never duplicates.
 *
 *   4. /api/admin/stripe/provision is super-admin gated and writes
 *      to admin_activity_log.
 *
 *   5. The price resolver checks lookup_keys BEFORE falling back to
 *      amount-matching (so renames / additional prices don't break
 *      checkout).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const PROVISIONING = read("lib/stripe/provisioning.ts");
const PROVISION_ROUTE = read("app/api/admin/stripe/provision/route.ts");
const PRICES = read("lib/stripe/prices.ts");
const CUSTOMER_PAGE = read("app/admin/customers/[id]/page.tsx");

// =====================================================================
// 1. Canonical product spec
// =====================================================================

describe("PRODUCT_SPECS — matches the CEO directive exactly", () => {
  it("setup_fee = CrewFlow Setup Fee, one-time, GBP £1,000", () => {
    expect(PRODUCT_SPECS.setup_fee.productName).toBe("CrewFlow Setup Fee");
    expect(PRODUCT_SPECS.setup_fee.unitAmountPence).toBe(100_000);
    expect(PRODUCT_SPECS.setup_fee.recurring).toBe(false);
    expect(PRODUCT_SPECS.setup_fee.lookupKey).toBe("crewflow_setup_fee");
  });

  it("subscription = CrewFlow Subscription, recurring monthly, GBP £500", () => {
    expect(PRODUCT_SPECS.subscription.productName).toBe("CrewFlow Subscription");
    expect(PRODUCT_SPECS.subscription.unitAmountPence).toBe(50_000);
    expect(PRODUCT_SPECS.subscription.recurring).toBe(true);
    expect(PRODUCT_SPECS.subscription.lookupKey).toBe(
      "crewflow_subscription_monthly",
    );
  });

  it("lookup_keys are crewflow_-prefixed snake_case (collision-safe)", () => {
    for (const spec of Object.values(PRODUCT_SPECS)) {
      expect(spec.lookupKey).toMatch(/^crewflow_[a-z][a-z0-9_]*$/);
    }
  });
});

// =====================================================================
// 2. Provisioner is idempotent + tags everything with lookup_key
// =====================================================================

describe("provisioning module behaviour", () => {
  it("checks for existing price by lookup_key BEFORE creating", () => {
    expect(PROVISIONING).toMatch(/stripe\.prices\.list\(\{[\s\S]*lookup_keys:/);
  });

  it("reuses existing product by name when present (no duplicates)", () => {
    expect(PROVISIONING).toMatch(/productList\.data\.find/);
    expect(PROVISIONING).toMatch(/name\.trim\(\)\.toLowerCase\(\)/);
  });

  it("claims a matching unlabeled price via transfer_lookup_key:true", () => {
    expect(PROVISIONING).toMatch(/transfer_lookup_key: true/);
    expect(PROVISIONING).toMatch(/claimed_lookup_key/);
  });

  it("created-from-scratch price carries the correct lookup_key", () => {
    expect(PROVISIONING).toMatch(/lookup_key: spec\.lookupKey/);
  });

  it("returns structured ProvisionResult with per-item action", () => {
    expect(PROVISIONING).toMatch(/created_product_and_price/);
    expect(PROVISIONING).toMatch(/created_price/);
    expect(PROVISIONING).toMatch(/"exists"/);
  });
});

// =====================================================================
// 3. /api/admin/stripe/provision endpoint
// =====================================================================

describe("/api/admin/stripe/provision endpoint", () => {
  it("super-admin gated with 404 on miss (no info leak)", () => {
    expect(PROVISION_ROUTE).toMatch(/isSuperAdminEmail/);
    expect(PROVISION_ROUTE).toMatch(/status: 404/);
  });

  it("supports both GET (browser convenience) and POST (form submit)", () => {
    expect(PROVISION_ROUTE).toMatch(/export async function GET/);
    expect(PROVISION_ROUTE).toMatch(/export async function POST/);
  });

  it("clears the in-process price cache so the next checkout re-discovers", () => {
    expect(PROVISION_ROUTE).toMatch(/clearPriceCache/);
  });

  it("writes admin_activity_log so the timeline shows who provisioned", () => {
    expect(PROVISION_ROUTE).toMatch(/recordAdminActivity/);
    expect(PROVISION_ROUTE).toMatch(/"stripe\.products_provisioned"/);
  });
});

// =====================================================================
// 4. Resolver prefers lookup_keys
// =====================================================================

describe("price resolver — lookup_key precedence", () => {
  it("calls prices.list with lookup_keys BEFORE the amount-match fallback", () => {
    // Both lookups appear; the lookup-keys block must precede the
    // fallback in source order.
    const lookupIdx = PRICES.indexOf("lookup_keys: [lookupKey]");
    const fallbackIdx = PRICES.indexOf("type: requireRecurring");
    expect(lookupIdx).toBeGreaterThan(0);
    expect(fallbackIdx).toBeGreaterThan(lookupIdx);
  });

  it("uses the canonical lookup_keys from PRODUCT_SPECS", () => {
    expect(PRICES).toMatch(/PRODUCT_SPECS\[kind\]\.lookupKey/);
  });

  it("when zero prices match a lookup_key, error message points operator at /provision", () => {
    expect(PRICES).toMatch(/Provision Stripe products/);
    expect(PRICES).toMatch(/\/api\/admin\/stripe\/provision/);
  });
});

// =====================================================================
// 5. Customer page wires the new Provision button
// =====================================================================

describe("/admin/customers/[id] — Provision button", () => {
  it("links to /api/admin/stripe/provision", () => {
    expect(CUSTOMER_PAGE).toMatch(/\/api\/admin\/stripe\/provision/);
  });
  it("still links to the diagnostic alongside", () => {
    expect(CUSTOMER_PAGE).toMatch(/\/api\/admin\/stripe\/verify/);
  });
});
