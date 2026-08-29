import "server-only";

/**
 * CrewFlow HQ — Design AI runner (HQ roster completion).
 *
 * Gives the previously-dark `design-ai` roster identity REAL deterministic work: a
 * brand-token consistency audit over the roster, run as a Task-Engine task. It owns NO
 * tables — it drains a `design_consistency` task off the generic Task Engine through the
 * canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — a brand-token scan of ai_employees.icon/accent. NO LLM.
 *   • It REPORTS, it does not act: it alters no shipped design.
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  summariseDesignConsistency,
  summariseDesignReview,
  type DesignEmployeeRow,
  type DesignReviewEmployeeRow,
} from "@/lib/hq/roster-workers";
import { generateDepartmentDraft } from "@/server/services/hq-generative-seams";
import { enqueueTask } from "@/server/services/hq-tasks";
import {
  resolveWorkerIdentity,
  normaliseWorkerOutcome,
  type WorkerRunOutcome,
} from "@/server/services/hq-worker-runner-kit";
import {
  drainTaskType,
  registerTaskHandler,
  runReadyTask,
  type DrainSummary,
  type TaskHandler,
} from "@/server/sdk/tasks";

const DESIGN_AI_SLUG = "design-ai";
const DESIGN_TASK_TYPE = "design_consistency";
/**
 * The DESIGN REVIEW contract (L9a / P8) — the deeper deterministic audit
 * (token-format coherence, per-department accent collisions, icon reuse) over
 * the same real roster data, plus the governed dark critique seam
 * `hq.design_review` (attached below; null until a model tier is bound).
 */
const DESIGN_REVIEW_TASK_TYPE = "design_review";

const EMPLOYEE_WINDOW = 200;

async function readSignals(): Promise<{ employees: DesignEmployeeRow[] }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_employees" as never)
    .select("slug, icon, accent")
    .order("sort_order", { ascending: true })
    .limit(EMPLOYEE_WINDOW);
  if (error) throw new Error(`hq-design-runner: employee read failed — ${error.message}`);
  return { employees: (data ?? []) as unknown as DesignEmployeeRow[] };
}

async function readReviewSignals(): Promise<{ employees: DesignReviewEmployeeRow[] }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_employees" as never)
    .select("slug, icon, accent, department")
    .order("sort_order", { ascending: true })
    .limit(EMPLOYEE_WINDOW);
  if (error) throw new Error(`hq-design-runner: review read failed — ${error.message}`);
  return { employees: (data ?? []) as unknown as DesignReviewEmployeeRow[] };
}

const designHandler: TaskHandler = async () => {
  const { employees } = await readSignals();
  return summariseDesignConsistency(employees, new Date());
};

/**
 * The design_review handler: deterministic findings first, then the GOVERNED
 * DARK critique seam. The seam lives entirely in the shared department-seam
 * module (hq-generative-seams.ts → invokeWithGovernor under `hq.design_review`);
 * this runner opens no model door itself, and while the tier is dark (always,
 * today) the seam returns null and the artifact's generativeNote says so — the
 * run is byte-identical to a purely deterministic one.
 */
const designReviewHandler: TaskHandler = async (ctx) => {
  const { employees } = await readReviewSignals();
  const review = summariseDesignReview(employees, new Date());
  const generativeCritique = review.insufficient
    ? null
    : await generateDepartmentDraft("hq.design_review", review, { aiEmployeeId: ctx.identity.employeeId });
  if (generativeCritique != null) {
    return {
      ...review,
      generativeCritique,
      generativeNote:
        "Critique generated through the governed hq.design_review seam — an unreviewed draft grounded in the findings above; a human decides what, if anything, changes.",
    };
  }
  return review;
};

export async function enqueueDesignConsistency(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(DESIGN_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: DESIGN_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${DESIGN_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-design-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runDesignTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(DESIGN_AI_SLUG);
  registerTaskHandler(DESIGN_TASK_TYPE, identity, designHandler);
  return normaliseWorkerOutcome(await runReadyTask(DESIGN_TASK_TYPE, designHandler, identity));
}

export async function drainDesignTasks(limit = 1): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(DESIGN_AI_SLUG);
  registerTaskHandler(DESIGN_TASK_TYPE, identity, designHandler);
  const summary = await drainTaskType(DESIGN_TASK_TYPE, designHandler, identity, { maxTasks: limit });
  return { ok: true, ...summary };
}

// ---------------------------------------------------------------------
// design_review — the L9a / P8 contract on the same canonical surface.
// ---------------------------------------------------------------------

export async function enqueueDesignReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(DESIGN_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: DESIGN_REVIEW_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${DESIGN_REVIEW_TASK_TYPE}:${day}`,
    origin: "manual",
  });
  if (!enq.ok) {
    console.error("[hq-design-runner] review enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runDesignReviewTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(DESIGN_AI_SLUG);
  registerTaskHandler(DESIGN_REVIEW_TASK_TYPE, identity, designReviewHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(DESIGN_REVIEW_TASK_TYPE, designReviewHandler, identity),
  );
}

export async function drainDesignReviewTasks(
  limit = 1,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(DESIGN_AI_SLUG);
  registerTaskHandler(DESIGN_REVIEW_TASK_TYPE, identity, designReviewHandler);
  const summary = await drainTaskType(DESIGN_REVIEW_TASK_TYPE, designReviewHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

// ---------------------------------------------------------------------
// Read side — the /admin/design-ai page (board + recent artifacts). Bounded
// SELECT-only reads of the generic queue; writes reach it only via enqueueTask.
// ---------------------------------------------------------------------

export type DesignRunRow = {
  taskId: string;
  taskType: string;
  status: string;
  summary: string | null;
  severity: string | null;
  insufficient: boolean | null;
  createdAt: string | null;
  finishedAt: string | null;
};

type QueueRow = {
  id: string;
  task_type: string;
  status: string;
  result: Record<string, unknown> | null;
  created_at: string | null;
  finished_at: string | null;
};

type QueueRead = {
  select(columns: string): QueueRead;
  in(column: string, values: ReadonlyArray<unknown>): QueueRead;
  order(column: string, options?: { ascending?: boolean }): QueueRead;
  limit(count: number): PromiseLike<{ data: QueueRow[] | null; error: { message: string } | null }>;
};

function toRunRow(r: QueueRow): DesignRunRow {
  const result = r.result ?? null;
  return {
    taskId: r.id,
    taskType: r.task_type,
    status: r.status,
    summary: typeof result?.summary === "string" ? (result.summary as string) : null,
    severity: typeof result?.severity === "string" ? (result.severity as string) : null,
    insufficient: typeof result?.insufficient === "boolean" ? (result.insufficient as boolean) : null,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export type DesignAiOverview = {
  latestConsistency: Record<string, unknown> | null;
  latestReview: Record<string, unknown> | null;
  recent: DesignRunRow[];
};

/** Latest completed artifact per task type + the recent run list, newest first. */
export async function getDesignAiOverview(limit = 12): Promise<DesignAiOverview> {
  const admin = createAdminClient();
  const capped = Math.min(Math.max(limit, 1), 50);
  const { data, error } = await (admin.from("hq_ai_tasks" as never) as unknown as QueueRead)
    .select("id, task_type, status, result, created_at, finished_at")
    .in("task_type", [DESIGN_TASK_TYPE, DESIGN_REVIEW_TASK_TYPE])
    .order("created_at", { ascending: false })
    .limit(capped);
  if (error) throw new Error(`hq-design-runner: overview read failed — ${error.message}`);
  const rows = (data ?? []) as QueueRow[];
  const latestOf = (type: string) =>
    rows.find((r) => r.task_type === type && r.status === "completed" && r.result != null)
      ?.result ?? null;
  return {
    latestConsistency: latestOf(DESIGN_TASK_TYPE),
    latestReview: latestOf(DESIGN_REVIEW_TASK_TYPE),
    recent: rows.map(toRunRow),
  };
}

export { DESIGN_AI_SLUG, DESIGN_TASK_TYPE, DESIGN_REVIEW_TASK_TYPE, designReviewHandler };
