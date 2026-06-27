import "server-only";
import {
  claimTask,
  completeTask,
  checkpointTask,
  enqueueTask,
  failTask,
  heartbeatTask,
  cancelTask as cancelTaskRpc,
  type CancelTaskOptions,
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
 * service layer (`server/services/hq-tasks.ts`, itself nothing but the eight
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
 * RunContext — the per-invocation Runtime Contract (CEO Directive #013 / D-03; ADR
 * 0007). D-03 graduates it from the PR-C slice to Established: { task, identity,
 * memory, tasks, correlationId, budget, deadline, signal, capabilities }. It wires
 * the same two facets — `memory` (Directive 009 PR6) and `tasks` (the engine's own
 * create+checkpoint surface) — and DELIBERATELY omits comms, tools, the API gateway,
 * cost metering, the approval runtime, autonomy and verification (later directives
 * that EXTEND this context). The D-03 additions BIND seams the Task Engine already
 * reserved: `budget`/`deadline` expose `cost_budget_micros`/`deadline_at` read-only,
 * `signal` aborts on cancellation or deadline, and `capabilities` threads the
 * employee's opaque tokens — exposed, never enforced or metered here. The OS owns
 * execution state; the assembled context is FROZEN and handlers only consume it.
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
 * The employee a run acts as — the canonical runtime identity (ADR 0007, Decision 5;
 * `RunnerIdentity` is renamed here so there is ONE settled name). Captured once and
 * stamped on everything: the memory facet binds to it (so reads/writes can never be
 * another employee's), the lease owner is derived from it, `created_by` on spawned
 * tasks carries it, and `ctx.capabilities` is resolved from it.
 *
 * `slug` is REQUIRED (no longer optional): D-03 settles it as the canonical runtime
 * handle the runner stamps as the spine actor and the lease owner, always present and
 * equal to the employee's spec/SDK slug — the qualification three-way split resolved
 * in favour of the slug already on the row, not a re-stamp.
 */
export interface EmployeeIdentity {
  employeeId: string;
  /** Canonical runtime handle (e.g. `research-ai`): spine actor, lease owner, provenance. */
  slug: string;
  department?: string | null;
  memoryScope?: MemoryScope;
  /**
   * The opaque capability tokens this employee holds, resolved once at identity
   * assembly (see {@link resolveEmployeeCapabilities}). Optional on the identity so a
   * caller may omit it; the runner defaults `ctx.capabilities` to
   * {@link EMPTY_CAPABILITIES} when absent. D-03 only THREADS it; the AI SDK (D-04)
   * enforces and the Capability Registry (D-05) sources it.
   */
  capabilities?: ResolvedCapabilitySet;
}

// ---------------------------------------------------------------------
// Capabilities — opaque, read-only, source-indifferent (ADR 0007, Decision 7)
// ---------------------------------------------------------------------

/**
 * The capability tokens an employee holds, as RunContext exposes them: an OPAQUE,
 * READ-ONLY, source-indifferent set. D-03 only THREADS it onto `ctx.capabilities` —
 * it does NOT interpret, match, or enforce a token (that is the AI SDK, D-04), and it
 * does NOT decide where tokens come from (that is the Capability Registry, D-05).
 * `source` records where this set was resolved, so the D-05 swap from the employee
 * row to the registry is observable WITHOUT changing the contract a handler sees.
 */
export interface ResolvedCapabilitySet {
  readonly tokens: readonly string[];
  readonly source: "ai_employees" | "registry" | "none";
}

/** The empty capability set — the safe, frozen default when an identity carries none. */
export const EMPTY_CAPABILITIES: ResolvedCapabilitySet = Object.freeze({
  tokens: Object.freeze([]) as readonly string[],
  source: "none",
});

/**
 * Resolve an employee's capability tokens from the ONE source D-03 is allowed to read
 * — the `ai_employees` row itself: the union of `tools_allowed` and
 * `permissions.scopes`. Structurally typed (NOT bound to the `AiEmployee` model) so
 * the SDK keeps no dependency on the employee module, and so D-05 can repoint the
 * source to the Capability Registry by changing ONLY this function — the
 * {@link ResolvedCapabilitySet} every handler sees stays byte-for-byte identical.
 * Tokens are de-duplicated and sorted for a stable, comparable set.
 */
export function resolveEmployeeCapabilities(emp: {
  tools_allowed?: readonly string[] | null;
  permissions?: { scopes?: readonly string[] | null } | null;
}): ResolvedCapabilitySet {
  const tokens = new Set<string>();
  for (const t of emp.tools_allowed ?? []) {
    if (typeof t === "string" && t.length > 0) tokens.add(t);
  }
  for (const s of emp.permissions?.scopes ?? []) {
    if (typeof s === "string" && s.length > 0) tokens.add(s);
  }
  if (tokens.size === 0) return EMPTY_CAPABILITIES;
  return Object.freeze({
    tokens: Object.freeze([...tokens].sort()) as readonly string[],
    source: "ai_employees",
  });
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
 * The RunContext a handler receives — the per-invocation Runtime Contract D-03
 * graduates to Established (CEO Directive #013; ADR 0007). The runner assembles it at
 * claim and hands it to the handler as its SOLE argument; it is FROZEN
 * (`Object.freeze`) so identity, correlationId, budget, deadline, signal and
 * capabilities are stable for the whole invocation. The facets present are `memory`
 * and `tasks`; comms, tools, the API gateway, cost metering, the approval runtime,
 * autonomy and verification remain later directives that EXTEND this context.
 *
 * Execution-state ownership (ADR 0007): the OS / Task Engine OWNS cancellation,
 * deadlines, budget, leases and retries. RunContext only EXPOSES them read-only; a
 * handler CONSUMES them (awaits `signal`, reads `deadline`/`budget`/`capabilities`)
 * and never owns or mutates them.
 */
export interface RunContext {
  /** The leased task row, as claimed. */
  task: TaskRow;
  /** The employee this run acts as (canonical runtime identity). */
  identity: EmployeeIdentity;
  /** The bound memory surface (auto-bound to this task for working/episodic). */
  memory: BoundMemory;
  /** Create follow-up tasks / checkpoint — create + checkpoint only (rule 3). */
  tasks: BoundTasks;
  /** The task's spine trace id — thread it through anything downstream. */
  correlationId: string;
  /**
   * Read-only ceiling of the task's reserved budget, in micros (0 if none was
   * reserved) — a passthrough the handler may inspect, NOT a meter and not enforced
   * here. Binds the `cost_budget_micros` seam (metering is a later directive).
   */
  budget: number;
  /**
   * The task's hard deadline as a `Date`, or `null` if it has none. Set by the OS
   * from the `deadline_at` seam; read-only. `signal` aborts when it passes.
   */
  deadline: Date | null;
  /**
   * Aborts when the OS stops this invocation — the task was cancelled
   * (`hq_ai_task_cancel`, observed via the heartbeat) OR its `deadline` passed. A
   * monotonic, one-way latch the handler COOPERATES with (pass it to `fetch`, await
   * it, or check `signal.aborted`); the lease+reaper is the backstop if it does not.
   * The runner owns the underlying controller — the handler only ever sees this
   * read-only signal.
   */
  signal: AbortSignal;
  /**
   * The opaque, read-only capability tokens this employee holds (D-03 threads them;
   * D-04 enforces; D-05 sources them). {@link EMPTY_CAPABILITIES} when none.
   */
  capabilities: ResolvedCapabilitySet;
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

/**
 * Cancel a task from anywhere (an operator action, a parent task, the OS supervising
 * a budget/deadline) — the standalone counterpart to `createTask`. There is
 * deliberately NO `ctx.tasks.cancel`: cancellation is the OS acting ON a task from
 * OUTSIDE its worker (ADR 0007), never a handler cancelling itself. It transitions
 * pending|running → cancelled and clears the lease, so the running worker's next
 * heartbeat returns `alive:false` and the runner aborts `ctx.signal` (cooperative
 * cancellation). Returns `{ cancelled }` — `false` is the idempotent no-op when the
 * task was already terminal. Throws only on transport error.
 */
export async function cancelTask(
  taskId: string,
  opts: CancelTaskOptions = {},
): Promise<{ cancelled: boolean; task: TaskRow | null }> {
  const res = await cancelTaskRpc(taskId, opts);
  if (res.ok) return { cancelled: true, task: res.task };
  if (res.reason === "not_cancellable") return { cancelled: false, task: null };
  throw new Error(`tasks.cancel failed: ${res.error}`);
}

// ---------------------------------------------------------------------
// The handler registry (single task_type → handler — CEO decision 3)
// ---------------------------------------------------------------------

interface Registration {
  identity: EmployeeIdentity;
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
  identity: EmployeeIdentity,
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
function mintLeaseOwner(identity: EmployeeIdentity): string {
  const who = identity.slug ?? identity.employeeId;
  return `runner:${who}:${crypto.randomUUID()}`;
}

/** Build the in-handler `ctx.tasks` facet, bound to the running task + lease. */
function createTasks(
  identity: EmployeeIdentity,
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

/**
 * Assemble the RunContext for a claimed task and FREEZE it (ADR 0007 immutability).
 * `signal` and `deadline` are supplied by the runner, which owns their lifecycle —
 * the context only EXPOSES them. Freezing pins the contract fields for the whole
 * invocation; the `memory`/`tasks` facets stay callable (their methods are untouched).
 */
function buildContext(
  identity: EmployeeIdentity,
  task: TaskRow,
  leaseOwner: string,
  signal: AbortSignal,
  deadline: Date | null,
): RunContext {
  const memory: BoundMemory = createMemory({
    employeeId: identity.employeeId,
    department: identity.department,
    memoryScope: identity.memoryScope,
    currentTaskId: task.id,
  });
  const ctx: RunContext = {
    task,
    identity,
    memory,
    tasks: createTasks(identity, task, leaseOwner),
    correlationId: task.correlation_id,
    budget: task.cost_budget_micros ?? 0,
    deadline,
    signal,
    capabilities: identity.capabilities ?? EMPTY_CAPABILITIES,
  };
  return Object.freeze(ctx);
}

// ---------------------------------------------------------------------
// The run-loop (rule 4: the runner owns the whole lifecycle mechanism)
// ---------------------------------------------------------------------

/**
 * Run ONE claimed task to a terminal transition. The handler does business logic;
 * THIS function owns the lease, the heartbeat, the cancellation/deadline signal, and
 * the complete/fail decision — the handler never touches them (rules 3 & 4; ADR 0007
 * execution-state ownership). It holds the AbortController; the handler only ever
 * sees the read-only `ctx.signal`.
 */
async function runClaimedTask(
  task: TaskRow,
  handler: TaskHandler,
  identity: EmployeeIdentity,
  leaseOwner: string,
  leaseSeconds: number,
): Promise<RunOutcome> {
  // The one signal the handler cooperates with — aborted on EITHER cause below.
  const controller = new AbortController();
  const deadline = task.deadline_at ? new Date(task.deadline_at) : null;
  const ctx = buildContext(identity, task, leaseOwner, controller.signal, deadline);

  // Deadline → signal. Abort when the task's hard deadline passes (already-past ⇒
  // abort before the handler runs). `unref` so it never holds a serverless
  // invocation open; a deadline beyond the 32-bit timer horizon gets no per-run timer
  // (the lease and reaper bound the run long before then — `ctx.deadline` still
  // exposes the value).
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (deadline) {
    const ms = deadline.getTime() - Date.now();
    if (ms <= 0) {
      controller.abort(new DOMException("Task deadline exceeded", "TimeoutError"));
    } else if (ms <= 2_147_483_647) {
      deadlineTimer = setTimeout(() => {
        controller.abort(new DOMException("Task deadline exceeded", "TimeoutError"));
      }, ms);
      if (typeof deadlineTimer.unref === "function") deadlineTimer.unref();
    }
  }

  // Heartbeat at a third of the lease, best-effort — AND the cancellation detector.
  // `hq_ai_task_cancel` clears the lease, so the next heartbeat matches zero rows and
  // returns `alive:false`; the runner then aborts the signal (cooperative
  // cancellation, with NO extra query). `unref` so the timer never keeps the process
  // (or a serverless invocation) alive on its own.
  const everyMs = Math.max(1, Math.floor(leaseSeconds / 3)) * 1000;
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    void heartbeatTask(task.id, leaseOwner, leaseSeconds)
      .then((res) => {
        if (res.ok && !res.alive && !controller.signal.aborted) {
          controller.abort(new DOMException("Task cancelled (lease lost)", "AbortError"));
        }
      })
      .catch(() => {});
  }, everyMs);
  if (typeof timer.unref === "function") timer.unref();

  const cleanup = () => {
    clearInterval(timer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  };

  let result: Record<string, unknown> | void;
  try {
    result = await handler(ctx);
  } catch (err) {
    cleanup();
    const retryable = !(err instanceof NonRetryableError);
    const message = err instanceof Error ? err.message : String(err);
    const failed = await failTask(task.id, leaseOwner, message, retryable);
    if (!failed.ok) {
      // A cancelled task already cleared the lease, so fail finds no running row —
      // the cancelled state stands and the runner simply reports the lost lease.
      if (failed.reason === "lease_lost") return { status: "lease_lost", taskId: task.id };
      return { status: "error", error: failed.error };
    }
    // The engine decided retry vs terminal: a re-queued task is back to 'pending'.
    const retried = failed.task.status === "pending";
    return { status: "failed", taskId: task.id, retried, error: message };
  }
  cleanup();

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
  identity: EmployeeIdentity,
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
  identity: EmployeeIdentity,
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
  identity: EmployeeIdentity;
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
