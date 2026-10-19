import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bucketCronAgeMinutes,
  probeCronFreshness,
} from "@/lib/health/cron-freshness";

/**
 * Cron-freshness probe for `/api/health`. Behavioural unit tests + source pins.
 *
 * The contract mirrors db-probe's: the probe must NEVER reject, every failure
 * mode collapses to `{ ageMinutes: null }` ("unknown"), and the published
 * value is a BUCKETED integer — never a raw timestamp — because the endpoint
 * is public. `fetch` and the env are stubbed so no real request is ever made.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip TS/JS comments so pins test EXECUTABLE code, not prose about it. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function stubConfigured(): void {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service_test_key");
}

function fetchReturning(rows: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    status,
    json: () => Promise.resolve(rows),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bucketCronAgeMinutes — the only value that may be published", () => {
  it("floors to 5-minute buckets (privacy: no precise timing side-channel)", () => {
    expect(bucketCronAgeMinutes(0)).toBe(0);
    expect(bucketCronAgeMinutes(4 * 60_000)).toBe(0);
    expect(bucketCronAgeMinutes(5 * 60_000)).toBe(5);
    expect(bucketCronAgeMinutes(14 * 60_000)).toBe(10);
    expect(bucketCronAgeMinutes(47 * 60_000)).toBe(45);
  });

  it("caps at 1440 — anything older than a day reads the same", () => {
    expect(bucketCronAgeMinutes(3 * 24 * 60 * 60_000)).toBe(1440);
  });

  it("clock skew (future started_at) clamps to 0, never negative", () => {
    expect(bucketCronAgeMinutes(-90_000)).toBe(0);
  });

  it("garbage input collapses to 0, never NaN into the public payload", () => {
    expect(bucketCronAgeMinutes(Number.NaN)).toBe(0);
    // Non-finite is garbage, not "very old" — it collapses to 0 like NaN does.
    expect(bucketCronAgeMinutes(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("probeCronFreshness — honest, never-throwing, null-on-unknown", () => {
  it("reports the bucketed age of the last successful run", async () => {
    stubConfigured();
    const startedAt = new Date(Date.now() - 32 * 60_000).toISOString();
    vi.stubGlobal("fetch", fetchReturning([{ started_at: startedAt }]));
    await expect(probeCronFreshness()).resolves.toEqual({ ageMinutes: 30 });
  });

  it("queries ONLY ok=true runs on the indexed order (a firing-but-failing scheduler is also an incident)", async () => {
    stubConfigured();
    const spy = fetchReturning([{ started_at: new Date().toISOString() }]);
    vi.stubGlobal("fetch", spy);
    await probeCronFreshness();
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain("ok=eq.true");
    expect(url).toContain("order=started_at.desc");
    expect(url).toContain("limit=1");
    expect(url).toContain("select=started_at");
  });

  it("env unset ⇒ null and never calls fetch (local dev / preview)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(probeCronFreshness()).resolves.toEqual({ ageMinutes: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("non-200 ⇒ null (unknown, not stale)", async () => {
    stubConfigured();
    vi.stubGlobal("fetch", fetchReturning([], 500));
    await expect(probeCronFreshness()).resolves.toEqual({ ageMinutes: null });
  });

  it("empty result set ⇒ null", async () => {
    stubConfigured();
    vi.stubGlobal("fetch", fetchReturning([]));
    await expect(probeCronFreshness()).resolves.toEqual({ ageMinutes: null });
  });

  it("malformed row / unparseable timestamp ⇒ null", async () => {
    stubConfigured();
    vi.stubGlobal("fetch", fetchReturning([{ started_at: "not-a-date" }]));
    await expect(probeCronFreshness()).resolves.toEqual({ ageMinutes: null });
    vi.stubGlobal("fetch", fetchReturning([{ wrong: true }]));
    await expect(probeCronFreshness()).resolves.toEqual({ ageMinutes: null });
  });

  it("fetch REJECTS (network/abort) ⇒ resolves null, NEVER rejects", async () => {
    stubConfigured();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    // The load-bearing assertion: .resolves — a probe must always answer.
    await expect(probeCronFreshness()).resolves.toEqual({ ageMinutes: null });
  });
});

describe("source pins — the probe stays edge-safe and the route stays public-safe", () => {
  it("the probe module imports no SDK, no supabase lib, no server-only", () => {
    const src = codeOf(read("lib/health/cron-freshness.ts"));
    expect(src).not.toMatch(/server-only/);
    expect(src).not.toMatch(/from "@\/lib\/supabase/);
    expect(src).not.toMatch(/@supabase\//);
  });

  it("/api/health serialises ONLY the bucketed integer — and names no env var", () => {
    const route = codeOf(read("app/api/health/route.ts"));
    expect(route).toMatch(/probeCronFreshness/);
    expect(route).toMatch(/lastSuccessAgeMinutes: cron\.ageMinutes/);
    // The route file itself must never name the service key (the read lives in
    // the lib module, server-side only; the response carries just the bucket).
    expect(route).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(route).not.toMatch(/started_at/);
  });

  it("cron freshness does NOT gate ok/status — unknown or stale is the monitor's call, not an outage", () => {
    const route = codeOf(read("app/api/health/route.ts"));
    expect(route).toMatch(/ok: db\.ok/);
    expect(route).toMatch(/status: db\.ok \? "healthy" : "degraded"/);
    expect(route).not.toMatch(/ok:[^,\n]*cron/);
  });
});
