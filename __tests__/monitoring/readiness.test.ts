import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  getMonitoringReadiness,
  monitoringEnabled,
} from "@/lib/monitoring/readiness";

/**
 * Error-monitoring readiness (P2 launch hardening). Pure env-driven predicates
 * that make the DARK state ("SDK in the build, no DSN ⇒ inert") LOUD instead of
 * a silent assumption. Tested behaviourally: no DSN ⇒ nothing initialises and
 * nothing reports; a DSN in a real environment ⇒ enabled; and the load-bearing
 * invariant that `enabled` can never be true without `sdkIntegrated`.
 *
 * The env is stubbed so no real DSN is ever read and no SDK is ever imported.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Clear every DSN + environment var this module reads, for a clean slate.
 * Deletes rather than blanks: `getMonitoringReadiness` uses `??`, so an empty
 * string would defeat the fallback chain (it is not nullish).
 */
function clearMonitoringEnv(): void {
  vi.stubEnv("SENTRY_DSN", undefined);
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", undefined);
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("NODE_ENV", undefined);
}

describe("monitoringEnabled — the shared 'will this runtime capture events?' predicate", () => {
  it("is a NO-OP (false) when no DSN is set — the dark-gating doctrine", () => {
    expect(monitoringEnabled({ dsn: undefined, env: "production" })).toBe(false);
    expect(monitoringEnabled({ dsn: "", env: "production" })).toBe(false);
    expect(monitoringEnabled({ dsn: "   ", env: "production" })).toBe(false);
  });

  it("is true with a DSN in a real (non-silent) environment", () => {
    expect(monitoringEnabled({ dsn: "https://k@o.ingest.sentry.io/1", env: "production" })).toBe(true);
    expect(monitoringEnabled({ dsn: "https://k@o.ingest.sentry.io/1", env: "preview" })).toBe(true);
  });

  it("stays dark in development and test even WITH a DSN (no dev noise, never send in tests)", () => {
    const dsn = "https://k@o.ingest.sentry.io/1";
    expect(monitoringEnabled({ dsn, env: "development" })).toBe(false);
    expect(monitoringEnabled({ dsn, env: "test" })).toBe(false);
    // case-insensitive on the environment name
    expect(monitoringEnabled({ dsn, env: "TEST" })).toBe(false);
  });
});

describe("getMonitoringReadiness — the /api/health monitoring line", () => {
  it("no DSN ⇒ dark: sdkIntegrated true, dsnConfigured false, enabled false", () => {
    clearMonitoringEnv();
    vi.stubEnv("NODE_ENV", "production");
    const r = getMonitoringReadiness();
    expect(r.sdkIntegrated).toBe(true);
    expect(r.dsnConfigured).toBe(false);
    expect(r.enabled).toBe(false);
  });

  it("server DSN in production ⇒ configured AND enabled", () => {
    clearMonitoringEnv();
    vi.stubEnv("SENTRY_DSN", "https://k@o.ingest.sentry.io/1");
    vi.stubEnv("VERCEL_ENV", "production");
    const r = getMonitoringReadiness();
    expect(r.dsnConfigured).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.environment).toBe("production");
  });

  it("falls back to the public DSN when the server DSN is unset", () => {
    clearMonitoringEnv();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://k@o.ingest.sentry.io/1");
    vi.stubEnv("VERCEL_ENV", "production");
    const r = getMonitoringReadiness();
    expect(r.dsnConfigured).toBe(true);
    expect(r.enabled).toBe(true);
  });

  it("a DSN in development stays dark (configured but not enabled)", () => {
    clearMonitoringEnv();
    vi.stubEnv("SENTRY_DSN", "https://k@o.ingest.sentry.io/1");
    vi.stubEnv("NODE_ENV", "development");
    const r = getMonitoringReadiness();
    expect(r.dsnConfigured).toBe(true);
    expect(r.enabled).toBe(false);
  });

  it("INVARIANT: enabled implies sdkIntegrated (no env var manufactures the capability)", () => {
    clearMonitoringEnv();
    vi.stubEnv("SENTRY_DSN", "https://k@o.ingest.sentry.io/1");
    vi.stubEnv("VERCEL_ENV", "production");
    const r = getMonitoringReadiness();
    if (r.enabled) expect(r.sdkIntegrated).toBe(true);
  });

  it("never leaks the DSN value nor an env-var name in its output (public endpoint)", () => {
    clearMonitoringEnv();
    const dsn = "https://SECRET_KEY@o.ingest.sentry.io/1";
    vi.stubEnv("SENTRY_DSN", dsn);
    vi.stubEnv("VERCEL_ENV", "production");
    const serialised = JSON.stringify(getMonitoringReadiness());
    expect(serialised).not.toContain("SECRET_KEY");
    expect(serialised).not.toContain(dsn);
    expect(serialised).not.toContain("SENTRY_DSN");
    expect(serialised).not.toContain("NEXT_PUBLIC_SENTRY_DSN");
  });
});

describe("SDK wiring drift guard — sdkIntegrated must track the real files", () => {
  it("the four SDK wiring files exist (delete one ⇒ sdkIntegrated must become a required false)", () => {
    const root = resolve(__dirname, "..", "..");
    for (const rel of [
      "instrumentation.ts",
      "sentry.server.config.ts",
      "sentry.client.config.ts",
      "sentry.edge.config.ts",
    ]) {
      expect(existsSync(resolve(root, rel)), `${rel} should exist`).toBe(true);
    }
    // Given all four exist, the constant must currently report integrated.
    expect(getMonitoringReadiness().sdkIntegrated).toBe(true);
  });
});
