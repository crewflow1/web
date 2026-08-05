import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
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
