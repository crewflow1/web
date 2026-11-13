import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isSelfServeBillingConfigured } from "@/lib/billing/self-serve";
import {
  createBillingPortalSession,
  createPlanChangeCheckout,
  listOrgSaasInvoices,
  type SelfServeBillingDeps,
} from "@/server/services/self-serve-billing";

/**
 * "No code path can create a charge while self-serve billing is dark."
 *
 * `security/self-serve-billing.test.ts` already proves refuse-before-fetch, but
 * it injects `isConfigured: () => false` — a stub. This file instead wires the
 * REAL env gate (`isSelfServeBillingConfigured`, reading process.env) into the
 * service entry points, so it proves the PRODUCTION decision — not a test
 * double — refuses, and that the refusal happens before ANY Stripe/DB dep is
 * touched (every dep throws if reached).
 *
 * Self-serve billing stays OFF (CrewFlow is sales-led). This is the regression
 * fence for that policy: flipping either switch on by accident, or wiring a dep
 * that runs before the gate, trips a test.
 */

const GATE_ENV = ["NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING", "STRIPE_SECRET_KEY"];
const original = { ...process.env };

/** Deps whose every member throws — reaching any of them is the failure. */
function boomDeps(): { deps: SelfServeBillingDeps; reached: () => boolean } {
  let reached = false;
  const boom = (): never => {
    reached = true;
    throw new Error("dependency reached while dark — a charge path is open");
  };
  const deps: SelfServeBillingDeps = {
    // The REAL env gate — not a stub.
    isConfigured: isSelfServeBillingConfigured,
    loadOrg: async () => boom(),
    loadSubscription: async () => boom(),
    resolvePlanPriceId: async () => boom(),
    stripe: {
      ensureCustomer: async () => boom(),
      createPortalSession: async () => boom(),
      createCheckoutSession: async () => boom(),
      listInvoices: async () => boom(),
    },
    persistCustomerId: async () => boom(),
    upsertSubscription: async () => boom(),
  };
  return { deps, reached: () => reached };
}

beforeEach(() => {
  for (const k of GATE_ENV) delete process.env[k];
});
afterEach(() => {
  process.env = { ...original };
});

describe("the real env gate is OFF by default", () => {
  it("isSelfServeBillingConfigured() is false with no switches", () => {
    expect(isSelfServeBillingConfigured()).toBe(false);
  });

  it("the master flag ALONE does not enable billing", () => {
    process.env.NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING = "true";
    expect(isSelfServeBillingConfigured()).toBe(false);
  });

  it("a Stripe key ALONE does not enable billing", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    expect(isSelfServeBillingConfigured()).toBe(false);
  });
});

describe("every charge-capable entry point refuses while dark (real gate)", () => {
  it("createPlanChangeCheckout refuses before any dep is touched", async () => {
    const { deps, reached } = boomDeps();
    const res = await createPlanChangeCheckout(deps, {
      orgId: "o1",
      targetPlanKey: "pro",
      appUrl: "https://app",
    });
    expect(res).toEqual({ ok: false, reason: "feature_disabled" });
    expect(reached()).toBe(false);
  });

  it("createBillingPortalSession refuses before any dep is touched", async () => {
    const { deps, reached } = boomDeps();
    const res = await createBillingPortalSession(deps, {
      orgId: "o1",
      returnUrl: "https://app/x",
    });
    expect(res).toEqual({ ok: false, reason: "feature_disabled" });
    expect(reached()).toBe(false);
  });

  it("listOrgSaasInvoices refuses before any dep is touched", async () => {
    const { deps, reached } = boomDeps();
    const res = await listOrgSaasInvoices(deps, { orgId: "o1" });
    expect(res).toEqual({ ok: false, reason: "feature_disabled" });
    expect(reached()).toBe(false);
  });

  it("stays refused even when the master flag is on but the key is absent", async () => {
    process.env.NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING = "true";
    const { deps, reached } = boomDeps();
    const res = await createPlanChangeCheckout(deps, {
      orgId: "o1",
      targetPlanKey: "pro",
      appUrl: "https://app",
    });
    expect(res).toEqual({ ok: false, reason: "feature_disabled" });
    expect(reached()).toBe(false);
  });
});
