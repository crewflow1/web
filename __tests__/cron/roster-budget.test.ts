import { describe, it, expect } from "vitest";
import {
  ROSTER_BUDGET,
  parseCursor,
  computeNextIndex,
  runRosterWindow,
  type RosterWorkerLeg,
} from "@/lib/cron/roster-budget";

/**
 * P2B — deterministic tests for the time-budgeted, cursor-rotated roster driver.
 *
 * All timing is a FAKE injected clock; each fake leg advances it by an injected
 * duration. No wall-clock sleeps. The real engine (atomic claim, lease, reaper,
 * governor, enqueue dedupe, lease-guarded completion) is out of scope here and
 * covered by its own suites — this proves ONLY the budget / cursor / defer logic.
 */

const LEN = 17; // the production WORKERS length (3 generative legs at 12/13/14)
const STOP: number = ROSTER_BUDGET.STOP_CLAIMING_AT_MS; // 35_000

/** A fake world: an injectable clock + legs whose `run` advances it. */
function makeWorld(durationsMs: number[]) {
  const clock = { t: 0 };
  const now = () => clock.t;
  const starts: Record<string, number> = {};
  const runCount: Record<string, number> = {};
  const runLog: string[] = [];
  const workers: RosterWorkerLeg[] = durationsMs.map((d, i) => {
    const label = `w${i}`;
    return {
      label,
      run: async () => {
        starts[label] = clock.t; // when this leg STARTED
        runCount[label] = (runCount[label] ?? 0) + 1;
        runLog.push(label);
        clock.t += d; // the leg consumes `d` ms of budget
        return { ok: true, i };
      },
    };
  });
  return { clock, now, starts, runCount, runLog, workers };
}

/** Run one window from `startIndex` over `durationsMs`. */
async function oneTick(durationsMs: number[], startIndex: number, stop = STOP) {
  const w = makeWorld(durationsMs);
  const res = await runRosterWindow({
    workers: w.workers,
    startIndex,
    stopClaimingAtMs: stop,
    now: w.now,
  });
  return { ...res, starts: w.starts, runCount: w.runCount, runLog: w.runLog };
}

/**
 * Simulate N consecutive ticks persisting the cursor exactly as production does:
 * the returned `next_index` is written into `cron_runs.summary` and read back by
 * `parseCursor` next tick.
 */
async function simulate(durationsMs: number[], nTicks: number, stop = STOP) {
  let summary: unknown = null; // no prior telemetry row
  const covered = new Set<string>();
  const ticks: Array<Awaited<ReturnType<typeof oneTick>> & { startIndex: number }> = [];
  for (let t = 0; t < nTicks; t++) {
    const startIndex = parseCursor(summary, durationsMs.length);
    const res = await oneTick(durationsMs, startIndex, stop);
    res.runLog.forEach((l) => covered.add(l));
    ticks.push({ ...res, startIndex });
    summary = { next_index: res.nextIndex }; // what withCronTelemetry persists
  }
  return { covered, ticks };
}

const allDet = (d = 2000) => Array.from({ length: LEN }, () => d);
/** Production shape: deterministic legs + 3 generative legs at 12/13/14. */
function prodShape(det = 2000, gen = 11000) {
  const d = allDet(det);
  d[12] = gen;
  d[13] = gen;
  d[14] = gen;
  return d;
}

describe("parseCursor — never trusts persisted JSON", () => {
  it("defaults to 0 with no prior row", () => expect(parseCursor(null, LEN)).toBe(0));
  it("defaults to 0 for a non-object", () => expect(parseCursor(42, LEN)).toBe(0));
  it("defaults to 0 when field missing", () => expect(parseCursor({}, LEN)).toBe(0));
  it("defaults to 0 for a non-integer", () =>
    expect(parseCursor({ next_index: "5" }, LEN)).toBe(0));
  it("defaults to 0 for a float", () => expect(parseCursor({ next_index: 2.5 }, LEN)).toBe(0));
  it("defaults to 0 below range", () => expect(parseCursor({ next_index: -1 }, LEN)).toBe(0));
  it("defaults to 0 at/above range", () => expect(parseCursor({ next_index: LEN }, LEN)).toBe(0));
  it("accepts a valid in-range index", () => expect(parseCursor({ next_index: 13 }, LEN)).toBe(13));
  it("defaults to 0 for a zero-length roster", () =>
    expect(parseCursor({ next_index: 0 }, 0)).toBe(0));
});

describe("computeNextIndex — tiling / wrap / zero-progress", () => {
  it("advances by processed count", () => expect(computeNextIndex(0, 13, LEN)).toBe(13));
  it("wraps around the array", () => expect(computeNextIndex(13, 9, LEN)).toBe(5));
  it("leaves the cursor unchanged when nothing processed", () =>
    expect(computeNextIndex(5, 0, LEN)).toBe(5));
  it("returns to start on a full pass", () => expect(computeNextIndex(0, LEN, LEN)).toBe(0));
});

describe("time budget", () => {
  it("stops starting new legs once the threshold is reached; already-started legs ran", async () => {
    // 12 det (2s) = 24s, then leg12 (11s) starts at 24s<35s → runs to 35s,
    // then leg13 would start at 35s → deferred.
    const res = await oneTick(prodShape(), 0);
    expect(res.processed).toBe(13); // legs 0..12
    expect(Object.keys(res.workers)).toHaveLength(13);
    expect(res.deferred).toEqual(["w13", "w14", "w15", "w16"]);
    expect(res.nextIndex).toBe(13);
  });

  it("every STARTED leg began strictly before STOP_CLAIMING_AT (timeout-safety model)", async () => {
    // Note: this bounds when legs START, not total route time — no hard DB bound exists.
    for (const start of [0, 12, 13, 16]) {
      const res = await oneTick(prodShape(), start);
      for (const label of Object.keys(res.workers)) {
        expect(res.starts[label]).toBeLessThan(STOP);
      }
    }
  });

  it("zero processed when the budget is already exhausted → cursor unchanged", async () => {
    const res = await oneTick(prodShape(), 5, /* stop */ 0);
    expect(res.processed).toBe(0);
    expect(res.nextIndex).toBe(5); // unchanged
    expect(Object.keys(res.workers)).toHaveLength(0);
    expect(res.deferred).toHaveLength(LEN);
  });

  it("processes the whole roster in one tick when it fits", async () => {
    const res = await oneTick(allDet(1000), 0); // 17×1s = 17s < 35s
    expect(res.processed).toBe(LEN);
    expect(res.deferred).toHaveLength(0);
    expect(res.nextIndex).toBe(0); // full wrap
  });
});

describe("defer semantics", () => {
  it("a deferred worker is NOT run this tick, and runs when a later tick reaches it", async () => {
    // Tick 1 from 0 defers w13..w16 (never invoked).
    const t1 = await oneTick(prodShape(), 0);
    expect(t1.runCount["w13"]).toBeUndefined();
    expect(t1.runCount["w16"]).toBeUndefined();

    // Tick 2 resumes from the persisted cursor (13) and DOES run them.
    const start2 = parseCursor({ next_index: t1.nextIndex }, LEN);
    expect(start2).toBe(13);
    const t2 = await oneTick(prodShape(), start2);
    expect(t2.runLog).toContain("w13");
    expect(t2.runLog).toContain("w16");
    // No leg runs twice within a single tick (double-complete safety across ticks
    // is the engine's via atomic claim + dedupe, not the driver's).
    for (const c of Object.values(t2.runCount)) expect(c).toBe(1);
  });
});

describe("structural fairness guarantee (genuinely guaranteed)", () => {
  it("cursor tiles monotonically — a successful tick resumes where the last stopped, never resets to 0", async () => {
    const { ticks } = await simulate(prodShape(), 4);
    for (let i = 1; i < ticks.length; i++) {
      // Each tick starts exactly at the previous tick's nextIndex.
      expect(ticks[i]!.startIndex).toBe(ticks[i - 1]!.nextIndex);
      // With ≥1 completion, the window advances (no fixed tail stuck at 0).
      expect(ticks[i - 1]!.processed).toBeGreaterThan(0);
    }
  });
});

describe("modeled fairness / coverage (MODELED — not a hard invariant)", () => {
  it("covers all 17 workers within 3 ticks under modeled p95 timings (det≤4s, gen≤12s at 12/13/14)", async () => {
    const { covered } = await simulate(prodShape(/* det */ 4000, /* gen */ 12000), 3);
    expect(covered.size).toBe(LEN); // modeled expectation, not guaranteed
  });

  it("typically covers all 17 within 2 ticks under observed timings (det 2s, gen 11s)", async () => {
    const { covered } = await simulate(prodShape(), 2);
    expect(covered.size).toBe(LEN);
  });
});

describe("adversarial expensive-leg placement", () => {
  it("expensive legs at the front still tile and cover fully", async () => {
    const d = allDet(2000);
    d[0] = 12000;
    d[1] = 12000;
    d[2] = 12000;
    const { covered, ticks } = await simulate(d, 4);
    expect(covered.size).toBe(LEN);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.startIndex).toBe(ticks[i - 1]!.nextIndex);
    }
  });

  it("expensive legs straddling the wrap boundary (15/16/0) still tile and cover fully", async () => {
    const d = allDet(2000);
    d[15] = 12000;
    d[16] = 12000;
    d[0] = 12000;
    const { covered } = await simulate(d, 4);
    expect(covered.size).toBe(LEN);
  });

  it("over many ticks no worker is permanently starved (max gap bounded)", async () => {
    const nTicks = 24;
    const { ticks } = await simulate(prodShape(4000, 12000), nTicks);
    const lastSeen: Record<string, number> = {};
    let maxGap = 0;
    for (let t = 0; t < nTicks; t++) {
      for (const label of ticks[t]!.runLog) {
        if (lastSeen[label] !== undefined) maxGap = Math.max(maxGap, t - lastSeen[label]!);
        lastSeen[label] = t;
      }
    }
    // Every worker executed at least once, and recurs with a bounded gap.
    expect(Object.keys(lastSeen)).toHaveLength(LEN);
    expect(maxGap).toBeLessThanOrEqual(3); // modeled; structural guarantee is ≤ LEN
  });
});

describe("failure + retry behaviour (advance-past-failure policy)", () => {
  it("a leg whose run THROWS (enqueue/drain throw) is still counted; the cursor advances; later legs still run", async () => {
    const clock = { t: 0 };
    const now = () => clock.t;
    const workers: RosterWorkerLeg[] = [
      { label: "a", run: async () => ((clock.t += 1000), { ok: true }) },
      {
        label: "b",
        run: async () => {
          clock.t += 1000;
          throw new Error("enqueue boom");
        },
      },
      { label: "c", run: async () => ((clock.t += 1000), { ok: true }) },
    ];
    const res = await runRosterWindow({ workers, startIndex: 0, stopClaimingAtMs: STOP, now });
    expect(res.processed).toBe(3); // b counted despite throwing
    expect(res.nextIndex).toBe(0); // advanced a full pass (3 of 3)
    expect((res.workers["b"] as { ok: boolean }).ok).toBe(false); // captured as failure
    expect(res.workers["c"]).toBeDefined(); // healthy leg AFTER the failure still ran
    expect(res.deferred).toHaveLength(0);
  });

  it("a leg whose run RESOLVES failed (retryable task failure, no throw) is counted and advanced", async () => {
    const clock = { t: 0 };
    const now = () => clock.t;
    const workers: RosterWorkerLeg[] = [
      {
        label: "a",
        run: async () => ((clock.t += 1000), { ok: false, status: "failed", retried: true }),
      },
      { label: "b", run: async () => ((clock.t += 1000), { ok: true }) },
    ];
    const res = await runRosterWindow({ workers, startIndex: 0, stopClaimingAtMs: STOP, now });
    expect(res.processed).toBe(2);
    expect(res.nextIndex).toBe(0);
    expect(res.workers["b"]).toBeDefined();
  });

  it("one PERMANENTLY failing worker never freezes the cursor; every worker keeps getting opportunities", async () => {
    const BROKEN = 4; // a deterministic leg that always throws
    let summary: unknown = null;
    const coverageCount: Record<number, number> = {};
    const nTicks = 10;
    for (let t = 0; t < nTicks; t++) {
      const clock = { t: 0 };
      const now = () => clock.t;
      const d = prodShape(); // budget pressure: ~13 legs/tick, so rotation matters
      const workers: RosterWorkerLeg[] = Array.from({ length: LEN }, (_, i) => ({
        label: `w${i}`,
        run: async () => {
          clock.t += d[i]!;
          coverageCount[i] = (coverageCount[i] ?? 0) + 1;
          if (i === BROKEN) throw new Error("permanent failure");
          return { ok: true };
        },
      }));
      const startIndex = parseCursor(summary, LEN);
      const res = await runRosterWindow({ workers, startIndex, stopClaimingAtMs: STOP, now });
      expect(res.processed).toBeGreaterThan(0); // cursor NEVER frozen on the broken worker
      summary = { next_index: res.nextIndex };
    }
    // Every worker — including the broken one (its retry opportunity) — was
    // reached; the broken worker did NOT starve any of the healthy workers.
    for (let i = 0; i < LEN; i++) expect(coverageCount[i] ?? 0).toBeGreaterThan(0);
    expect(coverageCount[BROKEN]).toBeGreaterThan(0);
  });
});

describe("telemetry round-trip (what withCronTelemetry persists and the next tick reads)", () => {
  it("a deferring tick's result carries next_index that parseCursor reads back", async () => {
    const t1 = await oneTick(prodShape(), 0);
    // Simulate withCronTelemetry writing `summary: payload` (the returned object).
    const persistedSummary = {
      ok: true,
      workers: t1.workers,
      deferred: t1.deferred,
      next_index: t1.nextIndex,
      cursor: { from: 0, next: t1.nextIndex, processed: t1.processed },
    };
    expect(parseCursor(persistedSummary, LEN)).toBe(t1.nextIndex);
    expect(persistedSummary.deferred.length).toBeGreaterThan(0); // planned deferral present
    expect(persistedSummary.ok).toBe(true); // deferral is NOT a failure
  });
});
