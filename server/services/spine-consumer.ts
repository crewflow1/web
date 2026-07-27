import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The HQ Event Spine — offset-consumer service layer (Module 1, PR3).
 *
 * The atomic work (read a bounded batch, apply each event idempotently, advance
 * the offset in the SAME transaction, dead-letter a poison event) lives in the
 * SQL function `hq_drain_consumer` — supabase-js has no client-side
 * multi-statement transaction and per D1 we do not invent one. This module is the
 * thin TS surface the cron drives: it triggers a drain per registered consumer,
 * exposes replay + golden signals, and NEVER throws (a spine hiccup must not break
 * the cron run; the wrapper records the failure and moves on).
 *
 * Delivery is cron-only (CEO decision D2 — no LISTEN/NOTIFY): the Vercel
 * `spine-drain` cron is the single, guaranteed path. Latency is the cron interval;
 * correctness does not depend on any wakeup arriving.
 *
 * Everything here is a no-op until an operator flips `event_spine.consumer_enabled`
 * (the global kill-switch) AND a consumer is registered — so PR3 ships dark.
 */

// The spine RPCs aren't in the generated Supabase types; cast past the typed
// client exactly as event-spine.ts does for the PR1/PR2 primitives.
type Rpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function rpc(): Rpc {
  const admin = createAdminClient();
  return admin.rpc.bind(admin) as unknown as Rpc;
}

// --- Types -------------------------------------------------------------------

/** The JSON summary `hq_drain_consumer` returns. */
export type DrainSummary = {
  consumer: string;
  processed?: number;
  dead_lettered?: number;
  new_offset?: number;
  lag?: number;
  stopped?: string | null;
  /** Present when the drain did nothing: disabled / unregistered / locked. */
  skipped?: string;
};

export type DrainResult =
  | { ok: true; summary: DrainSummary }
  | { ok: false; consumer: string; error: string };

export type DrainAllResult = {
  ok: boolean;
  /** Whether the global consumer gate was on for this run. */
  enabled: boolean;
  results: DrainResult[];
};

export type GoldenSignals = {
  generated_at: string;
  max_event_id: number;
  throughput: { last_1m: number; last_1h: number; last_24h: number };
  consumers: {
    consumer: string;
    last_event_id: number;
    lag: number;
    updated_at: string;
  }[];
  dead_event_count: number;
  oldest_dead_event_at: string | null;
  retry_backlog: number;
};

// --- Registration ------------------------------------------------------------

/**
 * Register a consumer (idempotent). `startEventId` is the offset it begins at —
 * 0 (the default) replays the whole history; pass the current `max(id)` to begin
 * at "only new events". The drainer only touches REGISTERED consumers, so this is
 * how a projection (PR5's `timeline`) opts into the stream.
 */
export async function registerConsumer(
  consumer: string,
  startEventId = 0,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await rpc()("hq_consumer_register", {
      p_consumer: consumer,
      p_start_event_id: startEventId,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// --- Draining ----------------------------------------------------------------

/** Drain one consumer once. Never throws. */
export async function drainConsumer(
  consumer: string,
  opts: { maxEvents?: number; maxAttempts?: number } = {},
): Promise<DrainResult> {
  try {
    const { data, error } = await rpc()("hq_drain_consumer", {
      p_consumer: consumer,
      p_max_events: opts.maxEvents ?? 500,
      p_max_attempts: opts.maxAttempts ?? 5,
    });
    if (error || data == null) {
      return { ok: false, consumer, error: error?.message ?? "drain returned no summary" };
    }
    return { ok: true, summary: data as DrainSummary };
  } catch (e) {
    return { ok: false, consumer, error: e instanceof Error ? e.message : String(e) };
  }
}

type ConsumerRow = { consumer: string };

/**
 * Drain every REGISTERED consumer once — the cron's entry point. Short-circuits
 * (without reading the registry) when the global gate is off, so a dark spine is
 * a single cheap RPC. In prod no consumer is registered yet, so even with the
 * gate on this is a no-op until PR5 registers `timeline`.
 */
export async function drainRegisteredConsumers(
  opts: { maxEvents?: number; maxAttempts?: number } = {},
): Promise<DrainAllResult> {
  const enabled = await isConsumerEnabled();
  if (!enabled) return { ok: true, enabled: false, results: [] };

  const admin = createAdminClient();
  const consumers = admin.from("hq_event_consumers" as never) as unknown as {
    select: (
      columns: string,
    ) => Promise<{ data: ConsumerRow[] | null; error: { message: string } | null }>;
  };
  const { data, error } = await consumers.select("consumer");
  if (error) {
    return {
      ok: false,
      enabled: true,
      results: [{ ok: false, consumer: "*", error: error.message }],
    };
  }

  const results: DrainResult[] = [];
  for (const row of data ?? []) {
    results.push(await drainConsumer(row.consumer, opts));
  }
  return { ok: results.every((r) => r.ok), enabled: true, results };
}

// --- Replay ------------------------------------------------------------------

/**
 * Reset a consumer's offset (default 0 = replay from the beginning) and clear its
 * transient retry/dead rows beyond that point, so the next drain rebuilds a
 * deterministic read-model from history. For a from-scratch rebuild the caller
 * also drops the projection ("drop + replay"); a naturally-idempotent projection
 * simply re-converges.
 */
export async function replayConsumer(
  consumer: string,
  toEventId = 0,
): Promise<{ ok: boolean; summary?: Record<string, unknown>; error?: string }> {
  try {
    const { data, error } = await rpc()("hq_replay_consumer", {
      p_consumer: consumer,
      p_to_event_id: toEventId,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, summary: (data as Record<string, unknown>) ?? {} };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// --- Golden signals + gate ---------------------------------------------------

/** Read the spine's golden signals (throughput, per-consumer lag, dead count). */
export async function getSpineGoldenSignals(): Promise<GoldenSignals | null> {
  try {
    const { data, error } = await rpc()("hq_spine_golden_signals");
    if (error || data == null) {
      console.error("[spine-consumer] golden signals failed", { error: error?.message });
      return null;
    }
    return data as GoldenSignals;
  } catch (e) {
    console.error("[spine-consumer] golden signals threw", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** True iff the global consumer kill-switch is on. Fail-dark on any error. */
export async function isConsumerEnabled(): Promise<boolean> {
  try {
    const { data, error } = await rpc()("hq_spine_consumer_enabled");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}
