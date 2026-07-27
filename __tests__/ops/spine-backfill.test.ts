import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit proof for the historical-backfill service layer (Module 1, PR4). Mocks the
 * admin client's RPC so we assert the argument mapping, the dark-ship short-circuit,
 * the summary parsing (numeric `skipped` counter vs string `skipped` reason), and the
 * never-throw contract WITHOUT a database (the real replay/idempotency/restartability
 * is proven in the integration tier against live Postgres).
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

import {
  BACKFILL_SOURCES,
  backfillSource,
  runBackfill,
  resetBackfill,
  getBackfillStatus,
  isBackfillEnabled,
} from "@/server/services/spine-backfill";

/** Route rpc() responses by function name (and, for the drainer, by source). */
function routeRpc(opts: {
  enabled?: boolean;
  drain?: (source: string) => Record<string, unknown>;
  drainError?: string;
  reset?: Record<string, unknown> | null;
  resetError?: string;
  status?: Record<string, unknown> | null;
  statusError?: string;
}): void {
  rpcMock.mockImplementation((fn: string, args?: Record<string, unknown>) => {
    if (fn === "hq_spine_backfill_enabled") {
      return Promise.resolve({ data: opts.enabled ?? false, error: null });
    }
    if (fn === "hq_backfill_drain") {
      const source = String(args?.p_source);
      return Promise.resolve({
        data: opts.drain ? opts.drain(source) : { source, status: "done", done: true },
        error: opts.drainError ? { message: opts.drainError } : null,
      });
    }
    if (fn === "hq_backfill_reset") {
      return Promise.resolve({
        data: opts.reset ?? { source: args?.p_source, reset: true },
        error: opts.resetError ? { message: opts.resetError } : null,
      });
    }
    if (fn === "hq_backfill_status") {
      return Promise.resolve({
        data: opts.status ?? null,
        error: opts.statusError ? { message: opts.statusError } : null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

describe("spine-backfill service", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("exposes the three legacy sources in a fixed, deterministic order", () => {
    expect(BACKFILL_SOURCES).toEqual([
      "activity_log",
      "admin_activity_log",
      "hq_memory_events",
    ]);
  });

  it("backfillSource maps the bounded-batch args and returns the parsed summary", async () => {
    routeRpc({
      drain: (source) => ({
        source,
        status: "running",
        done: false,
        processed: 7,
        emitted: 5,
        skipped: 2,
        cursor_id: "11111111-1111-1111-1111-111111111111",
      }),
    });
    const res = await backfillSource("activity_log", { maxRows: 250 });

    expect(res).toEqual({
      ok: true,
      summary: {
        source: "activity_log",
        status: "running",
        done: false,
        processed: 7,
        emitted: 5,
        skipped: 2,
        cursor_id: "11111111-1111-1111-1111-111111111111",
        skipped_reason: undefined,
      },
    });
    const call = rpcMock.mock.calls.find((c) => c[0] === "hq_backfill_drain");
    expect(call?.[1]).toEqual({ p_source: "activity_log", p_max_rows: 250 });
  });

  it("backfillSource applies the default batch bound (500)", async () => {
    routeRpc({ drain: (source) => ({ source, status: "done", done: true }) });
    await backfillSource("hq_memory_events");
    const call = rpcMock.mock.calls.find((c) => c[0] === "hq_backfill_drain");
    expect(call?.[1]).toMatchObject({ p_max_rows: 500 });
  });

  it("backfillSource reads a STRING `skipped` as a no-op reason, not a counter", async () => {
    // The drain returns { source, skipped: 'backfill_disabled' } as a no-op reason.
    routeRpc({ drain: (source) => ({ source, skipped: "backfill_disabled" }) });
    const res = await backfillSource("activity_log");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.summary.skipped_reason).toBe("backfill_disabled");
      expect(res.summary.skipped).toBeUndefined(); // never confused with a count
    }
  });

  it("backfillSource never throws — a rejected RPC becomes ok:false", async () => {
    rpcMock.mockRejectedValue(new Error("network down"));
    const res = await backfillSource("activity_log");
    expect(res).toEqual({ ok: false, source: "activity_log", error: "network down" });
  });

  it("backfillSource reports a missing summary as ok:false (no silent success)", async () => {
    routeRpc({ drain: () => null as unknown as Record<string, unknown> });
    const res = await backfillSource("admin_activity_log");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no summary/i);
  });

  it("runBackfill SHORT-CIRCUITS when the gate is off (never drains a single source)", async () => {
    routeRpc({ enabled: false });
    const res = await runBackfill();
    expect(res).toEqual({ ok: true, enabled: false, results: [] });
    // Dark: the gate was read, but NO drain was ever attempted.
    expect(rpcMock.mock.calls.some((c) => c[0] === "hq_backfill_drain")).toBe(false);
  });

  it("runBackfill drains EACH of the three sources once, in order, when the gate is on", async () => {
    routeRpc({ enabled: true, drain: (source) => ({ source, status: "done", done: true }) });
    const res = await runBackfill({ maxRows: 100 });

    expect(res.enabled).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(3);

    const drained = rpcMock.mock.calls
      .filter((c) => c[0] === "hq_backfill_drain")
      .map((c) => (c[1] as { p_source: string }).p_source);
    expect(drained).toEqual(["activity_log", "admin_activity_log", "hq_memory_events"]);
    // The per-source bound is threaded through.
    const everyBound = rpcMock.mock.calls
      .filter((c) => c[0] === "hq_backfill_drain")
      .every((c) => (c[1] as { p_max_rows: number }).p_max_rows === 100);
    expect(everyBound).toBe(true);
  });

  it("runBackfill is ok:false if ANY source drain fails (but still attempts all three)", async () => {
    routeRpc({ enabled: true, drainError: "boom" });
    const res = await runBackfill();
    expect(res.enabled).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.results).toHaveLength(3);
    expect(res.results.every((r) => !r.ok)).toBe(true);
  });

  it("resetBackfill maps the source and returns the rewind summary", async () => {
    routeRpc({ reset: { source: "activity_log", reset: true, previous_rows_seen: 9 } });
    const res = await resetBackfill("activity_log");
    expect(res.ok).toBe(true);
    expect(res.summary).toMatchObject({ reset: true, previous_rows_seen: 9 });
    const call = rpcMock.mock.calls.find((c) => c[0] === "hq_backfill_reset");
    expect(call?.[1]).toEqual({ p_source: "activity_log" });
  });

  it("resetBackfill never throws — an error becomes ok:false", async () => {
    routeRpc({ resetError: "rls denied" });
    const res = await resetBackfill("activity_log");
    expect(res).toEqual({ ok: false, error: "rls denied" });
  });

  it("getBackfillStatus returns the signal, or null on error (never throws)", async () => {
    routeRpc({ status: { generated_at: "t", enabled: true, sources: [] } });
    expect(await getBackfillStatus()).toMatchObject({ enabled: true, sources: [] });

    routeRpc({ status: null, statusError: "boom" });
    expect(await getBackfillStatus()).toBeNull();

    rpcMock.mockRejectedValue(new Error("down"));
    expect(await getBackfillStatus()).toBeNull();
  });

  it("isBackfillEnabled is fail-dark — any error reads as OFF", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    expect(await isBackfillEnabled()).toBe(true);

    rpcMock.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await isBackfillEnabled()).toBe(false);

    rpcMock.mockRejectedValue(new Error("down"));
    expect(await isBackfillEnabled()).toBe(false);
  });
});
