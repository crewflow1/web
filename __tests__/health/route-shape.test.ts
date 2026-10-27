import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/health contract: provider readiness is reported as BOOLEANS, no provider
 * gates `ok` (only the DB does), and no secret/key value leaks into the public
 * body. Covers the comms shape plus the billing/analytics/migrationOperator
 * blocks. The DB + cron probes are mocked so the shape is tested without I/O.
 */

const { probeDatabase, probeCronFreshness } = vi.hoisted(() => ({
  probeDatabase: vi.fn(async () => ({ ok: true })),
  probeCronFreshness: vi.fn(async () => ({ ageMinutes: 5 })),
}));
vi.mock("@/lib/health/db-probe", () => ({ probeDatabase }));
vi.mock("@/lib/health/cron-freshness", () => ({ probeCronFreshness }));

import { GET } from "@/app/api/health/route";

beforeEach(() => {
  vi.clearAllMocks();
  probeDatabase.mockResolvedValue({ ok: true });
  probeCronFreshness.mockResolvedValue({ ageMinutes: 5 });
  for (const k of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING",
    "NEXT_PUBLIC_POSTHOG_KEY",
    "ANALYTICS_SERVER_ENABLED",
    "POSTHOG_SERVER_KEY",
    "CREWFLOW_SUPERADMIN_EMAILS",
  ]) {
    vi.stubEnv(k, "");
  }
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/health shape", () => {
  it("reports provider readiness as booleans (dark by default) and ok is true when the DB is up", async () => {
    const body = await (await GET()).json();
    expect(body.ok).toBe(true);
    expect(typeof body.comms.email).toBe("boolean");
    expect(body.billing).toEqual({ configured: false, webhookConfigured: false, selfServe: false });
    expect(body.analytics).toEqual({ clientConfigured: false, serverEnabled: false });
    expect(body.migrationOperator).toEqual({ operatorConfigured: false });
  });

  it("goes non-green only when the DB probe fails — a configured provider never gates ok", async () => {
    probeDatabase.mockResolvedValue({ ok: false });
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const body = await (await GET()).json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("degraded");
    expect(body.billing.configured).toBe(true);
  });

  it("reflects configured env in the booleans without leaking any value", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_LEAKCHECK");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_LEAKCHECK");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_LEAKCHECK");
    vi.stubEnv("CREWFLOW_SUPERADMIN_EMAILS", "leakcheck@crewflow.uk");
    const body = await (await GET()).json();
    expect(body.billing).toEqual({ configured: true, webhookConfigured: true, selfServe: false });
    expect(body.analytics.clientConfigured).toBe(true);
    expect(body.migrationOperator.operatorConfigured).toBe(true);
    const raw = JSON.stringify(body);
    for (const secret of ["sk_test_LEAKCHECK", "whsec_LEAKCHECK", "phc_LEAKCHECK", "leakcheck@crewflow.uk"]) {
      expect(raw).not.toContain(secret);
    }
  });
});
