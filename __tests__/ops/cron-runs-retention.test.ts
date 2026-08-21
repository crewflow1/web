import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CRON_RUNS_SUCCESS_RETENTION_DAYS,
  CRON_RUNS_FAILURE_RETENTION_DAYS,
  CRON_RUNS_PRUNE_MAX_ROWS,
} from "@/server/services/cron-runs-prune";

/**
 * cron_runs retention — the policy contract, pinned on source.
 *
 * The behavioural proof (what the SQL actually deletes, and that it refuses an
 * unsafe horizon) is the real-Postgres integration suite. This file pins the
 * boundaries that make the policy SAFE, so a later "let's keep less" edit cannot
 * quietly blind operations:
 *
 *   - ops-snapshot computes per-route health over a SEVEN-day lookback;
 *   - hq-monitoring-runner reports `insufficient` when it sees zero rows.
 *
 * Retention below that window doesn't save money, it removes the ability to tell
 * whether the crons are running at all.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** The window ops-snapshot reads. Derived from source, not restated as a literal. */
const OPS_LOOKBACK_DAYS = 7;

describe("cron_runs retention policy", () => {
  it("ops-snapshot still reads a seven-day window (the constraint this policy respects)", () => {
    const src = read("server/services/ops-snapshot.ts");
    expect(src).toMatch(/sevenDaysAgo/);
  });

  it("keeps successes strictly longer than the ops health window", () => {
    expect(CRON_RUNS_SUCCESS_RETENTION_DAYS).toBeGreaterThan(OPS_LOOKBACK_DAYS);
  });

  it("keeps failures at least as long as successes — a failure is the diagnostic record", () => {
    expect(CRON_RUNS_FAILURE_RETENTION_DAYS).toBeGreaterThanOrEqual(
      CRON_RUNS_SUCCESS_RETENTION_DAYS,
    );
  });

  it("bounds each invocation so a pass can never become a long blocking delete", () => {
    expect(CRON_RUNS_PRUNE_MAX_ROWS).toBeGreaterThan(0);
    expect(Number.isInteger(CRON_RUNS_PRUNE_MAX_ROWS)).toBe(true);
  });

  it("the migration enforces the floor in the DATABASE, not only in TypeScript", () => {
    const sql = read("supabase/migrations/20261213000000_cron_runs_retention.sql");
    // The guard must be a raised exception, not a comment or a clamp.
    expect(sql).toMatch(/p_success_days\s*<\s*8/);
    expect(sql).toMatch(/raise exception/i);
    // Service-role only: a SECURITY DEFINER delete must not be PostgREST-callable.
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/revoke all on function public\.prune_cron_runs[\s\S]*?anon, authenticated/i);
  });
});

describe("cron schedule contract (vercel.json)", () => {
  const crons = (
    JSON.parse(read("vercel.json")) as { crons: Array<{ path: string; schedule: string }> }
  ).crons;
  const scheduleFor = (path: string) => crons.find((c) => c.path === path)?.schedule;

  it("registers the retention pass on a daily schedule", () => {
    const s = scheduleFor("/api/cron/cron-runs-prune");
    expect(s).toBeDefined();
    // Daily: a fixed hour + fixed minute, not a repeating step.
    expect(s).toMatch(/^\d+ \d+ \* \* \*$/);
  });

  it("spine-backfill is no longer per-minute — it is a completed one-time replay", () => {
    expect(scheduleFor("/api/cron/spine-backfill")).not.toBe("* * * * *");
  });

  it("spine-DRAIN is untouched — the live delivery path stays per-minute", () => {
    expect(scheduleFor("/api/cron/spine-drain")).toBe("* * * * *");
  });

  it("every registered cron path has a route on disk", () => {
    for (const c of crons) {
      const rel = `app${c.path}/route.ts`;
      expect(() => read(rel), `${rel} missing for ${c.path}`).not.toThrow();
    }
  });
});

describe("dark-drain gates are checked BEFORE any database work", () => {
  for (const [route, predicate] of [
    ["push-drain", "isPushConfigured"],
    ["sms-drain", "isSmsConfigured"],
  ] as const) {
    it(`${route} returns 204 on the dark path before withCronTelemetry`, () => {
      const src = read(`app/api/cron/${route}/route.ts`);
      const gate = src.indexOf(`!${predicate}()`);
      const telemetry = src.indexOf("withCronTelemetry(");
      expect(gate, `${route}: ${predicate} gate not found`).toBeGreaterThan(-1);
      // Source ORDER is the proof: the gate must precede the first telemetry call.
      expect(gate).toBeLessThan(telemetry);
      expect(src).toMatch(/status:\s*204/);
    });
  }
});
