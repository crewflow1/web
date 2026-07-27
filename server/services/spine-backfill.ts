import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The HQ Event Spine — historical-backfill service layer (Module 1, PR4).
 *
 * The atomic work (capture a per-source ceiling, walk the next batch in
 * deterministic order, map each legacy row to a canonical event, emit it through
 * the (source, source_id) idempotency guard, and advance the cursor in the SAME
 * transaction) lives in the SQL function `hq_backfill_drain` — supabase-js has no
 * client-side multi-statement transaction and per D1 we do not invent one. This
 * module is the thin TS surface the cron drives: it triggers one drain per source,
 * exposes reset + status, and NEVER throws (a backfill hiccup must not break the
 * cron run; the wrapper records the failure and moves on).
 *
 * Delivery is cron-only (CEO decision D2 — no LISTEN/NOTIFY): the Vercel
 * `spine-backfill` cron is the single, guaranteed path. Each source is drained one
 * bounded batch per tick; the cron interval paces a multi-batch source to
 * completion. Correctness never depends on any wakeup arriving.
 *
 * Everything here is a no-op until an operator flips `event_spine.backfill_enabled`
 * (the global kill-switch) — so PR4 ships dark.
 */

// The spine RPCs aren't in the generated Supabase types; cast past the typed
// client exactly as the PR3 consumer service does.
type Rpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function rpc(): Rpc {
  const admin = createAdminClient();
  return admin.rpc.bind(admin) as unknown as Rpc;
}

/**
 * The three legacy logs PR4 replays, in a fixed deterministic order. This is the
 * canonical source list — it MUST match the static allow-list in
 * `hq_backfill_drain` (an unknown source is rejected there too).
 */
export const BACKFILL_SOURCES = [
  "activity_log",
  "admin_activity_log",
  "hq_memory_events",
] as const;

export type BackfillSource = (typeof BACKFILL_SOURCES)[number];

// --- Types -------------------------------------------------------------------

/** The JSON summary `hq_backfill_drain` returns. */
export type BackfillSummary = {
  source: string;
  status?: "idle" | "running" | "done";
  done?: boolean;
  processed?: number;
  emitted?: number;
  skipped?: number;
  cursor_id?: string;
  /** Present when the drain did nothing: backfill_disabled / unknown_source / locked. */
  skipped_reason?: string;
};

export type BackfillResult =
  | { ok: true; summary: BackfillSummary }
  | { ok: false; source: string; error: string };

export type BackfillRunResult = {
  ok: boolean;
  /** Whether the global backfill gate was on for this run. */
  enabled: boolean;
  results: BackfillResult[];
};

export type BackfillStatus = {
  generated_at: string;
  enabled: boolean;
  sources: {
    source: string;
    status: "idle" | "running" | "done";
    rows_seen: number;
    rows_emitted: number;
    rows_skipped: number;
    started_at: string | null;
    updated_at: string;
  }[];
};

// --- Gate --------------------------------------------------------------------

/** True iff the global backfill kill-switch is on. Fail-dark on any error. */
export async function isBackfillEnabled(): Promise<boolean> {
  try {
    const { data, error } = await rpc()("hq_spine_backfill_enabled");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

// --- Draining ----------------------------------------------------------------

/** Drain one source's next batch once. Never throws. */
export async function backfillSource(
  source: BackfillSource,
  opts: { maxRows?: number } = {},
): Promise<BackfillResult> {
  try {
    const { data, error } = await rpc()("hq_backfill_drain", {
      p_source: source,
      p_max_rows: opts.maxRows ?? 500,
    });
    if (error || data == null) {
      return { ok: false, source, error: error?.message ?? "backfill returned no summary" };
    }
    // `skipped` is a numeric counter in the summary; the no-op REASON (if any)
    // arrives under the `skipped` JSON key only when there is no counter — keep the
    // raw object and let callers read either shape.
    const raw = data as Record<string, unknown>;
    const summary: BackfillSummary = {
      source,
      status: raw.status as BackfillSummary["status"],
      done: raw.done as boolean | undefined,
      processed: raw.processed as number | undefined,
      emitted: raw.emitted as number | undefined,
      skipped: typeof raw.skipped === "number" ? raw.skipped : undefined,
      cursor_id: raw.cursor_id as string | undefined,
      skipped_reason: typeof raw.skipped === "string" ? raw.skipped : undefined,
    };
    return { ok: true, summary };
  } catch (e) {
    return { ok: false, source, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Drain every source once — the cron's entry point. Short-circuits (without
 * touching any source) when the global gate is off, so a dark spine is a single
 * cheap RPC. With the gate on it drains each of the three legacy logs one bounded
 * batch; the cron interval paces a large source to completion across ticks.
 */
export async function runBackfill(
  opts: { maxRows?: number } = {},
): Promise<BackfillRunResult> {
  const enabled = await isBackfillEnabled();
  if (!enabled) return { ok: true, enabled: false, results: [] };

  const results: BackfillResult[] = [];
  for (const source of BACKFILL_SOURCES) {
    results.push(await backfillSource(source, opts));
  }
  return { ok: results.every((r) => r.ok), enabled: true, results };
}

// --- Reset + status ----------------------------------------------------------

/**
 * Rewind a source to the beginning for a from-scratch redrive. Safe: the next
 * drain re-walks history but the (source, source_id) guard re-inserts nothing that
 * already exists, so the append-only spine is never duplicated.
 */
export async function resetBackfill(
  source: BackfillSource,
): Promise<{ ok: boolean; summary?: Record<string, unknown>; error?: string }> {
  try {
    const { data, error } = await rpc()("hq_backfill_reset", { p_source: source });
    if (error) return { ok: false, error: error.message };
    return { ok: true, summary: (data as Record<string, unknown>) ?? {} };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Read the backfill progress signal (gate + per-source cursor/status/counters). */
export async function getBackfillStatus(): Promise<BackfillStatus | null> {
  try {
    const { data, error } = await rpc()("hq_backfill_status");
    if (error || data == null) {
      console.error("[spine-backfill] status failed", { error: error?.message });
      return null;
    }
    return data as BackfillStatus;
  } catch (e) {
    console.error("[spine-backfill] status threw", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
