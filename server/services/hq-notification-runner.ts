import "server-only";

/**
 * CrewFlow HQ — Notification AI runner (MP Wave R3).
 *
 * Gives the previously-dark `notification-ai` roster identity REAL deterministic work: it
 * digests the pending (unread) notification backlog by type as a Task-Engine task. It
 * owns NO tables — it drains a `notification_digest` task off the generic Task Engine
 * (hq_ai_tasks) through the canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — a straight count of unread rows grouped by type. NO LLM.
 *   • It COUNTS and REPORTS only: it reads NO title, body, or recipient (no PII), and it
 *     delivers/sends NOTHING — the digest is a backlog picture for a human. No mutation.
 *   • Honest "insufficient" when there are no notifications recorded at all; an empty
 *     backlog over real rows is a genuine "nothing pending", not "insufficient".
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { summariseNotifications, type NotificationRow } from "@/lib/hq/roster-runners";
import { resolveRunnerIdentity } from "@/server/services/hq-runner-identity";
import { enqueueTask } from "@/server/services/hq-tasks";
import {
  drainTaskType,
  registerTaskHandler,
  runReadyTask,
  type DrainSummary,
  type EmployeeIdentity,
  type TaskHandler,
} from "@/server/sdk/tasks";

const NOTIFICATION_AI_SLUG = "notification-ai";
const NOTIFICATION_TASK_TYPE = "notification_digest";

let cachedIdentity: EmployeeIdentity | undefined;
let cachedEmployeeId: string | null | undefined;

async function notificationIdentity(): Promise<{
  identity: EmployeeIdentity;
  employeeId: string | null;
}> {
  if (cachedIdentity !== undefined) {
    return { identity: cachedIdentity, employeeId: cachedEmployeeId ?? null };
  }
  const resolved = await resolveRunnerIdentity(NOTIFICATION_AI_SLUG);
  cachedIdentity = resolved.identity;
  cachedEmployeeId = resolved.employeeId;
  return resolved;
}

/**
 * Read the COMPLETE unread backlog — `type` ONLY (counts, never content), filtered to
 * `read_at is null`, and PAGED in full (F-1) so the count can never silently under-report
 * past a cap. The `(read_at is null)` partial index keeps this cheap even estate-wide.
 * Stable total order (created_at, id) so no row shifts across a page edge.
 */
async function readUnreadNotifications(): Promise<NotificationRow[]> {
  const admin = createAdminClient();
  const res = await fetchAllRows<NotificationRow>(
    (from, to) =>
      admin
        .from("notifications" as never)
        .select("type")
        .is("read_at", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<NotificationRow>>,
  );
  // fetchAllRows is best-effort (partial + error on failure). A partial read would
  // silently under-count, so fail the task loudly instead of reporting a wrong total.
  if (res.error) {
    const message = res.error instanceof Error ? res.error.message : String(res.error);
    throw new Error(`hq-notification-runner: unread read failed — ${message}`);
  }
  return res.data;
}

const notificationTaskHandler: TaskHandler = async () => {
  const rows = await readUnreadNotifications();
  return summariseNotifications(rows, new Date());
};

/** Enqueue one digest task, deduped to the current hour so ticks never pile up. */
export async function enqueueNotificationDigest(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await notificationIdentity();
  if (!employeeId) return { ok: true, skipped: true };
  const hour = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const enq = await enqueueTask({
    taskType: NOTIFICATION_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${NOTIFICATION_TASK_TYPE}:${hour}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-notification-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

/** Claim-one-and-exit: run the next ready digest task through the canonical runner. */
export async function runNotificationTask(): Promise<RunOutcomeSummary> {
  const { identity } = await notificationIdentity();
  registerTaskHandler(NOTIFICATION_TASK_TYPE, identity, notificationTaskHandler);
  const o = await runReadyTask(NOTIFICATION_TASK_TYPE, notificationTaskHandler, identity);
  return normaliseOutcome(o);
}

/** Cron entry point: drain ready digest tasks through the canonical runner. */
export async function drainNotificationTasks(limit = 2): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await notificationIdentity();
  registerTaskHandler(NOTIFICATION_TASK_TYPE, identity, notificationTaskHandler);
  const summary = await drainTaskType(NOTIFICATION_TASK_TYPE, notificationTaskHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export type RunOutcomeSummary =
  | { ok: true; status: "completed" | "skipped"; taskId?: string }
  | { ok: false; status: "failed"; taskId?: string; error: string };

function normaliseOutcome(o: Awaited<ReturnType<typeof runReadyTask>>): RunOutcomeSummary {
  switch (o.status) {
    case "completed":
      return { ok: true, status: "completed", taskId: o.taskId };
    case "empty":
      return { ok: true, status: "skipped" };
    case "failed":
      return { ok: false, status: "failed", taskId: o.taskId, error: o.error };
    case "lease_lost":
      return { ok: false, status: "failed", taskId: o.taskId, error: "lease lost (reaped or re-claimed)" };
    case "error":
      return { ok: false, status: "failed", error: o.error };
  }
}

export { NOTIFICATION_AI_SLUG, NOTIFICATION_TASK_TYPE };
