/**
 * CrewFlow HQ — QA AI CI-signal snapshot, pure compute (R092).
 *
 * The QA board (lib/hq/qa.ts) is honest but blind on CI: there is no CI-run
 * table in the schema, so its regression/browser pass-rate cards are
 * `insufficient` by construction. This module is the DARK leg that a GitHub
 * credential flip lights: the `qa_ci_snapshot` task runner
 * (server/services/hq-qa-ci-runner.ts) asks the DARK GitHub adapter for recent
 * workflow runs and folds them HERE into a deterministic snapshot. The task
 * result row IS the record — NO new tables, NO migrations.
 *
 * ── THE HONESTY DOCTRINE (mirrors lib/hq/qa.ts) ────────────────────────────
 *   • DARK IS A COMPLETION, NOT A FAILURE. While GITHUB_TOKEN + GITHUB_REPO
 *     are absent the adapter refuses before fetch and the snapshot completes
 *     with `dark: true`, the adapter's own reason, and `runs: null` — a stated
 *     absence, never a fabricated pass rate.
 *   • NO INVENTED RATES. `passRatePct` is exact arithmetic over CONCLUDED runs
 *     only (success ÷ concluded), and is `null` when nothing has concluded —
 *     an in-flight-only window has no pass rate to report.
 *   • DETERMINISTIC AND REPLAYABLE. `now` is injected; same rows + same `now`
 *     ⇒ same snapshot. Malformed entries are skipped, never guessed at.
 *
 * Server- AND client-safe: no Supabase, no fetch, no clock.
 */

import type { GithubWorkflowRun } from "@/lib/integrations/github/adapter";

/** The deterministic fold of one bounded workflow-run window. */
export type QaCiRunsSnapshot = {
  /** Well-formed runs in the fetched window (malformed entries are skipped). */
  total: number;
  /**
   * Count per GitHub conclusion (`success`, `failure`, `cancelled`, …).
   * Runs still executing (no conclusion yet) are counted under `in_progress`
   * so every run in `total` is accounted for exactly once.
   */
  byConclusion: Record<string, number>;
  /**
   * success ÷ concluded × 100 (1dp), over runs that HAVE a conclusion.
   * `null` when no run in the window has concluded — never a fabricated 0.
   */
  passRatePct: number | null;
  /**
   * Whole days the window spans (oldest parseable run start → `now`, rounded
   * up, minimum 1 when any run is dated). 0 when the window is empty or
   * undated. A description of the fetched page, not of all history.
   */
  windowDays: number;
};

/**
 * The task-result envelope — the ONLY record of a CI snapshot (no tables).
 * A `type` alias (not an interface) so it satisfies the Task Engine's
 * `TaskResult` (`Record<string, unknown>`) via the implicit index signature.
 */
export type QaCiSnapshotResult = {
  kind: "qa_ci_snapshot";
  /** True while the GitHub adapter refuses before fetch (no credentials). */
  dark: boolean;
  /** The adapter's stated refusal when dark; `null` when lit. */
  reason: string | null;
  /** The folded window when lit; `null` when dark — metrics are never invented. */
  runs: QaCiRunsSnapshot | null;
  summary: string;
  generatedAt: string;
  sources: string[];
};

/** Conclusion bucket for a run GitHub has not concluded yet. */
const IN_PROGRESS_KEY = "in_progress";

const DAY_MS = 86_400_000;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Structural guard — the fold trusts nothing. A well-formed run has a numeric
 * id and a string status; `conclusion` must be a string or null/absent.
 * Anything else is skipped (counted nowhere), never coerced into a metric.
 */
function isWellFormedRun(row: unknown): row is GithubWorkflowRun {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "number" || !Number.isFinite(r.id)) return false;
  if (typeof r.status !== "string") return false;
  if (!(r.conclusion == null || typeof r.conclusion === "string")) return false;
  if (!(r.createdAt == null || typeof r.createdAt === "string")) return false;
  return true;
}

/**
 * Fold a bounded workflow-run window into the deterministic snapshot.
 * Pure: same rows + same `now` ⇒ same output. Malformed entries are skipped.
 */
export function foldWorkflowRuns(
  rows: ReadonlyArray<unknown>,
  now: Date,
): QaCiRunsSnapshot {
  const byConclusion: Record<string, number> = {};
  let total = 0;
  let concluded = 0;
  let success = 0;
  let oldestMs: number | null = null;

  for (const row of rows) {
    if (!isWellFormedRun(row)) continue; // skipped, never guessed at
    total += 1;
    const key =
      typeof row.conclusion === "string" && row.conclusion.length > 0
        ? row.conclusion
        : IN_PROGRESS_KEY;
    byConclusion[key] = (byConclusion[key] ?? 0) + 1;
    if (key !== IN_PROGRESS_KEY) {
      concluded += 1;
      if (key === "success") success += 1;
    }
    if (row.createdAt) {
      const t = Date.parse(row.createdAt);
      if (!Number.isNaN(t) && (oldestMs == null || t < oldestMs)) oldestMs = t;
    }
  }

  const windowDays =
    oldestMs == null
      ? 0
      : Math.max(1, Math.ceil((now.getTime() - oldestMs) / DAY_MS));

  return {
    total,
    byConclusion,
    // A window with nothing concluded has NO pass rate — null, not 0-as-real.
    passRatePct: concluded > 0 ? round1((success / concluded) * 100) : null,
    windowDays,
  };
}

/**
 * The honest DARK completion: the adapter refused before fetch, so there are
 * no runs and no metrics are fabricated. `reason` is the adapter's own stated
 * refusal — activation (GITHUB_TOKEN + GITHUB_REPO) is the only switch.
 */
export function darkCiSnapshot(reason: string, now: Date): QaCiSnapshotResult {
  return {
    kind: "qa_ci_snapshot",
    dark: true,
    reason,
    runs: null,
    summary:
      "CI snapshot dark — the GitHub adapter is not configured, so no workflow runs were fetched and no pass rate is fabricated (awaiting GitHub credential).",
    generatedAt: now.toISOString(),
    sources: ["github:workflow_runs (dark — not configured)"],
  };
}

/** The lit completion — the fetched window folded, with its provenance stated. */
export function litCiSnapshot(
  rows: ReadonlyArray<unknown>,
  now: Date,
): QaCiSnapshotResult {
  const runs = foldWorkflowRuns(rows, now);
  const summary =
    runs.total === 0
      ? "CI snapshot: the repository reported no recent workflow runs."
      : runs.passRatePct == null
        ? `CI snapshot: ${runs.total} recent workflow runs, none concluded yet — no pass rate is reported.`
        : `CI snapshot: ${runs.total} recent workflow runs over ~${runs.windowDays}d; ${runs.passRatePct}% of concluded runs succeeded.`;
  return {
    kind: "qa_ci_snapshot",
    dark: false,
    reason: null,
    runs,
    summary,
    generatedAt: now.toISOString(),
    sources: ["github:workflow_runs"],
  };
}
