import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAdminActivity, type AdminActivityRow } from "@/server/services/hq-audit";
import { readFailure } from "@/lib/supabase/read-failure";
import { listRecentApprovalsByEmployee } from "@/server/services/hq-approvals";
import {
  type AiEmployee,
  type AiEmployeeTask,
  type AiEmployeeMemoryEntry,
} from "@/lib/ai-employees/model";
import {
  deriveApprovalLevel,
  type ApprovalLevelResult,
} from "@/lib/ai-employees/approval-levels";
import {
  mergeInteractionFeed,
  type FeedApprovalRow,
  type FeedTaskRow,
  type InteractionItem,
} from "@/lib/ai-employees/interaction-feed";
import { resolveServedAuthority } from "@/server/sdk/registry-parity";

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
  "manager_slug",
  "retired_at",
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

/**
 * Derive an employee's explicit 1–5 approval level from the authority the Capability Registry
 * SERVES for it (Directive #015 / D-05, via {@link resolveServedAuthority}, with the default-deny
 * floor as the automatic fail-safe). Pure CLASSIFICATION of the served posture — it reads existing
 * state and grants nothing. Non-throwing: {@link resolveServedAuthority} already degrades to the
 * floor, and {@link deriveApprovalLevel} is total, so this always returns a level.
 */
export async function resolveEmployeeApprovalLevel(employee: {
  slug: string;
  department?: string | null;
}): Promise<ApprovalLevelResult> {
  const served = await resolveServedAuthority(employee);
  return deriveApprovalLevel({
    canExecute: served.posture.canExecute,
    requiresApproval: served.posture.requiresApproval,
    tokens: served.capabilities.tokens,
    source: served.source,
  });
}

/** Resolve approval levels for a roster, keyed by employee id — one served-authority read each. */
export async function resolveApprovalLevelsByEmployeeId(
  employees: ReadonlyArray<{ id: string; slug: string; department?: string | null }>,
): Promise<Map<string, ApprovalLevelResult>> {
  const entries = await Promise.all(
    employees.map(
      async (e) => [e.id, await resolveEmployeeApprovalLevel(e)] as const,
    ),
  );
  return new Map(entries);
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

// ---------------------------------------------------------------------
// Interaction feed — the employee's real conversation with the company
// (contract item 5). See lib/ai-employees/interaction-feed.ts for why this
// is a merged feed of stored rows rather than a chat transcript: no chat UI
// exists for a literal conversation, so the honest history IS the employee's
// engine tasks (hq_ai_tasks), the humans' config decisions about it
// (admin_activity_log), and the approvals it raised (hq_approvals).
// ---------------------------------------------------------------------

export type { InteractionItem } from "@/lib/ai-employees/interaction-feed";

const FEED_SOURCE_LIMIT = 50;

/**
 * The merged, newest-first interaction feed for one employee. Service-role
 * reads (all three sources are HQ-only tables); callers must already be behind
 * the super-admin gate. Read failures on a SINGLE source degrade that source to
 * empty with a loud log rather than blanking the whole feed — the feed is a
 * display surface, and two honest streams beat zero.
 */
export async function getEmployeeInteractionFeed(
  slug: string,
): Promise<InteractionItem[]> {
  const admin = createAdminClient();

  const { data: empRaw, error: empError } = await admin
    .from("ai_employees" as never)
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (empError) throw readFailure("ai-employees: feed employee", empError);
  const employeeId = (empRaw as unknown as { id: string } | null)?.id;
  if (!employeeId) return [];

  const [taskRes, approvalRes, activity] = await Promise.all([
    admin
      .from("hq_ai_tasks" as never)
      .select("id, task_type, status, result, error_message, created_at, finished_at")
      .eq("assigned_employee_id", employeeId)
      .order("created_at", { ascending: false })
      .limit(FEED_SOURCE_LIMIT),
    // Approvals go through the sanctioned hq-approvals door (single-module pin)
    // rather than a direct hq_approvals read.
    listRecentApprovalsByEmployee(employeeId, FEED_SOURCE_LIMIT),
    listAdminActivity("ai_employees", employeeId, FEED_SOURCE_LIMIT),
  ]);

  if (taskRes.error) {
    console.error("[ai-employees] interaction feed: task read failed", taskRes.error);
  }
  if (approvalRes.error) {
    console.error("[ai-employees] interaction feed: approval read failed", approvalRes.error);
  }

  return mergeInteractionFeed(
    (taskRes.data ?? []) as unknown as FeedTaskRow[],
    activity,
    (approvalRes.data ?? []) as unknown as FeedApprovalRow[],
  );
}
