import { describe, it, expect, afterEach, vi } from "vitest";
import { probeDatabase } from "@/lib/health/db-probe";

/**
 * Live database reachability probe for `/api/health`. Behavioural unit tests: the probe must
 * translate a real Postgres roundtrip into `{ ok }` HONESTLY, and — because a readiness probe that
 * throws is worse than useless — it must NEVER reject, whatever the network does.
 *
 * `fetch` and the env are stubbed so no real request is ever made.
 */

/** The two already-public vars the probe needs to attempt a request at all. */
function stubConfigured(): void {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon_test_key");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("probeDatabase — honest live DB reachability", () => {
  it("(a) HTTP 200 ⇒ { ok: true } (the DB answered)", async () => {
    stubConfigured();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    await expect(probeDatabase()).resolves.toEqual({ ok: true });
  });

  it("a rejected anon key (401) is auth-degraded, NOT healthy (a valid key gets empty-200, never 401)", async () => {
    stubConfigured();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
    await expect(probeDatabase()).resolves.toEqual({ ok: false, reason: "auth" });
  });

  it("a non-5xx reachable status (404) still proves the gateway + DB answered", async () => {
    stubConfigured();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404 }));
    await expect(probeDatabase()).resolves.toEqual({ ok: true });
  });

  it("(b) HTTP 500 ⇒ { ok: false, reason: 'unreachable' }", async () => {
    stubConfigured();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 503 }));
    await expect(probeDatabase()).resolves.toEqual({ ok: false, reason: "unreachable" });
  });

  it("(c) fetch REJECTS (network/abort) ⇒ { ok: false } AND the promise does NOT reject", async () => {
    stubConfigured();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    // The load-bearing assertion: .resolves — a reachability probe must always answer.
    await expect(probeDatabase()).resolves.toEqual({ ok: false, reason: "unreachable" });
  });

  it("an aborted (timed-out) fetch also resolves to unreachable, never rejects", async () => {
    stubConfigured();
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
    await expect(probeDatabase()).resolves.toEqual({ ok: false, reason: "unreachable" });
  });

  it("(d) env unset ⇒ { ok: false, reason: 'unconfigured' } and never calls fetch", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(probeDatabase()).resolves.toEqual({ ok: false, reason: "unconfigured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
