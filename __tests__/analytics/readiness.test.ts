import { afterEach, describe, expect, it, vi } from "vitest";
import { getAnalyticsReadiness } from "@/lib/analytics/readiness";

afterEach(() => vi.unstubAllEnvs());

describe("getAnalyticsReadiness", () => {
  it("is dark by default", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    vi.stubEnv("ANALYTICS_SERVER_ENABLED", "");
    vi.stubEnv("POSTHOG_SERVER_KEY", "");
    expect(getAnalyticsReadiness()).toEqual({ clientConfigured: false, serverEnabled: false });
  });

  it("reports clientConfigured when the public key is present", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_x");
    expect(getAnalyticsReadiness().clientConfigured).toBe(true);
  });

  it("requires BOTH the opt-in flag and the server key for serverEnabled", () => {
    vi.stubEnv("ANALYTICS_SERVER_ENABLED", "true");
    vi.stubEnv("POSTHOG_SERVER_KEY", "");
    expect(getAnalyticsReadiness().serverEnabled).toBe(false);
    vi.stubEnv("POSTHOG_SERVER_KEY", "phc_srv");
    expect(getAnalyticsReadiness().serverEnabled).toBe(true);
    vi.stubEnv("ANALYTICS_SERVER_ENABLED", "false");
    expect(getAnalyticsReadiness().serverEnabled).toBe(false);
  });
});
