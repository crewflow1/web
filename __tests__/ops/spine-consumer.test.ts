import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit proof for the offset-consumer service layer (Module 1, PR3). Mocks the
 * admin client's RPC + table reads so we assert the argument mapping, the
 * dark-ship short-circuit, and the never-throw contract WITHOUT a database (the
 * real drain/replay/dead-letter behaviour is proven in the integration tier).
 */

const { rpcMock, fromMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), fromMock: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock, from: fromMock }),
}));

import {
  drainConsumer,
  drainRegisteredConsumers,
  registerConsumer,
  replayConsumer,
  getSpineGoldenSignals,
  isConsumerEnabled,
} from "@/server/services/spine-consumer";

/** Route rpc() responses by function name. */
function routeRpc(opts: {
  enabled?: boolean;
  drain?: Record<string, unknown>;
  golden?: Record<string, unknown> | null;
  goldenError?: string;
}): void {
  rpcMock.mockImplementation((fn: string, args?: Record<string, unknown>) => {
    if (fn === "hq_spine_consumer_enabled") {
      return Promise.resolve({ data: opts.enabled ?? false, error: null });
    }
    if (fn === "hq_drain_consumer") {
      return Promise.resolve({
        data: opts.drain ?? { consumer: args?.p_consumer, processed: 0 },
        error: null,
      });
    }
    if (fn === "hq_spine_golden_signals") {
      return Promise.resolve({
        data: opts.golden ?? null,
        error: opts.goldenError ? { message: opts.goldenError } : null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

/** Make from("hq_event_consumers").select("consumer") resolve to the given rows. */
function routeConsumers(rows: { consumer: string }[] | { error: string }): void {
  fromMock.mockImplementation(() => ({
    select: () =>
      Array.isArray(rows)
        ? Promise.resolve({ data: rows, error: null })
        : Promise.resolve({ data: null, error: { message: rows.error } }),
  }));
}

describe("spine-consumer service", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
  });

  it("drainConsumer maps the bounded-batch args and returns the summary", async () => {
    routeRpc({ drain: { consumer: "timeline", processed: 7, new_offset: 99 } });
    const res = await drainConsumer("timeline", { maxEvents: 250, maxAttempts: 3 });

    expect(res).toEqual({ ok: true, summary: { consumer: "timeline", processed: 7, new_offset: 99 } });
    const call = rpcMock.mock.calls.find((c) => c[0] === "hq_drain_consumer");
    expect(call?.[1]).toEqual({ p_consumer: "timeline", p_max_events: 250, p_max_attempts: 3 });
  });

  it("drainConsumer applies the default batch + attempt bounds", async () => {
    routeRpc({ drain: { consumer: "timeline" } });
    await drainConsumer("timeline");
    const call = rpcMock.mock.calls.find((c) => c[0] === "hq_drain_consumer");
    expect(call?.[1]).toMatchObject({ p_max_events: 500, p_max_attempts: 5 });
  });

  it("drainConsumer never throws — a rejected RPC becomes ok:false", async () => {
    rpcMock.mockRejectedValue(new Error("network down"));
    const res = await drainConsumer("timeline");
    expect(res).toEqual({ ok: false, consumer: "timeline", error: "network down" });
  });

  it("drainRegisteredConsumers SHORT-CIRCUITS when the gate is off (never reads the registry)", async () => {
    routeRpc({ enabled: false });
    const res = await drainRegisteredConsumers();
    expect(res).toEqual({ ok: true, enabled: false, results: [] });
    // Dark: the registry was never queried, and no drain was attempted.
    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock.mock.calls.some((c) => c[0] === "hq_drain_consumer")).toBe(false);
  });

  it("drainRegisteredConsumers drains EACH registered consumer when the gate is on", async () => {
    routeRpc({ enabled: true, drain: { consumer: "x", processed: 1 } });
    routeConsumers([{ consumer: "timeline" }, { consumer: "search" }]);

    const res = await drainRegisteredConsumers();
    expect(res.enabled).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(2);
    const drained = rpcMock.mock.calls
      .filter((c) => c[0] === "hq_drain_consumer")
      .map((c) => (c[1] as { p_consumer: string }).p_consumer);
    expect(drained).toEqual(["timeline", "search"]);
  });

  it("drainRegisteredConsumers reports a registry read error without throwing", async () => {
    routeRpc({ enabled: true });
    routeConsumers({ error: "rls denied" });
    const res = await drainRegisteredConsumers();
    expect(res.ok).toBe(false);
    expect(res.enabled).toBe(true);
    expect(res.results[0]).toMatchObject({ ok: false, error: "rls denied" });
  });

  it("registerConsumer maps the consumer + start offset", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const res = await registerConsumer("timeline", 1234);
    expect(res).toEqual({ ok: true });
    const call = rpcMock.mock.calls.find((c) => c[0] === "hq_consumer_register");
    expect(call?.[1]).toEqual({ p_consumer: "timeline", p_start_event_id: 1234 });
  });

  it("replayConsumer maps the rewind target (default 0)", async () => {
    rpcMock.mockResolvedValue({ data: { new_offset: 0 }, error: null });
    await replayConsumer("timeline");
    const call = rpcMock.mock.calls.find((c) => c[0] === "hq_replay_consumer");
    expect(call?.[1]).toEqual({ p_consumer: "timeline", p_to_event_id: 0 });
  });

  it("getSpineGoldenSignals returns the signals, or null on error (never throws)", async () => {
    routeRpc({ golden: { max_event_id: 42, dead_event_count: 0 } });
    expect(await getSpineGoldenSignals()).toMatchObject({ max_event_id: 42 });

    routeRpc({ golden: null, goldenError: "boom" });
    expect(await getSpineGoldenSignals()).toBeNull();
  });

  it("isConsumerEnabled is fail-dark — any error reads as OFF", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    expect(await isConsumerEnabled()).toBe(true);

    rpcMock.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await isConsumerEnabled()).toBe(false);

    rpcMock.mockRejectedValue(new Error("down"));
    expect(await isConsumerEnabled()).toBe(false);
  });
});
