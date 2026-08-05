import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  deriveEmployeeCards,
  type BoardroomTask,
  type EmployeeCards,
} from "@/lib/hq/boardroom-cards";

/**
 * CrewFlow HQ — AI Boardroom card telemetry (the Confidence / ETA / Health gap).
 *
 * Service-role reads over the durable task queue `hq_ai_tasks` (RLS:hq — RLS enabled,
 * ZERO policies), invisible to every JWT client. Callers (the boardroom pages) must
 * already have confirmed isSuperAdminEmail via the /admin layout.
 *
 * This is a READ-ONLY projection: it SELECTs the card-relevant columns and buckets them
 * per assigned employee, then defers to the pure `lib/hq/boardroom-cards` derivations.
 * It NEVER writes the queue — the task-engine-spine security test forbids any
 * .from('hq_ai_tasks') insert/update/delete outside the SECURITY DEFINER entry points,
 * and a read is the only thing this module does. The one sanctioned write path for the
 * product stage is `setTaskStage` in server/services/hq-tasks.ts (an .rpc() wrapper).
 *
 * Scale: ONE bounded read regardless of roster size (mirrors ai-employee-stats), then
 * an in-app bucket by assigned_employee_id. Unassigned tasks (assigned_employee_id
 * null) carry no employee card and are skipped.
 */

const CARD_COLUMNS = [
  "assigned_employee_id",
  "status",
  "verification",
  "result",
  "deadline_at",
  "lease_expires_at",
  "heartbeat_at",
  "retry_count",
  "max_retries",
  "pipeline_stage",
].join(", ");

/** A bounded window of recent tasks — enough to keep the cards live, cheap to read. */
const TASK_WINDOW = 1000; // bounded sample; PostgREST clamps to max_rows=1000

type Row = BoardroomTask & { assigned_employee_id: string | null };

export type BoardroomCardsResult = {
  /** employeeId → derived cards. Employees with no assigned tasks are absent. */
  byEmployee: Map<string, EmployeeCards>;
  generatedAt: string;
};

/**
 * Read the recent task window once and derive the Confidence / ETA / Health cards for
 * every AI employee that has assigned tasks. `now` is injected so the derivation is
 * deterministic (and testable); it defaults to the wall clock.
 */
export async function getBoardroomCards(now: Date = new Date()): Promise<BoardroomCardsResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("hq_ai_tasks" as never)
    .select(CARD_COLUMNS)
    .not("assigned_employee_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(TASK_WINDOW);

  if (error) {
    console.error("[hq-task-pipeline] getBoardroomCards failed", error);
    return { byEmployee: new Map(), generatedAt: now.toISOString() };
  }

  const rows = (data ?? []) as unknown as Row[];
  const buckets = new Map<string, BoardroomTask[]>();
  for (const row of rows) {
    const id = row.assigned_employee_id;
    if (!id) continue;
    const arr = buckets.get(id);
    if (arr) arr.push(row);
    else buckets.set(id, [row]);
  }

  const byEmployee = new Map<string, EmployeeCards>();
  for (const [id, tasks] of buckets) {
    byEmployee.set(id, deriveEmployeeCards(tasks, now));
  }
  return { byEmployee, generatedAt: now.toISOString() };
}

/**
 * Cards for ONE employee (the detail page). Reads only that employee's assigned tasks.
 * Returns null-safe empty cards (via the shared derivation) when there are none.
 */
export async function getBoardroomCardsForEmployee(
  employeeId: string,
  now: Date = new Date(),
): Promise<EmployeeCards> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("hq_ai_tasks" as never)
    .select(CARD_COLUMNS)
    .eq("assigned_employee_id", employeeId)
    .order("created_at", { ascending: false })
    .limit(TASK_WINDOW);

  if (error) {
    console.error("[hq-task-pipeline] getBoardroomCardsForEmployee failed", error);
    return deriveEmployeeCards([], now);
  }
  const tasks = (data ?? []) as unknown as BoardroomTask[];
  return deriveEmployeeCards(tasks, now);
}
