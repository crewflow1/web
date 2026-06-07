import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Rate limiter — both the in-memory path (existing, sync) and the durable
 * Postgres-backed path added for launch (shared across serverless instances
 * via the `rate_limit_hit` RPC).
 *
 * The load-bearing guarantees pinned here:
 *   - the in-memory limiter still blocks within a window;
 *   - `consume()` does NOT touch the DB outside production (so dev/preview/test
 *     stay self-contained);
 *   - the persistent path honours the RPC verdict; and crucially
 *   - it ALWAYS fails OPEN on any RPC error/throw/empty result, so a fault in
 *     the limiter can never lock users out of auth/login.
 */

// Hoisted so the (also-hoisted) vi.mock factory can close over it.
const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

import {
  check,
  checkPersistent,
  consume,
  enforce,
  enforcePersistent,
  identifyHeaders,
  identifyRequest,
  DEFAULT_LIMITS,
  _resetForTests,
  type RateLimitConfig,
} from "@/lib/security/rate-limit";

const CFG: RateLimitConfig = { limit: 3, windowSeconds: 60 };

function isoInFuture(sec: number): string {
  return new Date(Date.now() + sec * 1000).toISOString();
}

beforeEach(() => {
  _resetForTests();
  rpcMock.mockReset();
});

describe("in-memory limiter (check / consume outside production)", () => {
  it("allows up to the limit then blocks within the window", () => {
    const r1 = check("t", "ip1", CFG);
    const r2 = check("t", "ip1", CFG);
    const r3 = check("t", "ip1", CFG);
    const r4 = check("t", "ip1", CFG);
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
  });

  it("keys are independent per identifier", () => {
    check("t", "ipA", CFG);
    check("t", "ipA", CFG);
    check("t", "ipA", CFG);
    expect(check("t", "ipA", CFG).allowed).toBe(false);
    // A different IP starts a fresh window.
    expect(check("t", "ipB", CFG).allowed).toBe(true);
  });

  it("consume() uses the in-memory store at NODE_ENV=test and never calls the DB RPC", async () => {
    const a = await consume("t", "ip", CFG);
    const b = await consume("t", "ip", CFG);
    const c = await consume("t", "ip", CFG);
    const d = await consume("t", "ip", CFG);
    expect([a.allowed, b.allowed, c.allowed, d.allowed]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("persistent limiter (checkPersistent → rate_limit_hit RPC)", () => {
  it("honours an 'allowed' verdict and forwards the right RPC args", async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ allowed: true, remaining: 4, reset_at: isoInFuture(60) }],
      error: null,
    });
    const r = await checkPersistent("auth", "user@x.com", DEFAULT_LIMITS.auth);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
    expect(rpcMock).toHaveBeenCalledWith("rate_limit_hit", {
      p_key: "auth:user@x.com",
      p_limit: DEFAULT_LIMITS.auth.limit,
      p_window_seconds: DEFAULT_LIMITS.auth.windowSeconds,
    });
  });

  it("honours a 'blocked' verdict", async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ allowed: false, remaining: 0, reset_at: isoInFuture(60) }],
      error: null,
    });
    const r = await checkPersistent("auth", "user@x.com", DEFAULT_LIMITS.auth);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it("FAILS OPEN when the RPC returns an error", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const r = await checkPersistent("auth", "user@x.com", DEFAULT_LIMITS.auth);
    expect(r.allowed).toBe(true);
  });

  it("FAILS OPEN when the RPC throws", async () => {
    rpcMock.mockRejectedValueOnce(new Error("network exploded"));
    const r = await checkPersistent("auth", "user@x.com", DEFAULT_LIMITS.auth);
    expect(r.allowed).toBe(true);
  });

  it("FAILS OPEN when the RPC returns an empty result set", async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });
    const r = await checkPersistent("auth", "user@x.com", DEFAULT_LIMITS.auth);
    expect(r.allowed).toBe(true);
  });
});

describe("enforce / enforcePersistent (route-handler 429)", () => {
  function req(ip = "1.2.3.4"): Request {
    return new Request("https://crewflow.uk/api/waitlist", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
    });
  }

  it("enforce() returns null until the limit, then a 429 with retry-after", () => {
    const cfg: RateLimitConfig = { limit: 2, windowSeconds: 60 };
    expect(enforce(req(), "x", cfg)).toBeNull();
    expect(enforce(req(), "x", cfg)).toBeNull();
    const blocked = enforce(req(), "x", cfg);
    expect(blocked).toBeInstanceOf(Response);
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers.get("retry-after")).toBeTruthy();
  });

  it("enforcePersistent() emits a 429 when the (non-prod, in-memory) store blocks", async () => {
    const cfg: RateLimitConfig = { limit: 1, windowSeconds: 60 };
    expect(await enforcePersistent(req("9.9.9.9"), "y", cfg)).toBeNull();
    const blocked = await enforcePersistent(req("9.9.9.9"), "y", cfg);
    expect(blocked).toBeInstanceOf(Response);
    expect(blocked!.status).toBe(429);
  });
});

describe("identifier extraction", () => {
  it("identifyRequest prefers the first x-forwarded-for entry", () => {
    const r = new Request("https://x", {
      headers: { "x-forwarded-for": "5.5.5.5, 6.6.6.6" },
    });
    expect(identifyRequest(r)).toBe("5.5.5.5");
  });

  it("identifyHeaders mirrors it for the server-action context", () => {
    const h = new Headers({ "x-forwarded-for": "7.7.7.7, 8.8.8.8" });
    expect(identifyHeaders(h)).toBe("7.7.7.7");
  });

  it("falls back to 'anonymous' when no IP headers are present", () => {
    expect(identifyHeaders(new Headers())).toBe("anonymous");
  });
});
