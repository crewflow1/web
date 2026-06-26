import "server-only";
import {
  claimTask,
  completeTask,
  checkpointTask,
  enqueueTask,
  failTask,
  heartbeatTask,
  type EnqueueTaskInput,
  type TaskRow,
} from "@/server/services/hq-tasks";
import { createMemory, type BoundMemory } from "@/server/sdk/memory";
import type { MemoryScope } from "@/lib/ai-employees/model";

/**
 * CrewFlow HQ — the `ctx.tasks` SDK facet + the canonical task runner
 * (CEO Directive #012 / D-02, PR-C).
 *
 * Bible Volume XII §11.2 (the runner contract) + Volume XIII §21 (the canonical
 * run-loop, and the five runner/handler rules). This is the TypeScript runtime
 * surface over the Generic Task Engine: the single sanctioned way an AI employee
 * drives the durable queue. It does NOT re-implement the queue — it BINDS the
 * service layer (`server/services/hq-tasks.ts`, itself nothing but the seven
 * SECURITY DEFINER entry points) into the run-loop every employee inherits.
 *
 * The five rules it enforces in code (XIII §21):
 *   1. No employee claims from SQL      → only `claimTask` (via the runner) dequeues.
 *   2. No employee writes its own runner → there is exactly one run-loop, here.
 *   3. No handler completes/fails itself → `ctx.tasks` exposes create + checkpoint
 *      ONLY; the runner alone calls completeTask/failTask, off the handler's
 *      return/throw.
 *   4. The runner owns claim, heartbeat, checkpoint, completion, failure, retry.
 *   5. Handlers own business logic only.
 *
 * Minimal RunContext (the CEO-approved PR-C slice): { task, identity, memory,
 * tasks, correlationId, budgetMicros }. It wires exactly two facets — `memory`
 * (the one subsystem already built, Directive 009 PR6) and `tasks` (the engine's
 * own create+checkpoint surface) — and DELIBERATELY omits comms, tools, the API
 * gateway, cost metering, the approval runtime, autonomy and verification. Those
 * are later directives that EXTEND this context; `budgetMicros` is a passthrough
 * of the task's reserved budget, not a meter.
 *
 * Invocation model: claim-one-and-exit (not a long-running loop). A cron tick
 * calls `runEmployee`/`drainTaskType`, which claims ready tasks one at a time and
 * EXITS when the queue drains or a per-tick cap is reached. Crash recovery is the
 * reaper cron (`app/api/cron/task-reaper`), a SYSTEM actor separate from employee
 * runners.
 *
 * No `task.*` events are emitted here — the entry points emit them in-transaction
 * (PR-B). Double-emission would corrupt the audit (ADR-0005).
 */

// ---------------------------------------------------------------------
// Identity & context
// ---------------------------------------------------------------------

/**
 * The employee a runner acts as. Captured once and stamped on everything: the
 * memory facet binds to it (so reads/writes can never be another employee's), the
 * lease owner is derived from it, and `created_by` on spawned tasks carries it.
 */
export interface RunnerIdentity {
  employeeId: string;
  /** Human-readable handle (e.g. `research-ai`) used in lease owner + provenance. */
  slug?: string;
  department?: string | null;
  memoryScope?: MemoryScope;
}

/**
 * The in-handler `ctx.tasks` facet. Bound to BOTH the employee identity and the
 * RUNNING task, so the handler threads neither lease nor task id by hand.
 *
 * It exposes `create` + `checkpoint` ONLY. `complete`/`fail` are absent BY RULE
 * (XIII §21 rule 3): a handler signals success by returning and failure by
 * throwing; the runner performs the lease-guarded terminal transition.
 */
export interface BoundTasks {
  /**
   * Enqueue a follow-up / child task. By default it inherits the running task's
   * `correlationId` (same spine trace) and is parented to it, and is stamped with
   * this employee as `createdBy`; any field may be overridden. Returns the new
   * task id. Throws on failure (the SDK's throw-based ABI).
   */
  create(input: EnqueueTaskInput): Promise<string>;
  /**
   * Persist a partial result for the running task so a re-run resumes from it.
   * Throws if the lease was lost (the handler should stop) or on transport error.
   */
  checkpoint(result: Record<string, unknown>): Promise<void>;
}

/**
 * The minimal RunContext a handler receives (Volume XIII §9, PR-C slice). The
 * facets present are exactly `memory` and `tasks`; everything else listed in §9
 * is a later directive.
 */
export interface RunContext {
  /** The leased task row, as claimed. */
  task: TaskRow;
  /** The employee this run acts as. */
  identity: RunnerIdentity;
  /** The bound memory surface (auto-bound to this task for working/episodic). */
  memory: BoundMemory;
  /** Create follow-up tasks / checkpoint — create + checkpoint only (rule 3). */
  tasks: BoundTasks;
  /** The task's spine trace id — thread it through anything downstream. */
  correlationId: string;
  /** Passthrough of the task's reserved budget (micros). NOT metered here. */
  budgetMicros: number;
}

/**
 * The unit of employee code. Receives the context, does business logic ONLY
 * (rule 5), and signals outcome by its return/throw:
 *   • return a result object (or void) → the runner completes the task with it;
 *   • throw                            → the runner fails the task (retryable
 *     unless it throws {@link NonRetryableError}).
 */
export type TaskHandler = (ctx: RunContext) => Promise<Record<string, unknown> | void>;

/**
 * Throw this from a handler to mark a failure as TERMINAL (no retry) regardless
 * of remaining attempts — e.g. malformed input that a retry cannot fix. A plain
 * `throw` is retryable; the engine still caps retries by `max_retries`.
 */
export class NonRetryableError extends Error {
  readonly retryable = false as const;
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

// ---------------------------------------------------------------------
// Standalone enqueue (any subsystem may create work — XII §11.2)
// ---------------------------------------------------------------------

/**
 * Enqueue a task from anywhere (a cron, a server action, another subsystem) — the
 * non-handler counterpart to `ctx.tasks.create`. Throws on failure. For follow-up
 * work spawned INSIDE a handler, prefer `ctx.tasks.create` (it auto-threads
 * provenance).
 */
export async function createTask(
  input: EnqueueTaskInput,
): Promise<{ id: string; deduped: boolean }> {
  const res = await enqueueTask(input);
  if (!res.ok) throw new Error(`tasks.create failed: ${res.error}`);
  return { id: res.task.id, deduped: res.deduped };
}

// ---------------------------------------------------------------------
// The handler registry (single task_type → handler — CEO decision 3)
// ---------------------------------------------------------------------

interface Registration {
  identity: RunnerIdentity;
  handler: TaskHandler;
}

/** Module-singleton: one handler per task_type. A second register replaces it. */
const REGISTRY = new Map<string, Registration>();

/**
 * Register the handler for a task_type. Exactly one handler per type — the engine
 * is generic over types, the registry (not the DB) knows the code. Re-registering
 * a type replaces it (idempotent bootstrap).
 */
export function registerTaskHandler(
  taskType: string,
  identity: RunnerIdentity,
  handler: TaskHandler,
): void {
  REGISTRY.set(taskType, { identity, handler });
}

/** Look up a registered handler (or undefined). */
export function getTaskHandler(taskType: string): Registration | undefined {
  return REGISTRY.get(taskType);
}

/** All registered task types. */
export function registeredTaskTypes(): string[] {
  return [...REGISTRY.keys()];
}

/** Drop all registrations — test isolation only. */
export function clearTaskHandlers(): void {
  REGISTRY.clear();
}

// ---------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------

export type RunOutcome =
  | { status: "empty" }
  | { status: "completed"; taskId: string }
  | { status: "failed"; taskId: string; retried: boolean; error: string }
  | { status: "lease_lost"; taskId: string }
  | { status: "error"; error: string };

export interface DrainSummary {
  claimed: number;
  completed: number;
  /** Terminal failures (retries exhausted or non-retryable). */
  failed: number;
  /** Failures re-queued for another attempt. */
  retried: number;
  /** Runs whose lease was lost mid-flight (reaped / re-claimed). */
  leaseLost: number;
  /** Claim/transport errors. */
  errors: number;
}

const EMPTY_SUMMARY: DrainSummary = {
  claimed: 0,
  completed: 0,
  failed: 0,
  retried: 0,
  leaseLost: 0,
  errors: 0,
};

export interface RunOptions {
  /** Lease length for the claim; the runner heartbeats at a third of it. */
  leaseSeconds?: number;
}

export interface DrainOptions extends RunOptions {
  /** Max tasks to process this invocation (claim-one-and-exit cap). Default 25. */
  maxTasks?: number;
}

const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_MAX_TASKS = 25;

// ---------------------------------------------------------------------
// The facet + context assembly
// ---------------------------------------------------------------------

/** A short, opaque, unique lease owner for one runner invocation. */
function mintLeaseOwner(identity: RunnerIdentity): string {
  const who = identity.slug ?? identity.employeeId;
  return `runner:${who}:${crypto.randomUUID()}`;
}

/** Build the in-handler `ctx.tasks` facet, bound to the running task + lease. */
function createTasks(
  identity: RunnerIdentity,
  task: TaskRow,
  leaseOwner: string,
): BoundTasks {
  const createdBy = identity.slug ?? identity.employeeId;
  return {
    async create(input: EnqueueTaskInput): Promise<string> {
      const res = await enqueueTask({
        ...input,
        // Auto-thread provenance: a task spawned by a task is its child in the
        // same trace, attributed to this employee — unless explicitly overridden.
        parentTaskId: input.parentTaskId ?? task.id,
        correlationId: input.correlationId ?? task.correlation_id,
        createdBy: input.createdBy ?? createdBy,
      });
      if (!res.ok) throw new Error(`ctx.tasks.create failed: ${res.error}`);
      return res.task.id;
    },
    async checkpoint(result: Record<string, unknown>): Promise<void> {
      const res = await checkpointTask(task.id, leaseOwner, result);
      if (!res.ok) throw new Error(`ctx.tasks.checkpoint failed: ${res.error}`);
      if (!res.alive) throw new Error("ctx.tasks.checkpoint: lease lost");
    },
  };
}

/** Assemble the minimal RunContext for a claimed task. */
function buildContext(
  identity: RunnerIdentity,
  task: TaskRow,
  leaseOwner: string,
): RunContext {
  const memory: BoundMemory = createMemory({
    employeeId: identity.employeeId,
    department: identity.department,
    memoryScope: identity.memoryScope,
    currentTaskId: task.id,
  });
  return {
    task,
    identity,
    memory,
    tasks: createTasks(identity, task, leaseOwner),
    correlationId: task.correlation_id,
    budgetMicros: task.cost_budget_micros ?? 0,
  };
}

// ---------------------------------------------------------------------
// The run-loop (rule 4: the runner owns the whole lifecycle mechanism)
// ---------------------------------------------------------------------

/**
 * Run ONE claimed task to a terminal transition. The handler does business logic;
 * THIS function owns the lease, the heartbeat, and the complete/fail decision —
 * the handler never touches them (rules 3 & 4).
 */
async function runClaimedTask(
  task: TaskRow,
  handler: TaskHandler,
  identity: RunnerIdentity,
  leaseOwner: string,
  leaseSeconds: number,
): Promise<RunOutcome> {
  const ctx = buildContext(identity, task, leaseOwner);

  // Heartbeat at a third of the lease, best-effort. `unref` so the timer never
  // keeps the process (or a serverless invocation) alive on its own.
  const everyMs = Math.max(1, Math.floor(leaseSeconds / 3)) * 1000;
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    void heartbeatTask(task.id, leaseOwner, leaseSeconds).catch(() => {});
  }, everyMs);
  if (typeof timer.unref === "function") timer.unref();

  let result: Record<string, unknown> | void;
  try {
    result = await handler(ctx);
  } catch (err) {
    clearInterval(timer);
    const retryable = !(err instanceof NonRetryableError);
    const message = err instanceof Error ? err.message : String(err);
    const failed = await failTask(task.id, leaseOwner, message, retryable);
    if (!failed.ok) {
      if (failed.reason === "lease_lost") return { status: "lease_lost", taskId: task.id };
      return { status: "error", error: failed.error };
    }
    // The engine decided retry vs terminal: a re-queued task is back to 'pending'.
    const retried = failed.task.status === "pending";
    return { status: "failed", taskId: task.id, retried, error: message };
  }
  clearInterval(timer);

  const completed = await completeTask(task.id, leaseOwner, result ?? null);
  if (!completed.ok) {
    if (completed.reason === "lease_lost") return { status: "lease_lost", taskId: task.id };
    return { status: "error", error: completed.error };
  }
  return { status: "completed", taskId: task.id };
}

/**
 * Claim and run AT MOST ONE ready task of `taskType` (claim-one-and-exit). Returns
 * `{ status: "empty" }` when nothing was ready.
 */
export async function runReadyTask(
  taskType: string,
  handler: TaskHandler,
  identity: RunnerIdentity,
  opts: RunOptions = {},
): Promise<RunOutcome> {
  const leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const leaseOwner = mintLeaseOwner(identity);

  const claim = await claimTask(taskType, leaseOwner, leaseSeconds);
  if (!claim.ok) return { status: "error", error: claim.error };
  if (claim.task === null) return { status: "empty" };

  return runClaimedTask(claim.task, handler, identity, leaseOwner, leaseSeconds);
}

/** Fold one outcome into the running summary. */
function tally(summary: DrainSummary, outcome: RunOutcome): void {
  switch (outcome.status) {
    case "completed":
      summary.claimed++;
      summary.completed++;
      break;
    case "failed":
      summary.claimed++;
      if (outcome.retried) summary.retried++;
      else summary.failed++;
      break;
    case "lease_lost":
      summary.claimed++;
      summary.leaseLost++;
      break;
    case "error":
      summary.errors++;
      break;
    case "empty":
      break;
  }
}

/**
 * Drain ready tasks of one type, one at a time, until the queue empties or
 * `maxTasks` is reached — then EXIT (the cron-tick model). A transport error
 * stops the drain (the next tick retries).
 */
export async function drainTaskType(
  taskType: string,
  handler: TaskHandler,
  identity: RunnerIdentity,
  opts: DrainOptions = {},
): Promise<DrainSummary> {
  const max = opts.maxTasks ?? DEFAULT_MAX_TASKS;
  const summary: DrainSummary = { ...EMPTY_SUMMARY };

  for (let i = 0; i < max; i++) {
    const outcome = await runReadyTask(taskType, handler, identity, opts);
    tally(summary, outcome);
    if (outcome.status === "empty" || outcome.status === "error") break;
  }
  return summary;
}

export interface RunEmployeeOptions extends DrainOptions {
  identity: RunnerIdentity;
  /**
   * Task types to drain this tick. Each must have a registered handler (the
   * identity passed here takes precedence over the one captured at registration,
   * so a runner can act as itself). Absent ⇒ every registered type.
   */
  taskTypes?: string[];
}

/**
 * The cron-tick entry point: drain each of an employee's task types this
 * invocation, then exit. Resolves handlers from the registry. A type with no
 * registered handler is skipped (counted as an error) rather than throwing, so
 * one mis-wired type never sinks the whole tick.
 */
export async function runEmployee(opts: RunEmployeeOptions): Promise<DrainSummary> {
  const types = opts.taskTypes ?? registeredTaskTypes();
  const summary: DrainSummary = { ...EMPTY_SUMMARY };

  for (const taskType of types) {
    const reg = getTaskHandler(taskType);
    if (!reg) {
      summary.errors++;
      continue;
    }
    const partial = await drainTaskType(taskType, reg.handler, opts.identity, opts);
    summary.claimed += partial.claimed;
    summary.completed += partial.completed;
    summary.failed += partial.failed;
    summary.retried += partial.retried;
    summary.leaseLost += partial.leaseLost;
    summary.errors += partial.errors;
  }
  return summary;
}
