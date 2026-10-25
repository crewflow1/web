import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Accounting-health probe (PR #902): proves the system can SURFACE incomplete
 * accounting (reservations past TTL without a confirmed settlement) rather than
 * silently pretending telemetry is complete.
 */

const { state } = vi.hoisted(() => ({
  state: {
    count: { count: 0 as number | null, error: null as { message: string } | null },
    limit: { data: [] as Array<{ created_at: string }> | null, error: null as { message: string } | null },
  },
}));

vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.lt = () => chain;
  chain.order = () => chain;
  chain.limit = () => Promise.resolve(state.limit);
  // thenable → resolves to the count result for the head-count query
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(state.count).then(res);
  return { createAdminClient: () => ({ from: () => chain }) };
});

beforeEach(() => {
  state.count = { count: 0, error: null };
  state.limit = { data: [], error: null };
});

describe("readAccountingHealth", () => {
  it("healthy when no reservation is past TTL unsettled", async () => {
    state.count = { count: 0, error: null };
    const { readAccountingHealth } = await import("@/server/services/ai-cost-report");
    const h = await readAccountingHealth();
    expect(h).toEqual({ degraded: false, stuckReservations: 0, oldestStuckMinutes: null });
  });

  it("DEGRADED when reservations are stuck past TTL (with oldest age)", async () => {
    const fortyMinAgo = new Date(Date.now() - 40 * 60000).toISOString();
    state.count = { count: 2, error: null };
    state.limit = { data: [{ created_at: fortyMinAgo }], error: null };
    const { readAccountingHealth } = await import("@/server/services/ai-cost-report");
    const h = await readAccountingHealth();
    expect(h.degraded).toBe(true);
    expect(h.stuckReservations).toBe(2);
    expect(h.oldestStuckMinutes).toBeGreaterThanOrEqual(39);
    expect(h.oldestStuckMinutes).toBeLessThanOrEqual(41);
  });

  it("throws loud on a read error (an unreadable probe is itself degraded)", async () => {
    state.count = { count: null, error: { message: "db down" } };
    const { readAccountingHealth } = await import("@/server/services/ai-cost-report");
    await expect(readAccountingHealth()).rejects.toThrow(/accounting-health count failed: db down/);
  });
});
