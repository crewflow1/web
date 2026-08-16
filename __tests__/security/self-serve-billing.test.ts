import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  selfServeBillingFeatureEnabled,
  selfServeBillingKeyPresent,
  isSelfServeBillingConfigured,
} from "@/lib/billing/self-serve";
import {
  PLAN_KEYS,
  FEATURE_KEYS,
  getPlan,
  isPlanKey,
  listPlans,
  purchasablePlans,
} from "@/lib/billing/plans";
import {
  planHasFeature,
  planEntitlements,
  ALL_FEATURES,
} from "@/lib/billing/entitlements";
import {
  classifyPlanChange,
  assertPlanChangeAllowed,
  reduceStripeSubscription,
  mapStripeStatus,
  planKeyForLookupKey,
  statusGrantsAccess,
  type StripeSubscriptionShape,
} from "@/lib/billing/subscription-state";
import {
  createBillingPortalSession,
  createPlanChangeCheckout,
  listOrgSaasInvoices,
  resolveCurrentPlanKey,
  type SelfServeBillingDeps,
  type BillingOrg,
} from "@/server/services/self-serve-billing";

/**
 * P3W2 SELF-SERVE BILLING (20261148) — trust-boundary proofs. Hermetic: no DB,
 * no Stripe. Sections:
 *   1. The feature is DARK (two-switch gate) + refuse-before-fetch.
 *   2. Plan catalogue + entitlement gate (deterministic).
 *   3. The upgrade/downgrade state machine + Stripe→row reducer.
 *   4. Plan-change flow: ownership/plan guards, org isolation, happy path.
 *   5. The migration — RLS, service-role-write, uniques, dark, config↔DB drift.
 *   6. Separation from the demo checkout + P2 portal payments.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const MIG = "supabase/migrations/20261148000000_self_serve_billing.sql";
const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
const sql = sqlOnly(read(MIG));

const GATE_ENV = ["NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING", "STRIPE_SECRET_KEY"];

// ---------------------------------------------------------------------------
// 1. THE FEATURE IS DARK — two-switch gate
// ---------------------------------------------------------------------------

describe("self-serve billing is dark without the flag + key", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of GATE_ENV) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("nothing configured with neither switch", () => {
    expect(selfServeBillingFeatureEnabled()).toBe(false);
    expect(selfServeBillingKeyPresent()).toBe(false);
    expect(isSelfServeBillingConfigured()).toBe(false);
  });

  it("the flag alone is NOT configured", () => {
    process.env.NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING = "true";
    expect(selfServeBillingFeatureEnabled()).toBe(true);
    expect(isSelfServeBillingConfigured()).toBe(false);
  });

  it("the key alone is NOT configured", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    expect(selfServeBillingKeyPresent()).toBe(true);
    expect(isSelfServeBillingConfigured()).toBe(false);
  });

  it("only BOTH switches configure the feature", () => {
    process.env.NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    expect(isSelfServeBillingConfigured()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1b. REFUSE-BEFORE-FETCH — every entry point refuses with no Stripe / DB call
// ---------------------------------------------------------------------------

function darkDeps(): { deps: SelfServeBillingDeps; touched: () => boolean } {
  let touched = false;
  const boom = () => {
    touched = true;
    throw new Error("must not be reached while dark");
  };
  const deps: SelfServeBillingDeps = {
    isConfigured: () => false,
    loadOrg: async () => {
      boom();
      return null;
    },
    loadSubscription: async () => {
      boom();
      return null;
    },
    resolvePlanPriceId: async () => {
      boom();
      return { ok: false, reason: "x" };
    },
    stripe: {
      ensureCustomer: async () => {
        boom();
        return "";
      },
      createPortalSession: async () => {
        boom();
        return { url: "" };
      },
      createCheckoutSession: async () => {
        boom();
        return { url: null };
      },
      listInvoices: async () => {
        boom();
        return [];
      },
    },
    persistCustomerId: async () => boom(),
    upsertSubscription: async () => boom(),
  };
  return { deps, touched: () => touched };
}

describe("refuse-before-fetch when dark", () => {
  it("createBillingPortalSession refuses with no lookup/Stripe call", async () => {
    const { deps, touched } = darkDeps();
    const res = await createBillingPortalSession(deps, {
      orgId: "o1",
      returnUrl: "https://app/x",
    });
    expect(res).toEqual({ ok: false, reason: "feature_disabled" });
    expect(touched()).toBe(false);
  });

  it("createPlanChangeCheckout refuses with no lookup/Stripe call", async () => {
    const { deps, touched } = darkDeps();
    const res = await createPlanChangeCheckout(deps, {
      orgId: "o1",
      targetPlanKey: "pro",
      appUrl: "https://app",
    });
    expect(res).toEqual({ ok: false, reason: "feature_disabled" });
    expect(touched()).toBe(false);
  });

  it("listOrgSaasInvoices refuses with no Stripe call", async () => {
    const { deps, touched } = darkDeps();
    const res = await listOrgSaasInvoices(deps, { orgId: "o1" });
    expect(res).toEqual({ ok: false, reason: "feature_disabled" });
    expect(touched()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. PLAN CATALOGUE + ENTITLEMENT GATE
// ---------------------------------------------------------------------------

describe("plan catalogue", () => {
  it("defines the four plans with distinct ranks", () => {
    expect([...PLAN_KEYS]).toEqual(["trial", "starter", "pro", "enterprise"]);
    const ranks = listPlans().map((p) => p.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("trial has NO Stripe price; purchasable plans all do", () => {
    expect(getPlan("trial")!.stripeLookupKey).toBeNull();
    const purchasable = purchasablePlans();
    expect(purchasable.map((p) => p.key)).toEqual(["starter", "pro", "enterprise"]);
    for (const p of purchasable) expect(p.stripeLookupKey).toBeTruthy();
  });

  it("NEVER invents a price amount (all priceHintGbp are null)", () => {
    for (const p of listPlans()) expect(p.priceHintGbp).toBeNull();
  });

  it("isPlanKey is fail-closed", () => {
    expect(isPlanKey("pro")).toBe(true);
    expect(isPlanKey("free")).toBe(false);
    expect(isPlanKey(null)).toBe(false);
  });
});

describe("entitlement gate is deterministic", () => {
  it("plan→feature checks reflect the catalogue", () => {
    expect(planHasFeature("trial", "core")).toBe(true);
    expect(planHasFeature("trial", "api_access")).toBe(false);
    expect(planHasFeature("pro", "api_access")).toBe(true);
    expect(planHasFeature("enterprise", "priority_support")).toBe(true);
    expect(planHasFeature("starter", "priority_support")).toBe(false);
  });

  it("fails closed on unknown plan or feature", () => {
    expect(planHasFeature("nope", "core")).toBe(false);
    expect(planHasFeature("pro", "teleport")).toBe(false);
  });

  it("planEntitlements is a set of the plan's features", () => {
    expect([...planEntitlements("pro")].sort()).toEqual(
      [...getPlan("pro")!.features].sort(),
    );
    expect(planEntitlements("unknown").size).toBe(0);
  });

  it("ALL_FEATURES covers every catalogue feature key", () => {
    for (const f of FEATURE_KEYS) expect(ALL_FEATURES.has(f)).toBe(true);
  });

  it("higher plans are supersets of lower plans (monotone entitlements)", () => {
    const ranked = listPlans();
    for (let i = 1; i < ranked.length; i++) {
      const lower = new Set(ranked[i - 1]!.features);
      const higher = new Set(ranked[i]!.features);
      for (const f of lower) expect(higher.has(f)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. STATE MACHINE + REDUCER
// ---------------------------------------------------------------------------

describe("plan-change state machine", () => {
  it("classifies upgrade / downgrade / noop / invalid", () => {
    expect(classifyPlanChange("starter", "pro")).toBe("upgrade");
    expect(classifyPlanChange("pro", "starter")).toBe("downgrade");
    expect(classifyPlanChange("pro", "pro")).toBe("noop");
    expect(classifyPlanChange("pro", "trial")).toBe("invalid"); // no down-to-trial
    expect(classifyPlanChange("bogus", "pro")).toBe("invalid");
  });

  it("assertPlanChangeAllowed guards same-plan + non-purchasable + invalid", () => {
    expect(assertPlanChangeAllowed("starter", "pro")).toEqual({
      ok: true,
      kind: "upgrade",
      target: "pro",
    });
    expect(assertPlanChangeAllowed("pro", "starter")).toEqual({
      ok: true,
      kind: "downgrade",
      target: "starter",
    });
    expect(assertPlanChangeAllowed("pro", "pro")).toEqual({
      ok: false,
      reason: "same_plan",
    });
    expect(assertPlanChangeAllowed("starter", "trial")).toEqual({
      ok: false,
      reason: "invalid_plan",
    });
  });
});

describe("Stripe subscription reducer", () => {
  it("maps status verbatim + fails closed on unknown", () => {
    expect(mapStripeStatus("active")).toBe("active");
    expect(mapStripeStatus("past_due")).toBe("past_due");
    expect(mapStripeStatus("weird")).toBe("incomplete");
    expect(statusGrantsAccess("active")).toBe(true);
    expect(statusGrantsAccess("past_due")).toBe(false);
  });

  it("resolves plan_key from the price lookup_key", () => {
    expect(planKeyForLookupKey("crewflow_plan_pro_monthly")).toBe("pro");
    expect(planKeyForLookupKey("unknown_key")).toBeNull();
    expect(planKeyForLookupKey(null)).toBeNull();
  });

  it("projects a Stripe subscription onto the row columns", () => {
    const sub: StripeSubscriptionShape = {
      id: "sub_1",
      status: "active",
      customer: "cus_1",
      cancel_at_period_end: true,
      canceled_at: null,
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_000_000,
      items: { data: [{ price: { id: "price_1", lookup_key: "crewflow_plan_pro_monthly" } }] },
    };
    const p = reduceStripeSubscription(sub);
    expect(p.status).toBe("active");
    expect(p.stripe_customer_id).toBe("cus_1");
    expect(p.stripe_subscription_id).toBe("sub_1");
    expect(p.stripe_price_id).toBe("price_1");
    expect(p.plan_key).toBe("pro");
    expect(p.cancel_at_period_end).toBe(true);
    expect(p.current_period_end).toBe(new Date(1_702_000_000 * 1000).toISOString());
  });

  it("handles a customer object + unknown price (plan_key null)", () => {
    const p = reduceStripeSubscription({
      id: "sub_2",
      status: "trialing",
      customer: { id: "cus_2" },
      items: { data: [{ price: { id: "price_x", lookup_key: null } }] },
    });
    expect(p.stripe_customer_id).toBe("cus_2");
    expect(p.plan_key).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. PLAN-CHANGE FLOW — guards, org isolation, happy path
// ---------------------------------------------------------------------------

function org(overrides: Partial<BillingOrg> = {}): BillingOrg {
  return {
    id: "o1",
    name: "Acme",
    billing_email: "a@acme.test",
    stripe_customer_id: "cus_1",
    plan: "starter",
    ...overrides,
  };
}

function liveDeps(over: Partial<SelfServeBillingDeps> = {}): SelfServeBillingDeps {
  return {
    isConfigured: () => true,
    loadOrg: async () => org(),
    loadSubscription: async () => null,
    resolvePlanPriceId: async () => ({ ok: true, priceId: "price_pro" }),
    stripe: {
      ensureCustomer: async (o) => o.stripe_customer_id ?? "cus_new",
      createPortalSession: async ({ customerId }) => ({
        url: `https://portal/${customerId}`,
      }),
      createCheckoutSession: async ({ customerId, priceId }) => ({
        url: `https://checkout/${customerId}/${priceId}`,
      }),
      listInvoices: async () => [],
    },
    persistCustomerId: async () => undefined,
    upsertSubscription: async () => undefined,
    ...over,
  };
}

describe("createPlanChangeCheckout guards + happy path", () => {
  it("refuses same_plan (org on starter → starter) with no Stripe call", async () => {
    let called = false;
    const res = await createPlanChangeCheckout(
      liveDeps({
        resolvePlanPriceId: async () => {
          called = true;
          return { ok: true, priceId: "x" };
        },
      }),
      { orgId: "o1", targetPlanKey: "starter", appUrl: "https://app" },
    );
    expect(res).toEqual({ ok: false, reason: "same_plan" });
    expect(called).toBe(false);
  });

  it("refuses a downgrade to trial (invalid_plan)", async () => {
    const res = await createPlanChangeCheckout(liveDeps(), {
      orgId: "o1",
      targetPlanKey: "trial",
      appUrl: "https://app",
    });
    expect(res).toEqual({ ok: false, reason: "invalid_plan" });
  });

  it("refuses when the plan price can't be resolved", async () => {
    const res = await createPlanChangeCheckout(
      liveDeps({ resolvePlanPriceId: async () => ({ ok: false, reason: "no price" }) }),
      { orgId: "o1", targetPlanKey: "pro", appUrl: "https://app" },
    );
    expect(res).toEqual({ ok: false, reason: "price_unresolved" });
  });

  it("mints a subscription checkout on the org's OWN customer (upgrade)", async () => {
    let sessionArgs: { customerId: string; orgId: string; planKey: string } | null = null;
    const res = await createPlanChangeCheckout(
      liveDeps({
        stripe: {
          ...liveDeps().stripe,
          createCheckoutSession: async (a) => {
            sessionArgs = { customerId: a.customerId, orgId: a.orgId, planKey: a.planKey };
            return { url: "https://checkout/ok" };
          },
        },
      }),
      { orgId: "o1", targetPlanKey: "pro", appUrl: "https://app" },
    );
    expect(res).toEqual({ ok: true, url: "https://checkout/ok", kind: "upgrade" });
    expect(sessionArgs!.customerId).toBe("cus_1");
    expect(sessionArgs!.orgId).toBe("o1");
    expect(sessionArgs!.planKey).toBe("pro");
  });

  it("subscription projection plan_key wins over organizations.plan for current-plan", () => {
    // org.plan=starter but the projection says pro → current plan is pro.
    expect(resolveCurrentPlanKey(org({ plan: "starter" }), null)).toBe("starter");
    expect(
      resolveCurrentPlanKey(org({ plan: "starter" }), {
        org_id: "o1",
        plan_key: "pro",
        status: "active",
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
        current_period_end: null,
        cancel_at_period_end: false,
      }),
    ).toBe("pro");
  });
});

describe("createBillingPortalSession", () => {
  it("refuses no_customer when the org has no Stripe customer", async () => {
    const res = await createBillingPortalSession(
      liveDeps({ loadOrg: async () => org({ stripe_customer_id: null }) }),
      { orgId: "o1", returnUrl: "https://app/x" },
    );
    expect(res).toEqual({ ok: false, reason: "no_customer" });
  });

  it("mints a portal session on the org's own customer", async () => {
    const res = await createBillingPortalSession(liveDeps(), {
      orgId: "o1",
      returnUrl: "https://app/x",
    });
    expect(res).toEqual({ ok: true, url: "https://portal/cus_1" });
  });
});

// ---------------------------------------------------------------------------
// 5. THE MIGRATION — RLS, service-role-write, uniques, dark, drift
// ---------------------------------------------------------------------------

describe("migration 20261148 — org_subscriptions", () => {
  it("enables RLS, member-READ, and NO authenticated write policy (service-role only)", () => {
    expect(sql).toMatch(/alter table public\.org_subscriptions enable row level security/i);
    expect(sql).toMatch(
      /create policy[^;]*org_subscriptions: members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
    expect(sql).not.toMatch(/org_subscriptions[^;]*for insert/i);
    expect(sql).not.toMatch(/org_subscriptions[^;]*for update/i);
    expect(sql).not.toMatch(/org_subscriptions[^;]*for delete/i);
  });

  it("is org-pinned with cascade + one-per-org + composite (id, org_id) key", () => {
    expect(sql).toMatch(
      /org_id\s+uuid not null references public\.organizations\(id\) on delete cascade/i,
    );
    expect(sql).toMatch(/constraint org_subscriptions_org_uniq unique \(org_id\)/i);
    expect(sql).toMatch(/constraint org_subscriptions_id_org_key unique \(id, org_id\)/i);
    expect(sql).toMatch(/constraint org_subscriptions_sub_uniq unique \(stripe_subscription_id\)/i);
  });

  it("constrains plan_key + status to closed sets", () => {
    expect(sql).toMatch(/plan_key[\s\S]*check \(plan_key in \('trial', 'starter', 'pro', 'enterprise'\)\)/i);
    expect(sql).toMatch(/status[\s\S]*check \(status in \(/i);
  });

  it("writes NOTHING (dark by default — no seeded rows)", () => {
    expect(sql).not.toMatch(/insert\s+into\s+public\.org_subscriptions/i);
  });

  it("revokes anon", () => {
    expect(sql).toMatch(/revoke all on table public\.org_subscriptions from anon/i);
  });

  it("[drift] the plan_key CHECK matches lib/billing PLAN_KEYS exactly", () => {
    const m = sql.match(/check \(plan_key in \(([^)]*)\)\)/i);
    expect(m).toBeTruthy();
    const dbKeys = m![1]!
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .sort();
    expect(dbKeys).toEqual([...PLAN_KEYS].sort());
  });
});

// ---------------------------------------------------------------------------
// 6. SEPARATION FROM DEMO CHECKOUT + P2 PORTAL PAYMENTS
// ---------------------------------------------------------------------------

describe("separation from other Stripe integrations", () => {
  const codeOf = (ts: string) =>
    ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const gate = codeOf(read("lib/billing/self-serve.ts"));
  const service = codeOf(read("server/services/self-serve-billing.ts"));

  it("the gate reuses the SaaS key (STRIPE_SECRET_KEY), never the Connect key", () => {
    expect(gate).toMatch(/STRIPE_SECRET_KEY/);
    expect(gate).not.toMatch(/STRIPE_CONNECT_SECRET_KEY/);
  });

  it("the service uses the SaaS Stripe client, not the portal-payments client", () => {
    expect(service).toMatch(/from "@\/lib\/stripe\/client"/);
    expect(service).not.toMatch(/portal-stripe/);
    expect(service).not.toMatch(/STRIPE_CONNECT_SECRET_KEY/);
  });

  it("registered in the GDPR org-tables registry (known + excluded, no export)", () => {
    const reg = JSON.parse(read("lib/gdpr/org-tables.json")) as {
      known: string[];
      excluded: Record<string, string>;
    };
    expect(reg.known).toContain("org_subscriptions");
    expect(reg.excluded.org_subscriptions).toBeTruthy();
  });
});
