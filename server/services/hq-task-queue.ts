import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TaskPriority, TaskStatus } from "@/server/services/hq-tasks";

/**
 * CrewFlow HQ — unified operator read model for the Generic Task Engine
 * (CEO Directive #012 / D-02, PR-G).
 *
 * ONE place an operator sees the whole autonomous workforce on the shared
 * queue: every AI employee, every task type, one engine, every action traced.
 * It is deliberately employee-AGNOSTIC — it groups by the durable `task_type`
 * contract and joins `ai_employees` through each task's `assigned_employee_id`,
 * so a newly migrated employee (#42) appears here the moment it enqueues its
 * first task, with NO change to this file. That is the architectural health
 * metric made visible: the operating system grows, the employee does not.
 *
 * READ-ONLY. `hq_ai_tasks` is RLS:hq (service-role only) and is WRITTEN solely
 * through the seven SECURITY DEFINER entry points (Volume XII §11.1); this
 * module issues nothing but `.select()` — never insert/update/delete — so it
 * sits squarely inside the engine's standing security posture
 * (__tests__/security/task-engine-spine.test.ts).
 *
 * Scale: a bounded recent-activity window (the same shape ai-employee-stats.ts
 * already uses) drives the per-employee breakdown + live feed in ONE round
 * trip, while the headline totals come from cheap exact head-counts. A future
 * SQL aggregate / materialised view can replace the window without changing
 * this surface — the platform capability grows underneath an unchanged read
 * contract.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------
// READ-ONLY typed access to hq_ai_tasks. Exposes NO insert/update/delete —
// the queue is written only through the entry points (hq-tasks.ts) + runner
// SDK (server/sdk/tasks.ts). Mirrors the shim in hq-research.ts so the house
// has one idiom for "read the generic queue".
// ---------------------------------------------------------------------

type DbList<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
interface TaskRead<T> extends DbList<T> {
  select(columns: string): TaskRead<T>;
  order(column: string, options?: { ascending?: boolean }): TaskRead<T>;
  limit(count: number): TaskRead<T>;
}
function taskReads<T>(admin: AdminClient): TaskRead<T> {
  return admin.from("hq_ai_tasks" as never) as unknown as TaskRead<T>;
}

type CountQuery = PromiseLike<{ count: number | null; error: { message: string } | null }> & {
  select(columns: string, opts: { count: "exact"; head: true }): CountQuery;
  eq(column: string, value: unknown): CountQuery;
  in(column: string, values: ReadonlyArray<unknown>): CountQuery;
};
function taskCount(admin: AdminClient): CountQuery {
  return admin.from("hq_ai_tasks" as never) as unknown as CountQuery;
}

const COUNT_OPTS = { count: "exact", head: true } as const;

async function headCount(q: CountQuery): Promise<number> {
  const { count } = await q;
  return count ?? 0;
}

// ---------------------------------------------------------------------
// Lifecycle buckets — collapse the nine task states into the handful an
// operator reasons about. Active = anything a worker currently holds; the
// terminal pair (completed/failed) and the holds (blocked/cancelled) are
// kept distinct so health is legible at a glance.
// ---------------------------------------------------------------------

export const QUEUE_BUCKETS = [
  "queued",
  "active",
  "waiting_approval",
  "completed",
  "failed",
  "blocked",
  "cancelled",
] as const;
export type QueueBucket = (typeof QUEUE_BUCKETS)[number];

/** Task states the engine treats as "a worker is on it right now". */
const ACTIVE_STATES: ReadonlyArray<TaskStatus> = ["claimed", "running", "verifying"];

function zeroBuckets(): Record<QueueBucket, number> {
  return {
    queued: 0,
    active: 0,
    waiting_approval: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
  };
}

export function bucketOfStatus(status: string): QueueBucket {
  switch (status) {
    case "pending":
      return "queued";
    case "claimed":
    case "running":
    case "verifying":
      return "active";
    case "waiting_approval":
      return "waiting_approval";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
    default:
      // Unknown → keep it visible as in-flight rather than silently dropping it.
      return "active";
  }
}

// ---------------------------------------------------------------------
// Public shapes.
// ---------------------------------------------------------------------

/** An AI employee as the queue view needs to render it (joined identity). */
export type EmployeeRef = {
  id: string;
  name: string;
  slug: string;
  department: string;
  icon: string;
  accent: string;
};

/** Engine-wide, exact counts (head-counts, not windowed). */
export type TaskQueueTotals = {
  total: number;
  queued: number;
  active: number;
  waitingApproval: number;
  completed: number;
  failed: number;
};

/**
 * One task_type's footprint on the engine, summarised over the recent-activity
 * window. The `employee` is joined from the tasks' `assigned_employee_id`; it is
 * `null` only if a task was enqueued without one (never by the migrated
 * employees, which always stamp it).
 */
export type EmployeeQueueSummary = {
  taskType: string;
  employee: EmployeeRef | null;
  windowCount: number;
  buckets: Record<QueueBucket, number>;
  lastActivityAt: string | null;
};

/** One row of the live feed — a single task, employee-joined, newest first. */
export type TaskQueueRow = {
  id: string;
  taskType: string;
  employee: EmployeeRef | null;
  status: TaskStatus;
  bucket: QueueBucket;
  subjectKind: string;
  subjectId: string | null;
  priority: TaskPriority;
  retryCount: number;
  maxRetries: number;
  origin: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  leaseExpiresAt: string | null;
  correlationId: string;
};

export type TaskQueueOverview = {
  /** Engine-wide, exact — the source of truth for the headline tiles. */
  totals: TaskQueueTotals;
  /** Per task_type, over the recent-activity window. Newest-loaded first. */
  byType: EmployeeQueueSummary[];
  /** The newest tasks across every type — the live feed. */
  recent: TaskQueueRow[];
  /** How many rows the windowed breakdown actually summarised. */
  windowSize: number;
  /** The window cap requested (so the UI can say "latest N"). */
  windowCap: number;
  generatedAt: string;
};

// ---------------------------------------------------------------------
// The window read row (column-for-column with the select below).
// ---------------------------------------------------------------------

type WindowRow = {
  id: string;
  task_type: string;
  assigned_employee_id: string | null;
  status: TaskStatus;
  subject_kind: string;
  subject_id: string | null;
  priority: TaskPriority;
  retry_count: number;
  max_retries: number;
  origin: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  lease_expires_at: string | null;
  correlation_id: string;
};

const WINDOW_COLUMNS =
  "id, task_type, assigned_employee_id, status, subject_kind, subject_id, priority, retry_count, max_retries, origin, created_at, started_at, finished_at, lease_expires_at, correlation_id";

const DEFAULT_WINDOW = 500;
const DEFAULT_FEED = 18;

type EmployeeReadRow = {
  id: string;
  name: string;
  slug: string;
  department: string;
  icon: string;
  accent: string;
};

async function loadEmployees(
  admin: AdminClient,
  ids: ReadonlyArray<string>,
): Promise<Map<string, EmployeeRef>> {
  const map = new Map<string, EmployeeRef>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return map;
  const { data } = await (
    admin.from("ai_employees" as never) as unknown as {
      select: (c: string) => {
        in: (
          k: string,
          v: ReadonlyArray<unknown>,
        ) => PromiseLike<{ data: EmployeeReadRow[] | null }>;
      };
    }
  )
    .select("id, name, slug, department, icon, accent")
    .in("id", unique);
  for (const e of data ?? []) {
    map.set(e.id, {
      id: e.id,
      name: e.name,
      slug: e.slug,
      department: e.department,
      icon: e.icon,
      accent: e.accent,
    });
  }
  return map;
}

/**
 * The whole engine through one operator's eye. Reads, never writes. Headline
 * totals are exact (engine-wide head-counts); the per-employee breakdown + live
 * feed are summarised over the most-recent `windowCap` tasks — honest about
 * current activity, constant round trips regardless of how many employees
 * eventually share the engine.
 */
export async function getTaskQueueOverview(
  opts: { windowCap?: number; feed?: number } = {},
): Promise<TaskQueueOverview> {
  const admin = createAdminClient();
  const windowCap = Math.min(Math.max(opts.windowCap ?? DEFAULT_WINDOW, 1), 1000);
  const feed = Math.min(Math.max(opts.feed ?? DEFAULT_FEED, 1), 100);

  const [windowRes, total, queued, active, waitingApproval, completed, failed] =
    await Promise.all([
      taskReads<WindowRow>(admin)
        .select(WINDOW_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(windowCap),
      headCount(taskCount(admin).select("id", COUNT_OPTS)),
      headCount(taskCount(admin).select("id", COUNT_OPTS).eq("status", "pending")),
      headCount(taskCount(admin).select("id", COUNT_OPTS).in("status", ACTIVE_STATES)),
      headCount(
        taskCount(admin).select("id", COUNT_OPTS).eq("status", "waiting_approval"),
      ),
      headCount(taskCount(admin).select("id", COUNT_OPTS).eq("status", "completed")),
      headCount(taskCount(admin).select("id", COUNT_OPTS).eq("status", "failed")),
    ]);

  const rows: WindowRow[] = Array.isArray(windowRes.data) ? windowRes.data : [];

  const employees = await loadEmployees(
    admin,
    rows
      .map((r) => r.assigned_employee_id)
      .filter((id): id is string => !!id),
  );
  const employeeFor = (id: string | null): EmployeeRef | null =>
    id ? (employees.get(id) ?? null) : null;

  // Per task_type accumulation over the window. `rows` is newest-first, so the
  // first time we see a type its created_at IS that type's last activity.
  type Accum = {
    taskType: string;
    employeeId: string | null;
    windowCount: number;
    buckets: Record<QueueBucket, number>;
    lastActivityAt: string | null;
  };
  const accums = new Map<string, Accum>();
  for (const r of rows) {
    let a = accums.get(r.task_type);
    if (!a) {
      a = {
        taskType: r.task_type,
        employeeId: r.assigned_employee_id,
        windowCount: 0,
        buckets: zeroBuckets(),
        lastActivityAt: r.created_at,
      };
      accums.set(r.task_type, a);
    }
    a.windowCount += 1;
    a.buckets[bucketOfStatus(r.status)] += 1;
    if (!a.employeeId && r.assigned_employee_id) a.employeeId = r.assigned_employee_id;
  }

  const byType: EmployeeQueueSummary[] = [...accums.values()]
    .sort((x, y) => y.windowCount - x.windowCount || x.taskType.localeCompare(y.taskType))
    .map((a) => ({
      taskType: a.taskType,
      employee: employeeFor(a.employeeId),
      windowCount: a.windowCount,
      buckets: a.buckets,
      lastActivityAt: a.lastActivityAt,
    }));

  const recent: TaskQueueRow[] = rows.slice(0, feed).map((r) => ({
    id: r.id,
    taskType: r.task_type,
    employee: employeeFor(r.assigned_employee_id),
    status: r.status,
    bucket: bucketOfStatus(r.status),
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    priority: r.priority,
    retryCount: r.retry_count,
    maxRetries: r.max_retries,
    origin: r.origin,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    leaseExpiresAt: r.lease_expires_at,
    correlationId: r.correlation_id,
  }));

  return {
    totals: { total, queued, active, waitingApproval, completed, failed },
    byType,
    recent,
    windowSize: rows.length,
    windowCap,
    generatedAt: new Date().toISOString(),
  };
}
