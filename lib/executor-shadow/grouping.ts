/**
 * CrewFlow HQ — executor-shadow observability grouping (Train 11).
 *
 * Pure by construction — NO `server-only`, NO I/O. The /admin/executor-shadow
 * page reads the durable shadow store (what the executor WOULD have done, had
 * execution been live) and this module folds those observations into the
 * per-employee / per-task-type summary the CEO's live-execution decision needs.
 *
 * Observation rows carry only a task_id; the employee and task type arrive as a
 * separate meta map (joined server-side from hq_ai_tasks / ai_employees). A row
 * whose task meta is missing is still SHOWN — grouped under "unknown" — because
 * an observability surface that silently drops rows is lying about the evidence.
 */

/** The shadow's own vocabulary — never an application status (Shadow Truthfulness Rule). */
export const SHADOW_OUTCOMES = ["planned", "refused", "error"] as const;
export type ShadowOutcome = (typeof SHADOW_OUTCOMES)[number];

export type ShadowObservationView = {
  id: number;
  outcome: ShadowOutcome;
  taskId: string;
  actionId: string;
  toolLabel: string | null;
  idempotencyKey: string | null;
  reason: string | null;
  detail: string;
  correlationId: string;
  observedAt: string;
};

/** Task meta joined server-side; keys are task ids. */
export type ShadowTaskMeta = {
  taskType: string;
  employeeName: string | null;
};

export const UNKNOWN_GROUP_LABEL = "unknown";

export type ShadowGroup = {
  /** Stable group identity: `${employee}·${taskType}`. */
  key: string;
  employeeName: string;
  taskType: string;
  total: number;
  outcomes: Record<ShadowOutcome, number>;
  /** ISO timestamp of the group's newest observation. */
  lastObservedAt: string;
};

export function zeroOutcomes(): Record<ShadowOutcome, number> {
  return { planned: 0, refused: 0, error: 0 };
}

/**
 * Fold observations into per-(employee, task type) groups. Input order does not
 * matter; output is busiest-first, ties broken alphabetically so the page is
 * deterministic. Total: unknown meta lands in the "unknown" group, and an
 * out-of-vocabulary outcome (impossible past the DB CHECK, but the fold stays
 * total anyway) counts toward the total without inventing a bucket.
 */
export function groupShadowObservations(
  rows: ReadonlyArray<ShadowObservationView>,
  metaByTaskId: ReadonlyMap<string, ShadowTaskMeta>,
): ShadowGroup[] {
  const groups = new Map<string, ShadowGroup>();
  for (const row of rows) {
    const meta = metaByTaskId.get(row.taskId);
    const employeeName = meta?.employeeName ?? UNKNOWN_GROUP_LABEL;
    const taskType = meta?.taskType ?? UNKNOWN_GROUP_LABEL;
    const key = `${employeeName}·${taskType}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        employeeName,
        taskType,
        total: 0,
        outcomes: zeroOutcomes(),
        lastObservedAt: row.observedAt,
      };
      groups.set(key, g);
    }
    g.total += 1;
    if (row.outcome in g.outcomes) g.outcomes[row.outcome] += 1;
    if (row.observedAt > g.lastObservedAt) g.lastObservedAt = row.observedAt;
  }
  return [...groups.values()].sort(
    (a, b) => b.total - a.total || a.key.localeCompare(b.key),
  );
}

/** Headline totals across every observation on the page. */
export function summarizeShadowOutcomes(
  rows: ReadonlyArray<ShadowObservationView>,
): Record<ShadowOutcome, number> {
  const totals = zeroOutcomes();
  for (const row of rows) {
    if (row.outcome in totals) totals[row.outcome] += 1;
  }
  return totals;
}
