/**
 * P2B — time-budgeted, fairly-rotated driver for the HQ roster-workers tick.
 *
 * Pure logic, no I/O: the per-leg work (`run`) and the wall clock (`now`) are
 * INJECTED, so the budget / cursor / defer behaviour is deterministically
 * testable with fake durations and a fake clock — no wall-clock sleeps, no DB.
 * The route (app/api/cron/hq-roster-workers-tick/route.ts) supplies the real
 * `run` (enqueue → drain(1), wrapped in its best-effort `safe`) and `Date.now`.
 *
 * Why this exists: the roster tick ran ~15–17 worker legs strictly serially
 * under a 60s Vercel ceiling (p50 ≈ 57s, p95 ≈ 59.8s). When the ceiling was hit
 * the invocation was KILLED mid-leg — leaving the in-flight task leased (reaped
 * only after the 300s lease), writing NO cron_runs telemetry row (the tick went
 * invisible, not failed), and always truncating the SAME tail legs (the three
 * generative department legs sit late in the array). This driver stops starting
 * new legs once a wall-clock budget is reached and resumes from where it left
 * off next tick (persisted cursor), so the tick returns normally, records
 * telemetry, and no fixed tail is permanently starved on the successful path.
 *
 * It changes NOTHING about how a leg runs: a leg already started runs through
 * the existing engine path unchanged (atomic claim, 300s lease, reaper, governor,
 * lease-guarded completion, per-day/week enqueue dedupe). It only decides WHETHER
 * to START the next leg.
 */

/** Budget constants (ms). HARD_LIMIT mirrors the route's `maxDuration = 60`. */
export const ROSTER_BUDGET = {
  /** Vercel platform ceiling for the invocation (maxDuration = 60). */
  HARD_LIMIT_MS: 60_000,
  /** Stop STARTING new legs once elapsed reaches this. A started leg still runs. */
  STOP_CLAIMING_AT_MS: 35_000,
  /**
   * Reserve below the hard limit (= HARD_LIMIT − STOP_CLAIMING_AT). It must
   * exceed the worst-case SINGLE leg. The only HARD sub-bound is the generative
   * provider abort (DRAFT_TIMEOUT_MS = 10s); DB / governor / settlement work has
   * no hard per-leg timeout, so the worst leg (~12s) is OBSERVED, not guaranteed.
   * The reserve is ~2× that observed worst so timeout risk is low — but, because
   * there is no hard DB bound, NOT zero. A leg whose unbounded portion exceeds
   * this reserve could still cross the hard limit (documented residual risk).
   */
  RESERVED_HEADROOM_MS: 25_000,
} as const;

/**
 * Validate a persisted cursor read from a prior tick's `cron_runs.summary`.
 * Never trusts the JSON: returns 0 on no row / malformed summary / missing or
 * non-integer / out-of-range `next_index`.
 */
export function parseCursor(summary: unknown, workersLength: number): number {
  if (!Number.isInteger(workersLength) || workersLength <= 0) return 0;
  if (summary === null || typeof summary !== "object") return 0;
  const raw = (summary as Record<string, unknown>).next_index;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return 0;
  if (raw < 0 || raw >= workersLength) return 0;
  return raw;
}

/**
 * Advance the cursor by the number of legs ACTUALLY processed this tick (tiling).
 * `processed === 0` leaves the cursor unchanged (next_index === startIndex), so a
 * zero-progress tick never corrupts or skips the window.
 */
export function computeNextIndex(
  startIndex: number,
  processed: number,
  workersLength: number,
): number {
  if (!Number.isInteger(workersLength) || workersLength <= 0) return 0;
  return (startIndex + processed) % workersLength;
}

/** One roster leg as the driver sees it: a label and an injectable unit of work. */
export interface RosterWorkerLeg {
  label: string;
  /** Runs this leg's enqueue → drain(1) (already wrapped in the route's `safe`). */
  run: () => Promise<unknown>;
}

export interface RosterWindowResult {
  /** Outcome per leg ACTUALLY attempted this tick, keyed by label. */
  workers: Record<string, unknown>;
  /** Labels NOT reached because the budget was hit (in rotated order). */
  deferred: string[];
  /** Count of legs started this tick (= cursor advance). */
  processed: number;
  /** The cursor to persist for the next tick. */
  nextIndex: number;
}

/**
 * Drive the roster legs starting at `startIndex` (wrapping the array), stopping
 * BEFORE starting a new leg once `now() - start >= stopClaimingAtMs`. A leg that
 * has already started runs to completion. Deferred legs are neither enqueued nor
 * drained — they create no task this tick; a later tick reaching them (the cursor
 * advances past processed legs) runs their normal idempotent enqueue → drain(1).
 */
export async function runRosterWindow(opts: {
  workers: ReadonlyArray<RosterWorkerLeg>;
  startIndex: number;
  stopClaimingAtMs: number;
  now: () => number;
}): Promise<RosterWindowResult> {
  const { workers, startIndex, stopClaimingAtMs, now } = opts;
  const len = workers.length;
  if (len === 0) return { workers: {}, deferred: [], processed: 0, nextIndex: 0 };

  const started = now();
  const out: Record<string, unknown> = {};
  const deferred: string[] = [];
  let processed = 0;

  for (let i = 0; i < len; i++) {
    const worker = workers[(startIndex + i) % len]!;
    if (now() - started >= stopClaimingAtMs) {
      // Budget reached: defer this leg and ALL remaining, in rotated order.
      for (let j = i; j < len; j++) deferred.push(workers[(startIndex + j) % len]!.label);
      break;
    }
    // `processed` means ATTEMPTED: the leg ran to resolution, success OR failure.
    // The route's `run` is `safe(...)` so it never throws; this try/catch is a
    // defensive floor so a throwing leg can NEVER freeze cursor progress (one
    // broken worker must not starve the rest — best-effort isolation).
    try {
      out[worker.label] = await worker.run();
    } catch (e) {
      out[worker.label] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    processed++;
  }

  return {
    workers: out,
    deferred,
    processed,
    nextIndex: computeNextIndex(startIndex, processed, len),
  };
}
