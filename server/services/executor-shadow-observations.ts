import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  groupShadowObservations,
  summarizeShadowOutcomes,
  type ShadowGroup,
  type ShadowObservationView,
  type ShadowOutcome,
  type ShadowTaskMeta,
} from "@/lib/executor-shadow/grouping";

/**
 * CrewFlow HQ — executor-shadow observability, the READ side (Train 11).
 *
 * R2 (server/services/executor-shadow.ts) gave shadow observations a durable,
 * append-only home and deliberately stayed WRITE-ONLY. This module is its
 * read-only counterpart: it SELECTs `hq_ai_executor_shadow_observations` (plus
 * the task/employee meta that makes rows legible) for /admin/executor-shadow —
 * the evidence base for the CEO's live-execution decision.
 *
 * READ-ONLY BY CONSTRUCTION: this module issues nothing but `.select()` — never
 * insert/update/delete, never the write RPC. The table's append-only triggers
 * would refuse a mutation anyway (even under service-role); this module simply
 * never asks. Reads are LOUD: a failed select throws via readFailure rather than
 * degrading to an empty page that misreports the evidence.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

type ObservationRow = {
  id: number;
  outcome: ShadowOutcome;
  source: string;
  correlation_id: string;
  task_id: string;
  action_id: string;
  tool_label: string | null;
  idempotency_key: string | null;
  reason: string | null;
  detail: string;
  observed_at: string;
};

const OBSERVATION_COLUMNS =
  "id, outcome, source, correlation_id, task_id, action_id, tool_label, " +
  "idempotency_key, reason, detail, observed_at";

// hq_ai_executor_shadow_observations / hq_ai_tasks are service-role-only HQ
// tables, not in the generated Supabase types — cast past the typed client (the
// same `as never` shim hq-approvals.ts / hq-task-queue.ts use).
type ReadQuery<T> = {
  select(columns: string): ReadQuery<T>;
  in(column: string, values: ReadonlyArray<unknown>): ReadQuery<T>;
  order(column: string, options?: { ascending?: boolean }): ReadQuery<T>;
  limit(count: number): ReadQuery<T>;
} & PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

function reads<T>(admin: AdminClient, table: string): ReadQuery<T> {
  return admin.from(table as never) as unknown as ReadQuery<T>;
}

type TaskMetaRow = { id: string; task_type: string; assigned_employee_id: string | null };
type EmployeeRow = { id: string; name: string };

export type ExecutorShadowFeed = {
  observations: ShadowObservationView[];
  /** task_id → { taskType, employeeName } for every observation that resolved. */
  metaByTaskId: Map<string, ShadowTaskMeta>;
  groups: ShadowGroup[];
  totals: Record<ShadowOutcome, number>;
};

/**
 * The recent shadow record, joined and grouped for the operator page: newest
 * observations first, task/employee meta resolved best-effort (a missing task is
 * grouped as "unknown", never dropped), busiest groups first.
 */
export async function getExecutorShadowFeed(limit = 200): Promise<ExecutorShadowFeed> {
  const admin = createAdminClient();
  const bounded = Math.min(Math.max(limit, 1), 500);

  const { data, error } = await reads<ObservationRow>(
    admin,
    "hq_ai_executor_shadow_observations",
  )
    .select(OBSERVATION_COLUMNS)
    .order("observed_at", { ascending: false })
    .limit(bounded);
  if (error) throw readFailure("executor-shadow: observations", error);
  const rows = Array.isArray(data) ? data : [];

  const observations: ShadowObservationView[] = rows.map((r) => ({
    id: r.id,
    outcome: r.outcome,
    taskId: r.task_id,
    actionId: r.action_id,
    toolLabel: r.tool_label,
    idempotencyKey: r.idempotency_key,
    reason: r.reason,
    detail: r.detail,
    correlationId: r.correlation_id,
    observedAt: r.observed_at,
  }));

  const metaByTaskId = await loadTaskMeta(admin, observations.map((o) => o.taskId));

  return {
    observations,
    metaByTaskId,
    groups: groupShadowObservations(observations, metaByTaskId),
    totals: summarizeShadowOutcomes(observations),
  };
}

/** Resolve task ids to (task type, employee name). Meta reads are loud too. */
async function loadTaskMeta(
  admin: AdminClient,
  taskIds: ReadonlyArray<string>,
): Promise<Map<string, ShadowTaskMeta>> {
  const meta = new Map<string, ShadowTaskMeta>();
  const unique = [...new Set(taskIds)];
  if (unique.length === 0) return meta;

  const { data: tasks, error: tasksError } = await reads<TaskMetaRow>(admin, "hq_ai_tasks")
    .select("id, task_type, assigned_employee_id")
    .in("id", unique);
  if (tasksError) throw readFailure("executor-shadow: task meta", tasksError);
  const taskRows = Array.isArray(tasks) ? tasks : [];

  const employeeIds = [
    ...new Set(
      taskRows
        .map((t) => t.assigned_employee_id)
        .filter((id): id is string => !!id),
    ),
  ];
  const names = new Map<string, string>();
  if (employeeIds.length > 0) {
    const { data: employees, error: employeesError } = await reads<EmployeeRow>(
      admin,
      "ai_employees",
    )
      .select("id, name")
      .in("id", employeeIds);
    if (employeesError) throw readFailure("executor-shadow: employee meta", employeesError);
    for (const e of Array.isArray(employees) ? employees : []) names.set(e.id, e.name);
  }

  for (const t of taskRows) {
    meta.set(t.id, {
      taskType: t.task_type,
      employeeName: t.assigned_employee_id
        ? (names.get(t.assigned_employee_id) ?? null)
        : null,
    });
  }
  return meta;
}
