import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ukMonthKeyOf, ukMonthWindow } from "@/lib/ai/governor/policy";
import {
  computeEmployeeStats,
  emptyEmployeeStats,
  type EmployeeStats,
  type MemoryStatRow,
  type TaskStatRow,
} from "@/lib/ai-employees/stats";

/**
 * CrewFlow HQ — AI Employee workforce telemetry data access
 * (CEO Directive 004, Phase 3).
 *
 * Service-role only; the ai_employee_* tables are RLS-enabled with NO
 * policies, so these reads are invisible to the customer/staff JWT client.
 * Callers (the boardroom roster page) must already have confirmed
 * isSuperAdminEmail via the /admin layout.
 *
 * Scale: rather than an N+1 per-employee aggregate, this issues ONE bounded
 * read of recent task rows and ONE bounded read of memory rows, then buckets
 * them per employee in-app — two round trips regardless of roster size,
 * mirroring the Command Centre's bounded-read approach. The recent-task
 * window keeps a live dashboard honest about current activity; a future
 * learning loop that logs millions of tasks can swap to SQL aggregates
 * (the `ai_employee_tasks_created_idx` index already supports the ordering).
 *
 * ARCHITECTURE ONLY — reads + derives. Nothing here executes a task.
 */

const RECENT_TASK_LIMIT = 1000; // bounded sample; PostgREST clamps to max_rows=1000
const MEMORY_LIMIT = 1000; // bounded sample; PostgREST clamps to max_rows=1000

type TaskRow = TaskStatRow & { ai_employee_id: string };
type MemRow = MemoryStatRow & { ai_employee_id: string };

export type WorkforceStats = {
  byEmployee: Map<string, EmployeeStats>;
  generatedAt: string;
};

function bucket<T extends { ai_employee_id: string }>(
  rows: ReadonlyArray<T>,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const arr = map.get(row.ai_employee_id);
    if (arr) arr.push(row);
    else map.set(row.ai_employee_id, [row]);
  }
  return map;
}

export async function getAiWorkforceStats(): Promise<WorkforceStats> {
  const admin = createAdminClient();

  const [taskRes, memRes] = await Promise.all([
    admin
      .from("ai_employee_tasks" as never)
      .select("ai_employee_id, status, title, created_at, completed_at")
      .order("created_at", { ascending: false })
      .limit(RECENT_TASK_LIMIT),
    admin
      .from("ai_employee_memory" as never)
      .select("ai_employee_id, content")
      .limit(MEMORY_LIMIT),
  ]);

  if (taskRes.error) {
    console.error("[ai-employee-stats] task read failed", taskRes.error);
  }
  if (memRes.error) {
    console.error("[ai-employee-stats] memory read failed", memRes.error);
  }

  const tasksByEmp = bucket((taskRes.data ?? []) as unknown as TaskRow[]);
  const memsByEmp = bucket((memRes.data ?? []) as unknown as MemRow[]);

  const byEmployee = new Map<string, EmployeeStats>();
  const ids = new Set<string>([...tasksByEmp.keys(), ...memsByEmp.keys()]);
  for (const id of ids) {
    byEmployee.set(
      id,
      computeEmployeeStats(tasksByEmp.get(id) ?? [], memsByEmp.get(id) ?? []),
    );
  }

  return { byEmployee, generatedAt: new Date().toISOString() };
}

/** Stats for one employee, or a zeroed baseline if they have no history. */
export function statsForEmployee(
  ws: WorkforceStats,
  employeeId: string,
): EmployeeStats {
  return ws.byEmployee.get(employeeId) ?? emptyEmployeeStats();
}

// ---------------------------------------------------------------------
// Per-employee KPIs — persisted, honest, derived (contract items 3 + 4).
//
// COST comes from the AI invocation ledger's new `ai_employee_id` attribution
// column (migration 20261222000000): the sum of `estimated_cost_pence` over the
// current UK budget month — the SAME calendar window the cost governor buckets
// by, so cost and outcomes describe one period. IMPACT is the honest derived
// triple (tasks completed / tasks failed / approvals requested) over the real
// engine tables — never invented revenue.
//
// PERSISTENCE is compute-on-read: the boardroom's stats read path calls this,
// which upserts the CURRENT period's row into `ai_employee_kpis` (service-role
// only; RLS with no policies) and returns the figures. No new cron — the table
// accretes one row per (employee, month) as the boardroom is actually used,
// and a failed upsert degrades to display-only with a loud log.
// ---------------------------------------------------------------------

const KPI_READ_LIMIT = 1000; // bounded sample; PostgREST clamps to max_rows=1000

export type EmployeeKpis = {
  /** First day of the UK budget month this row describes (YYYY-MM-01). */
  periodStart: string;
  tasksCompleted: number;
  tasksFailed: number;
  approvalsRequested: number;
  /** Attributed spend (ai_invocations.ai_employee_id) this period, in pence. */
  costPence: number;
  /** failed / (completed + failed); null when nothing finished this period. */
  failureRatePct: number | null;
};

function emptyKpis(periodStart: string): EmployeeKpis {
  return {
    periodStart,
    tasksCompleted: 0,
    tasksFailed: 0,
    approvalsRequested: 0,
    costPence: 0,
    failureRatePct: null,
  };
}

/**
 * Compute the current UK-month KPIs for the roster, upsert them into
 * `ai_employee_kpis`, and return them keyed by employee SLUG (the KPI table's
 * own key). Three bounded reads regardless of roster size, mirroring
 * `getAiWorkforceStats`. Read failures degrade that source to zero with a loud
 * log — a wrong dashboard figure is the only cost, and no spend decision hangs
 * on this path.
 */
export async function getEmployeeKpis(
  employees: ReadonlyArray<{ id: string; slug: string }>,
): Promise<Map<string, EmployeeKpis>> {
  const monthKey = ukMonthKeyOf(new Date());
  const periodStart = `${monthKey}-01`;
  const { startMs, endMs } = ukMonthWindow(monthKey);
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  const byId = new Map<string, EmployeeKpis>();
  const slugById = new Map<string, string>();
  for (const e of employees) {
    byId.set(e.id, emptyKpis(periodStart));
    slugById.set(e.id, e.slug);
  }
  if (byId.size === 0) return new Map();

  const admin = createAdminClient();
  const [taskRes, approvalRes, costRes] = await Promise.all([
    admin
      .from("hq_ai_tasks" as never)
      .select("assigned_employee_id, status")
      .not("assigned_employee_id", "is", null)
      .in("status", ["completed", "failed"])
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .limit(KPI_READ_LIMIT),
    admin
      .from("hq_approvals" as never)
      .select("ai_employee_id")
      .gte("requested_at", startIso)
      .lt("requested_at", endIso)
      .limit(KPI_READ_LIMIT),
    admin
      .from("ai_invocations" as never)
      .select("ai_employee_id, estimated_cost_pence")
      .not("ai_employee_id", "is", null)
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .limit(KPI_READ_LIMIT),
  ]);

  if (taskRes.error) {
    console.error("[ai-employee-stats] kpi task read failed", taskRes.error);
  }
  if (approvalRes.error) {
    console.error("[ai-employee-stats] kpi approval read failed", approvalRes.error);
  }
  if (costRes.error) {
    console.error("[ai-employee-stats] kpi cost read failed", costRes.error);
  }

  for (const row of (taskRes.data ?? []) as unknown as Array<{
    assigned_employee_id: string;
    status: string;
  }>) {
    const k = byId.get(row.assigned_employee_id);
    if (!k) continue;
    if (row.status === "completed") k.tasksCompleted += 1;
    else if (row.status === "failed") k.tasksFailed += 1;
  }
  for (const row of (approvalRes.data ?? []) as unknown as Array<{
    ai_employee_id: string;
  }>) {
    const k = byId.get(row.ai_employee_id);
    if (k) k.approvalsRequested += 1;
  }
  for (const row of (costRes.data ?? []) as unknown as Array<{
    ai_employee_id: string;
    estimated_cost_pence: number;
  }>) {
    const k = byId.get(row.ai_employee_id);
    if (k) k.costPence += Math.max(0, Math.round(row.estimated_cost_pence || 0));
  }

  const bySlug = new Map<string, EmployeeKpis>();
  for (const [id, k] of byId) {
    const finished = k.tasksCompleted + k.tasksFailed;
    k.failureRatePct = finished === 0 ? null : Math.round((k.tasksFailed / finished) * 100);
    const slug = slugById.get(id);
    if (slug) bySlug.set(slug, k);
  }

  // Persist the current period — best-effort, one round trip for the roster.
  try {
    const computedAt = new Date().toISOString();
    const rows = [...bySlug.entries()].map(([slug, k]) => ({
      employee_slug: slug,
      period_start: k.periodStart,
      tasks_completed: k.tasksCompleted,
      tasks_failed: k.tasksFailed,
      approvals_requested: k.approvalsRequested,
      cost_pence: k.costPence,
      computed_at: computedAt,
    }));
    const { error } = await admin
      .from("ai_employee_kpis" as never)
      .upsert(rows as never, { onConflict: "employee_slug,period_start" } as never);
    if (error) {
      console.error("[ai-employee-stats] kpi upsert failed", error);
    }
  } catch (e) {
    console.error("[ai-employee-stats] kpi upsert threw", e);
  }

  return bySlug;
}

/** KPIs for one employee, or a zeroed current-period baseline. */
export function kpisForEmployee(
  kpis: Map<string, EmployeeKpis>,
  slug: string,
): EmployeeKpis {
  return kpis.get(slug) ?? emptyKpis(`${ukMonthKeyOf(new Date())}-01`);
}
