import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAdminActivity, type AdminActivityRow } from "@/server/services/hq-audit";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  type AiEmployee,
  type AiEmployeeTask,
  type AiEmployeeMemoryEntry,
} from "@/lib/ai-employees/model";

/**
 * CrewFlow HQ — AI Employee Framework data access.
 *
 * Service-role client only; the three ai_employee* tables have RLS
 * enabled with NO policies, so every read here is invisible to the
 * customer/staff JWT client. Callers (pages + actions) must already
 * have confirmed isSuperAdminEmail.
 *
 * The tables landed in migration 20260712000000 and aren't in the
 * generated Supabase types yet, so selects cast through `as never` /
 * `as unknown as T`, matching the hq-audit / hq-customer-snapshot
 * pattern.
 *
 * FRAMEWORK ONLY — these functions read and shape config/history rows.
 * Nothing here invokes a model provider or executes anything.
 */

const EMPLOYEE_COLUMNS = [
  "id",
  "name",
  "slug",
  "role",
  "department",
  "description",
  "icon",
  "accent",
  "status",
  "model_provider",
  "model_name",
  "system_prompt",
  "memory_scope",
  "current_task",
  "last_activity_at",
  "sort_order",
  "created_at",
  "updated_at",
].join(", ");

const TASK_COLUMNS = [
  "id",
  "ai_employee_id",
  "title",
  "status",
  "summary",
  "created_by_email",
  "metadata",
  "created_at",
  "updated_at",
  "completed_at",
].join(", ");

const MEMORY_COLUMNS = [
  "id",
  "ai_employee_id",
  "scope",
  "mem_key",
  "content",
  "created_at",
  "updated_at",
].join(", ");

export async function listAiEmployees(): Promise<AiEmployee[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_employees" as never)
    .select(EMPLOYEE_COLUMNS)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[ai-employees] listAiEmployees failed", error);
    return [];
  }
  return (data ?? []) as unknown as AiEmployee[];
}

export type AiEmployeeDetail = {
  employee: AiEmployee;
  tasks: AiEmployeeTask[];
  memory: AiEmployeeMemoryEntry[];
  activity: AdminActivityRow[];
};

export async function loadAiEmployeeBySlug(
  slug: string,
): Promise<AiEmployeeDetail | null> {
  const admin = createAdminClient();

  const { data: raw, error: rawError } = await admin
    .from("ai_employees" as never)
    .select(EMPLOYEE_COLUMNS)
    .eq("slug", slug)
    .maybeSingle();
  if (rawError) throw readFailure("ai-employees: by slug", rawError);
  if (!raw) return null;
  const employee = raw as unknown as AiEmployee;

  const { data: tasksRaw, error: tasksError } = await admin
    .from("ai_employee_tasks" as never)
    .select(TASK_COLUMNS)
    .eq("ai_employee_id", employee.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (tasksError) throw readFailure("ai-employees: tasks", tasksError);
  const tasks = (tasksRaw ?? []) as unknown as AiEmployeeTask[];

  const { data: memRaw, error: memError } = await admin
    .from("ai_employee_memory" as never)
    .select(MEMORY_COLUMNS)
    .eq("ai_employee_id", employee.id)
    .order("created_at", { ascending: false })
    .limit(50);
  // `memError` was bound and then never inspected — the exact shape this sweep
  // removes, and the reason the merge guard in
  // __tests__/security/loud-read-failures.test.ts asserts that a destructured
  // error is USED. Match the sibling tasks read above.
  if (memError) throw readFailure("ai-employees: memory", memError);
  const memory = (memRaw ?? []) as unknown as AiEmployeeMemoryEntry[];

  const activity = await listAdminActivity("ai_employees", employee.id, 50);

  return { employee, tasks, memory, activity };
}
