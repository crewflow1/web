import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * CrewFlow HQ — Generic Task Engine data access (CEO Directive #012 / D-02, PR-C).
 *
 * The service-layer binding for the durable AI work queue (`hq_ai_tasks`,
 * migration 20260802000000). It is the TypeScript half of the engine's standing
 * security posture: the queue is touched ONLY through the eight SECURITY DEFINER
 * entry points — create / claim / heartbeat / checkpoint / complete / fail / reap
 * (Volume XII §11.1) and cancel (D-03) — never by a raw `insert`/`update` on the
 * table. This
 * module makes that the only thing it CAN do: every function here is an `.rpc()`
 * call, and the source-analysis security test
 * (`__tests__/security/task-engine-spine.test.ts`) fails CI if any `.from(
 * 'hq_ai_tasks')` mutation is ever introduced in `server/` or `app/`.
 *
 * Service-role client only. `hq_ai_tasks` is RLS:hq (RLS enabled, ZERO policies),
 * so every call here is invisible to any JWT client; the entry points additionally
 * `REVOKE EXECUTE` from anon/authenticated and `GRANT` only to `service_role`.
 *
 * This is data access, NOT the runner. The runner (`server/sdk/tasks.ts`) composes
 * these primitives into the canonical run-loop (claim → run handler → complete |
 * fail, heartbeating throughout). Mirrors `hq-memory.ts`: a tiny typed `callRpc`
 * shim over the (still-untyped) RPC builder, results returned as discriminated
 * unions in the house `{ ok }` ABI. The spine `task.*` events are emitted INSIDE
 * the entry points (PR-B); nothing here emits — double-emission would corrupt the
 * audit (ADR-0005).
 */

// ---------------------------------------------------------------------
// The row shape. `hq_ai_tasks` is not in the generated Supabase types
// (lib/supabase/types.ts has zero hq_ai references), so — exactly as
// hq-memory.ts does for the hq_memory* tables — the shape is declared by
// hand here. Every entry point returns the FULL row via `to_jsonb(v_row)`,
// so this mirrors the table DDL column-for-column.
// ---------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked"
  | "claimed"
  | "waiting_approval"
  | "verifying";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

/** One row of `hq_ai_tasks`, as it returns over PostgREST (`to_jsonb(row)`). */
export interface TaskRow {
  id: string;
  task_type: string;
  assigned_employee_id: string | null;
  required_capability: string | null;
  subject_kind: string;
  subject_id: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  priority_rank: number;
  retry_count: number;
  max_retries: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  parent_task_id: string | null;
  depends_on: string[] | null;
  scheduled_at: string | null;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  deadline_at: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  approval_status: string | null;
  cost_micros: number | null;
  cost_budget_micros: number | null;
  error_message: string | null;
  correlation_id: string;
  dedupe_key: string | null;
  origin: string;
  created_by: string | null;
  /**
   * The Master-Plan PRODUCT pipeline stage (idea…review) — orthogonal to `status`
   * (the EXECUTION lifecycle). Nullable: a task may be unstaged. Added by migration
   * 20261094000000; moved only via `setTaskStage` (the hq_ai_task_set_stage RPC).
   */
  pipeline_stage: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------
// Result unions (the house `{ ok }` ABI). `reason: "error"` marks a
// transport/RPC failure; the engine's own outcomes carry their own
// reasons ("empty" from claim, "lease_lost" from complete/fail) so a
// caller can branch on them without parsing strings.
// ---------------------------------------------------------------------

/** A transport/RPC failure, shared by every entry point. */
export type TaskRpcError = { ok: false; reason: "error"; error: string };

/** `enqueueTask` — the task was created (or an equivalent live one returned). */
export type EnqueueResult =
  | { ok: true; task: TaskRow; deduped: boolean }
  | TaskRpcError;

/** `claimTask` — a task was leased (`task`), the queue was empty (`task: null`). */
export type ClaimResult =
  | { ok: true; task: TaskRow }
  | { ok: true; task: null }
  | TaskRpcError;

/** `heartbeatTask` / `checkpointTask` — `alive: false` means the lease was lost. */
export type LeaseGuardResult = { ok: true; alive: boolean } | TaskRpcError;

/** `completeTask` / `failTask` — terminal transition, or the lease was lost. */
export type TerminalResult =
  | { ok: true; task: TaskRow }
  | { ok: false; reason: "lease_lost" }
  | TaskRpcError;

/** `cancelTask` — pending|running → cancelled, or the task was not cancellable. */
export type CancelResult =
  | { ok: true; task: TaskRow }
  | { ok: false; reason: "not_cancellable" }
  | TaskRpcError;

/** `reapTasks` — how many expired-lease tasks were recovered. */
export type ReapResult = { ok: true; reaped: number } | TaskRpcError;

/** The eleven Master-Plan product pipeline stages (see migration 20261094000000). */
export type PipelineStage =
  | "idea"
  | "research"
  | "specification"
  | "design"
  | "engineering"
  | "testing"
  | "documentation"
  | "marketing"
  | "sales"
  | "deployment"
  | "review";

/**
 * `setTaskStage` — the stage moved (`task`), or the move was refused: `invalid_stage`
 * (not one of the eleven) or `not_updatable` (no such task, or it is terminal/frozen).
 */
export type SetStageResult =
  | { ok: true; task: TaskRow }
  | { ok: false; reason: "invalid_stage" | "not_updatable" }
  | TaskRpcError;

// ---------------------------------------------------------------------
// The typed RPC shim — identical idiom to hq-memory.ts. `.bind(admin)` is
// REQUIRED: supabase-js's `rpc()` delegates to `this.rest`, so a detached
// reference throws "Cannot read properties of undefined (reading 'rest')".
// The cast loosens the (untyped) function names; the result is read back
// as the scalar/jsonb the function yields.
// ---------------------------------------------------------------------

type AdminClient = ReturnType<typeof createAdminClient>;
type DbError = { message: string } | null;
type RpcResult<T> = { data: T | null; error: DbError };

async function callRpc<T>(
  admin: AdminClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<RpcResult<T>> {
  const rpc = admin.rpc.bind(admin) as unknown as (
    f: string,
    a: Record<string, unknown>,
  ) => PromiseLike<RpcResult<T>>;
  const { data, error } = await rpc(fn, args);
  return { data, error };
}

/** The jsonb envelope the create/claim/complete/fail functions return. */
type TaskEnvelope = {
  ok?: boolean;
  task?: TaskRow | null;
  deduped?: boolean;
  reason?: string;
};

// ---------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------

export interface EnqueueTaskInput {
  taskType: string;
  payload?: Record<string, unknown>;
  subjectKind?: string;
  subjectId?: string | null;
  priority?: TaskPriority;
  maxRetries?: number;
  /** ISO timestamp — defer a pending task; null/absent = run as soon as ready. */
  scheduledAt?: string | null;
  dedupeKey?: string | null;
  assignedEmployeeId?: string | null;
  requiredCapability?: string | null;
  parentTaskId?: string | null;
  dependsOn?: string[] | null;
  /** Thread this task into an existing spine trace; absent = a fresh trace. */
  correlationId?: string | null;
  origin?: string;
  createdBy?: string | null;
}

// ---------------------------------------------------------------------
// The eight entry points — each a thin, typed wrapper over its RPC.
// ---------------------------------------------------------------------

/**
 * Enqueue a task (`hq_ai_task_create`). Idempotent over a live `dedupeKey`: a
 * pending/running task with the same key is returned (`deduped: true`) rather
 * than duplicated. Returns the created (or equivalent live) row.
 */
export async function enqueueTask(input: EnqueueTaskInput): Promise<EnqueueResult> {
  const admin = createAdminClient();
  const { data, error } = await callRpc<TaskEnvelope>(admin, "hq_ai_task_create", {
    p_task_type: input.taskType,
    p_payload: input.payload ?? {},
    p_subject_kind: input.subjectKind ?? "none",
    p_subject_id: input.subjectId ?? null,
    p_priority: input.priority ?? "normal",
    p_max_retries: input.maxRetries ?? 3,
    p_scheduled_at: input.scheduledAt ?? null,
    p_dedupe_key: input.dedupeKey ?? null,
    p_assigned_employee_id: input.assignedEmployeeId ?? null,
    p_required_capability: input.requiredCapability ?? null,
    p_parent_task_id: input.parentTaskId ?? null,
    p_depends_on: input.dependsOn ?? null,
    p_correlation_id: input.correlationId ?? null,
    p_origin: input.origin ?? "manual",
    p_created_by: input.createdBy ?? null,
  });

  if (error) return { ok: false, reason: "error", error: error.message };
  if (!data || data.ok !== true || !data.task) {
    return { ok: false, reason: "error", error: "hq_ai_task_create: malformed response" };
  }
  return { ok: true, task: data.task, deduped: data.deduped === true };
}

/**
 * Claim the next ready task of a type (`hq_ai_task_claim`) — the atomic dequeue
 * (FOR UPDATE SKIP LOCKED), stamping the lease. `task: null` means the queue is
 * empty (an explicit "nothing to do", not an error).
 */
export async function claimTask(
  taskType: string,
  leaseOwner: string,
  leaseSeconds = 300,
): Promise<ClaimResult> {
  const admin = createAdminClient();
  const { data, error } = await callRpc<TaskEnvelope>(admin, "hq_ai_task_claim", {
    p_task_type: taskType,
    p_lease_owner: leaseOwner,
    p_lease_seconds: leaseSeconds,
  });

  if (error) return { ok: false, reason: "error", error: error.message };
  if (data?.ok === true && data.task) return { ok: true, task: data.task };
  if (data?.ok === false && data.reason === "empty") return { ok: true, task: null };
  return { ok: false, reason: "error", error: "hq_ai_task_claim: malformed response" };
}

/**
 * Extend the lease (`hq_ai_task_heartbeat`). `alive: false` means the lease was
 * lost (reaped or re-claimed) and the worker should abort cleanly.
 */
export async function heartbeatTask(
  taskId: string,
  leaseOwner: string,
  leaseSeconds = 300,
): Promise<LeaseGuardResult> {
  const admin = createAdminClient();
  const { data, error } = await callRpc<boolean>(admin, "hq_ai_task_heartbeat", {
    p_task_id: taskId,
    p_lease_owner: leaseOwner,
    p_lease_seconds: leaseSeconds,
  });
  if (error) return { ok: false, reason: "error", error: error.message };
  return { ok: true, alive: data === true };
}

/**
 * Persist a partial result mid-run (`hq_ai_task_checkpoint`) so a re-run resumes
 * from the last good state. Lease-guarded; `alive: false` means the lease was lost.
 */
export async function checkpointTask(
  taskId: string,
  leaseOwner: string,
  result: Record<string, unknown>,
): Promise<LeaseGuardResult> {
  const admin = createAdminClient();
  const { data, error } = await callRpc<boolean>(admin, "hq_ai_task_checkpoint", {
    p_task_id: taskId,
    p_lease_owner: leaseOwner,
    p_result: result,
  });
  if (error) return { ok: false, reason: "error", error: error.message };
  return { ok: true, alive: data === true };
}

/**
 * Finish a task successfully (`hq_ai_task_complete`). Lease-guarded; clears the
 * lease. `reason: "lease_lost"` means the lease was lost or the task is already
 * terminal — the worker should stop, not retry.
 */
export async function completeTask(
  taskId: string,
  leaseOwner: string,
  result?: Record<string, unknown> | null,
): Promise<TerminalResult> {
  const admin = createAdminClient();
  const { data, error } = await callRpc<TaskEnvelope>(admin, "hq_ai_task_complete", {
    p_task_id: taskId,
    p_lease_owner: leaseOwner,
    p_result: result ?? null,
  });

  if (error) return { ok: false, reason: "error", error: error.message };
  if (data?.ok === true && data.task) return { ok: true, task: data.task };
  if (data?.ok === false && data.reason === "lease_lost") return { ok: false, reason: "lease_lost" };
  return { ok: false, reason: "error", error: "hq_ai_task_complete: malformed response" };
}

/**
 * Record a failure (`hq_ai_task_fail`). If `retryable` and retries remain, the
 * task is re-queued with exponential backoff; otherwise it becomes terminally
 * failed. Lease-guarded; `reason: "lease_lost"` means the lease was lost.
 */
export async function failTask(
  taskId: string,
  leaseOwner: string,
  errorMessage: string,
  retryable = true,
): Promise<TerminalResult> {
  const admin = createAdminClient();
  const { data, error } = await callRpc<TaskEnvelope>(admin, "hq_ai_task_fail", {
    p_task_id: taskId,
    p_lease_owner: leaseOwner,
    p_error: errorMessage,
    p_retryable: retryable,
  });

  if (error) return { ok: false, reason: "error", error: error.message };
  if (data?.ok === true && data.task) return { ok: true, task: data.task };
  if (data?.ok === false && data.reason === "lease_lost") return { ok: false, reason: "lease_lost" };
  return { ok: false, reason: "error", error: "hq_ai_task_fail: malformed response" };
}

/** Options for {@link cancelTask}: the audit reason and the acting identity. */
export interface CancelTaskOptions {
  /** Free-text reason, recorded on the row and in the `task.cancelled` event. */
  reason?: string | null;
  /** Who is cancelling — the spine `actor_type` (defaults to `system`). */
  actorType?: string;
  /** Who is cancelling — the spine `actor_id` (defaults to null/system). */
  actorId?: string | null;
}

/**
 * Cancel a live task (`hq_ai_task_cancel`): pending|running → cancelled, clearing the
 * lease so the worker's next heartbeat returns `alive:false` (cooperative
 * cancellation). NOT lease-guarded — cancel acts on a task from OUTSIDE its worker
 * (an operator/parent/OS), so it carries an explicit actor for the audit instead of a
 * lease. `reason: "not_cancellable"` means the task was already terminal — an
 * idempotent no-op, not an error.
 */
export async function cancelTask(
  taskId: string,
  opts: CancelTaskOptions = {},
): Promise<CancelResult> {
  const admin = createAdminClient();
  const { data, error } = await callRpc<TaskEnvelope>(admin, "hq_ai_task_cancel", {
    p_task_id: taskId,
    p_reason: opts.reason ?? null,
    p_actor_type: opts.actorType ?? "system",
    p_actor_id: opts.actorId ?? null,
  });

  if (error) return { ok: false, reason: "error", error: error.message };
  if (data?.ok === true && data.task) return { ok: true, task: data.task };
  if (data?.ok === false && data.reason === "not_cancellable") {
    return { ok: false, reason: "not_cancellable" };
  }
  return { ok: false, reason: "error", error: "hq_ai_task_cancel: malformed response" };
}

/**
 * Recover tasks whose lease has expired (`hq_ai_task_reap`) — each treated as a
 * retryable failure (re-queued with backoff if retries remain, else failed).
 * `taskType` null/absent reaps across all types. Returns the count recovered.
 */
export async function reapTasks(
  taskType?: string | null,
  limit = 50,
): Promise<ReapResult> {
  const admin = createAdminClient();
  const { data, error } = await callRpc<number>(admin, "hq_ai_task_reap", {
    p_task_type: taskType ?? null,
    p_limit: limit,
  });
  if (error) return { ok: false, reason: "error", error: error.message };
  return { ok: true, reaped: typeof data === "number" ? data : 0 };
}

/**
 * Move a task along the PRODUCT pipeline (`hq_ai_task_set_stage`) — the ONE sanctioned
 * write path for `pipeline_stage`, mirroring the engine's function-entry-point design.
 * The stage axis is orthogonal to `status`: this never changes the execution lifecycle.
 * Refused on a terminal (frozen) task (`not_updatable`) or an unknown stage
 * (`invalid_stage`). Each successful move appends to the append-only
 * `hq_ai_task_stage_events` history via the DB trigger.
 */
export async function setTaskStage(
  taskId: string,
  stage: PipelineStage,
): Promise<SetStageResult> {
  const admin = createAdminClient();
  const { data, error } = await callRpc<TaskEnvelope>(admin, "hq_ai_task_set_stage", {
    p_task_id: taskId,
    p_stage: stage,
  });

  if (error) return { ok: false, reason: "error", error: error.message };
  if (data?.ok === true && data.task) return { ok: true, task: data.task };
  if (data?.ok === false && (data.reason === "invalid_stage" || data.reason === "not_updatable")) {
    return { ok: false, reason: data.reason };
  }
  return { ok: false, reason: "error", error: "hq_ai_task_set_stage: malformed response" };
}
