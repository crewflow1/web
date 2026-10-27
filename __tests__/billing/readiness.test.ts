import { afterEach, describe, expect, it, vi } from "vitest";
import { getBillingReadiness } from "@/lib/billing/readiness";

afterEach(() => vi.unstubAllEnvs());

describe("getBillingReadiness", () => {
  it("is dark by default (no env)", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING", "");
    expect(getBillingReadiness()).toEqual({
      secretConfigured: false,
      webhookConfigured: false,
      selfServeFlag: false,
    });
  });

  it("reports configured + degraded (key without webhook secret)", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const r = getBillingReadiness();
    expect(r.secretConfigured).toBe(true);
    expect(r.webhookConfigured).toBe(false);
  });

  it("reads the self-serve flag only on exact 'true'", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING", "true");
    expect(getBillingReadiness().selfServeFlag).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING", "1");
    expect(getBillingReadiness().selfServeFlag).toBe(false);
  });
});
