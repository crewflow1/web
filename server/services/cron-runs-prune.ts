import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Ops-telemetry retention — the service half of `prune_cron_runs`
 * (migration 20261213000000).
 *
 * `cron_runs` is operational telemetry, not a record of account: it powers the
 * /admin/ops "last successful job" tile and the recent-failures list, and
 * nothing else reads it. Left unpruned it was ~70% of the production database.
 *
 * The horizons live here as named constants rather than as bare call-site
 * numbers so the retention decision is reviewable in one place. The DATABASE
 * still enforces the floor (>= 8 days for successes) — these are the policy,
 * that is the guard rail.
 */

/**
 * Successful runs are kept for two full ops windows. `ops-snapshot` reads a
 * seven-day lookback, so 14 days means a pruning run can never race the health
 * tiles even if it slips a day.
 */
export const CRON_RUNS_SUCCESS_RETENTION_DAYS = 14;

/**
 * Failures — and rows whose outcome was never written, which is what a crashed
 * invocation leaves behind — are the diagnostic trail. Kept a full quarter so
 * "when did this route start failing?" stays answerable.
 */
export const CRON_RUNS_FAILURE_RETENTION_DAYS = 90;

/**
 * Ceiling per invocation. Steady state is ~12,000 rows/day, so 50,000 leaves
 * ample catch-up headroom while keeping every individual delete batch short
 * enough that the per-minute crons writing into the same table never queue
 * behind it.
 */
export const CRON_RUNS_PRUNE_MAX_ROWS = 50000;

export type CronRunsPruneResult = {
  ok: boolean;
  deleted_success: number;
  deleted_failure: number;
  success_retention_days: number;
  failure_retention_days: number;
  error?: string;
};

/** Run one bounded retention pass. Never throws — a failed prune is telemetry, not an outage. */
export async function pruneCronRuns(): Promise<CronRunsPruneResult> {
  const base = {
    success_retention_days: CRON_RUNS_SUCCESS_RETENTION_DAYS,
    failure_retention_days: CRON_RUNS_FAILURE_RETENTION_DAYS,
  };

  const admin = createAdminClient();
  const { data, error } = await (
    admin.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{
      data: Array<{ deleted_success: number; deleted_failure: number }> | null;
      error: { message: string } | null;
    }>
  )("prune_cron_runs", {
    p_success_days: CRON_RUNS_SUCCESS_RETENTION_DAYS,
    p_failure_days: CRON_RUNS_FAILURE_RETENTION_DAYS,
    p_max_rows: CRON_RUNS_PRUNE_MAX_ROWS,
  });

  if (error) {
    return { ok: false, deleted_success: 0, deleted_failure: 0, ...base, error: error.message };
  }

  const row = Array.isArray(data) ? data[0] : (data as unknown as { deleted_success: number; deleted_failure: number } | null);
  return {
    ok: true,
    deleted_success: Number(row?.deleted_success ?? 0),
    deleted_failure: Number(row?.deleted_failure ?? 0),
    ...base,
  };
}
