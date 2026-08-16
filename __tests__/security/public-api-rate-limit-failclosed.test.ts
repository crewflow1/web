import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * Public API v1 WRITE rate limiter — the durable, fail-CLOSED contract (MP R4).
 *
 * The read substrate's limiter fails OPEN by design (a fault must never black
 * out a read). The write surface flips that: a mutation must NOT slip through
 * unmetered when the durable store cannot be consulted. These pins prove the
 * two postures are real, not just documented:
 *
 *   1. checkPersistent(..., { failClosed:true }) REFUSES (allowed:false) when the
 *      rate_limit_hit RPC errors.
 *   2. checkPersistent(...) with no opts still ALLOWS (allowed:true) on the same
 *      fault — reads keep failing open.
 *   3. enforceIdentifiedStrict (the write path's entry point) returns a real 429
 *      Response when the durable store faults, in the production store mode.
 *
 * Hermetic: the admin client is mocked so its RPC deterministically errors.
 */

// A mock admin whose rate_limit_hit RPC always errors, exercising the catch path.
const erroringAdmin = {
  rpc: vi.fn(async () => ({ data: null, error: { message: "db down" } })),
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => erroringAdmin,
}));

const CFG = { limit: 120, windowSeconds: 60 };

let silence: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  erroringAdmin.rpc.mockClear();
  silence = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  silence.mockRestore();
  vi.unstubAllEnvs();
});

describe("checkPersistent — the fail posture depends on failClosed", () => {
  it("WRITES fail CLOSED: an RPC fault refuses the request", async () => {
    const { checkPersistent } = await import("@/lib/security/rate-limit");
    const r = await checkPersistent("api_v1", "key-w", CFG, { failClosed: true });
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(erroringAdmin.rpc).toHaveBeenCalledTimes(1);
  });

  it("READS fail OPEN: the SAME RPC fault admits the request", async () => {
    const { checkPersistent } = await import("@/lib/security/rate-limit");
    const r = await checkPersistent("api_v1", "key-r", CFG);
    expect(r.allowed).toBe(true);
    expect(erroringAdmin.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("enforceIdentifiedStrict — a store fault becomes a 429 (production mode)", () => {
  it("returns a 429 Response when the durable store cannot be consulted", async () => {
    // enforceIdentifiedStrict only reaches the durable store in production; in
    // dev/test it uses the in-memory counter (which never faults). Force the
    // durable path to prove the end-to-end fail-closed 429.
    vi.stubEnv("NODE_ENV", "production");
    const { enforceIdentifiedStrict } = await import("@/lib/security/rate-limit");
    const res = await enforceIdentifiedStrict("api_v1", "key-x", CFG);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    const body = (await res!.json()) as { ok: boolean; error: string };
    expect(body.error).toBe("rate_limited");
  });

  it("enforceIdentified (the READ path) admits on the same fault — no 429", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { enforceIdentified } = await import("@/lib/security/rate-limit");
    const res = await enforceIdentified("api_v1", "key-y", CFG);
    expect(res).toBeNull();
  });
});
