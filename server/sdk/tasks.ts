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
import { createEvents } from "@/server/sdk/events";
import { createComms } from "@/server/sdk/comms";
import { drainEvidenceInto } from "@/server/sdk/output";
import { evaluateAction } from "@/server/sdk/gate";
import { REFERENCE_EXECUTOR, type Executor, type ExecutionRefusalReason } from "@/server/sdk/executor";
import { deriveIdempotencyKey } from "@/server/sdk/application";
import { requestApproval } from "@/server/services/hq-approvals";
import type { BoundEvents } from "@/server/sdk/events";
import type { BoundComms } from "@/server/sdk/comms";
import type { TaskResult } from "@/server/sdk/output";
import type { EmploymentPosture, ProposedAction, GateVerdict } from "@/server/sdk/gate";
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
 * #014 / D-04 (Phase A; ADR 0008) EXTENDS this context with two more facets — `events`
 * (append to the Event Spine as this employee) and `comms` (deliver APPROVED drafts) —
 * and graduates the handler return type to the standard output envelope (Volume XIII
 * §10), with the runner draining the memory facet's evidence into it at completion. The
 * additions are ADDITIVE: the frozen contract and the existing facets are unchanged.
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
   * assembly from the Capability Registry (D-05 — see
   * {@link import("./registry-parity").resolveServedAuthority}). Optional on the identity
   * so a caller may omit it; the runner defaults `ctx.capabilities` to
   * {@link EMPTY_CAPABILITIES} when absent. D-03 only THREADS it; the AI SDK (D-04)
   * enforces and the Capability Registry (D-05) sources it.
   */
  capabilities?: ResolvedCapabilitySet;
  /**
   * The employee's coarse autonomy stance, resolved once at identity assembly from the
   * Capability Registry (D-05 — see
   * {@link import("./registry-parity").resolveServedAuthority}). Optional so a caller may
   * omit it; the doorman (`ctx.proposeActions`) defaults to {@link LOCKED_POSTURE} — the
   * Built default-locked floor — when absent, so a missing posture is deny-by-default. The
   * gate (D-04 Phase B) reads it as layer 1; #015 repointed its source to the registry
   * without changing this contract.
   */
  posture?: EmploymentPosture;
}

// ---------------------------------------------------------------------
// Capabilities — opaque, read-only, source-indifferent (ADR 0007, Decision 7)
// ---------------------------------------------------------------------

/**
 * The capability tokens an employee holds, as RunContext exposes them: an OPAQUE,
 * READ-ONLY, source-indifferent set. D-03 only THREADS it onto `ctx.capabilities` —
 * it does NOT interpret, match, or enforce a token (that is the AI SDK, D-04), and it
 * does NOT decide where tokens come from (that is the Capability Registry, D-05).
 * `source` records where this set was resolved. The D-05 swap repointed it to the
 * registry WITHOUT changing the contract a handler sees: a runtime set is sourced
 * `registry`, or `none` for the empty default. The legacy `ai_employees` value remains
 * in the union for contract stability — LR5.4B removed the employee-row authority
 * columns, so production no longer produces it.
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

// ---------------------------------------------------------------------
// Posture — the coarse autonomy stance (ADR 0008; the doorman's layer 1)
// ---------------------------------------------------------------------

/**
 * The Built default-locked posture — `can_execute=false`, `requires_approval=true`: the
 * deny-by-default floor. The safe, frozen default the doorman uses when an identity carries
 * no posture, and the posture the registry bridge serves as its fail-safe (see
 * {@link import("./registry-parity").resolveServedAuthority}): a missing stance is
 * deny-by-default, so every proposed action routes to approval until a posture is resolved.
 */
export const LOCKED_POSTURE: EmploymentPosture = Object.freeze({
  canExecute: false,
  requiresApproval: true,
});

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
 * capabilities are stable for the whole invocation. The facets present are `memory`,
 * `tasks`, `events` and `comms` (the last two added under #014 / D-04, Phase A); tools,
 * the API gateway, cost metering, the approval runtime, autonomy and verification remain
 * later directives that EXTEND this context.
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
  /**
   * Append events to the Event Spine AS this employee (#014 / D-04, Phase A). Stamps
   * the bound actor + the run's correlation on every emission; BEST-EFFORT — `emit`
   * returns an outcome and never throws (the spine is best-effort by design).
   */
  events: BoundEvents;
  /**
   * Deliver APPROVED drafts + read delivery history (#014 / D-04, Phase A). Every send
   * is approval-gated (the Approval Engine + the DB trigger are the boundary) and never
   * autonomous; failure throws (throw-based ABI).
   */
  comms: BoundComms;
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
  /**
   * The doorman (#014 / D-04, Phase B). Classify proposed actions against the current
   * policy — employee posture (layer 1), capability scope (layer 2), the five P4 atoms
   * (layer 3) — and ROUTE each by its verdict: an `autonomous` action is audited to the
   * spine (best-effort `ai.action_permitted`), a `needs_approval` action is handed to the
   * Approval Engine (`requestApproval`, correlation-threaded). Returns the verdicts in
   * input order, so a handler can proceed on the autonomous ones and await the queued
   * ones. The gate ({@link evaluateAction}) is PURE policy; this runtime supplies the
   * MECHANISM the gate must never know about (the Policy vs Mechanism rule).
   */
  proposeActions(actions: ProposedAction[]): Promise<GateVerdict[]>;
}

/**
 * The unit of employee code. Receives the context, does business logic ONLY
 * (rule 5), and signals outcome by its return/throw:
 *   • return a result (or void) → the runner completes the task with it, after draining
 *     the memory facet's evidence into the result envelope (XIII §10);
 *   • throw                     → the runner fails the task (retryable unless it throws
 *     {@link NonRetryableError}).
 *
 * The canonical return shape is the standard output envelope `AiOutput` (#014 / D-04,
 * Phase A). {@link TaskResult} stays a WIDE superset of the legacy free-form result, so
 * graduating to the envelope NARROWS nothing a handler returned before (ADR 0008 SDK
 * Stability Rule).
 */
export type TaskHandler = (ctx: RunContext) => Promise<TaskResult | void>;

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

// The #014 / D-04 (Phase A) handler-facing types, re-exported so the SDK stays the one
// door: a handler imports its whole vocabulary from `@/server/sdk/tasks`.
export type { AiOutput, AiAction, AiAlternative, TaskResult } from "@/server/sdk/output";
export type { BoundEvents, EmitInput, EmitOutcome } from "@/server/sdk/events";
export type { BoundComms, SendInput } from "@/server/sdk/comms";
// The #014 / D-04 Phase B doorman vocabulary, re-exported so a handler reads the gate's
// declarative verdict types from the same one door as the rest of the SDK.
export type { ProposedAction, GateVerdict, GateReason, EmploymentPosture } from "@/server/sdk/gate";

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

// ---------------------------------------------------------------------
// Executor shadow — R1 of the Live Executor Rollout (CEO Directive #016 / D-06; ADR 0011)
// ---------------------------------------------------------------------

/**
 * The R1 kill-switch for the executor shadow. DEFAULT-OFF: the shadow runs only when
 * `CREWFLOW_EXECUTOR_SHADOW` is exactly `"on"`. Off, the autonomous branch behaves
 * byte-for-byte as before (audit continuity); on, it additionally COMPOSES the proven
 * `plan → key` chain and records the observation on the SAME `ai.action_permitted` event —
 * crossing no tool boundary (the Runtime Composition Rule: "Composition is orchestration,
 * not duplication"). Exported so the runner and the unit suite read the same switch.
 */
export function executorShadowEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CREWFLOW_EXECUTOR_SHADOW === "on";
}

/**
 * A side-effect-free observation of what the executor WOULD do with a cleared action — the
 * shadow's only product (R1 is shadow-only: "shadow execution, audit continuity. No production
 * cut-over"). It is DATA appended to the audit payload, never an applied effect:
 *
 *   • `planned`  — the executor produced a plan; we carry the resolved tool label and the
 *                  derived idempotency key (the application-store KEYING contract, wired but
 *                  never written — `store.put` is deferred to a later increment).
 *   • `refused`  — the executor declined at its own boundary (an {@link ExecutionRefusalReason}).
 *   • `error`    — observing threw; recorded, never raised (best-effort, like the emit itself).
 */
export type ExecutorShadowObservation =
  | { readonly outcome: "planned"; readonly toolLabel: string; readonly idempotencyKey: string }
  | { readonly outcome: "refused"; readonly reason: ExecutionRefusalReason; readonly detail: string }
  | { readonly outcome: "error"; readonly detail: string };

/**
 * Run the executor shadow for one cleared action: PLAN it (pure — {@link Executor.plan} never
 * applies) and, when a plan is produced, derive the idempotency key the durable store WOULD file
 * it under. This composes three established contracts — the gate's verdict, the executor's plan,
 * the application module's keying — WITHOUT crossing the execution boundary: {@link Executor.apply}
 * and {@link Executor.execute} are never called here. It never throws; any fault becomes an
 * `error` observation, so a shadow fault can never break the run (the emit is best-effort too).
 */
function observeExecutorShadow(
  executor: Executor,
  action: ProposedAction,
  verdict: GateVerdict,
  taskId: string,
  correlationId: string,
): ExecutorShadowObservation {
  try {
    const planned = executor.plan(action, verdict);
    if (!planned.ok) {
      return { outcome: "refused", reason: planned.refusal.reason, detail: planned.refusal.detail };
    }
    const idempotencyKey = deriveIdempotencyKey({
      source: "autonomous",
      correlationId,
      taskId,
      toolLabel: planned.plan.tool.label,
      actionId: `${action.subjectType}:${action.subjectId}:${action.type}`,
    });
    return { outcome: "planned", toolLabel: planned.plan.tool.label, idempotencyKey };
  } catch (err) {
    return { outcome: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build the in-handler `ctx.proposeActions` doorman, bound to this run's policy inputs and
 * its events facet (#014 / D-04, Phase B). For each proposed action it asks the PURE gate
 * ({@link evaluateAction}) for a verdict, then supplies the MECHANISM the gate must never
 * know about (the Policy vs Mechanism rule — Kernel Contract Map §2):
 *
 *   • `autonomous`     → audit the decision to the spine, BEST-EFFORT (`ai.action_permitted`;
 *                        the events facet's `emit` never throws, so a spine hiccup cannot
 *                        break the handler's primary work).
 *   • `needs_approval` → hand off to the Approval Engine (`requestApproval`), threading the
 *                        run's correlation; a refused/failed request THROWS (the throw-based
 *                        ABI) so the runner records the run as a failure rather than silently
 *                        dropping a side effect that needed a human.
 *
 * Verdicts are returned in input order. Deny-by-default is structural: posture, capabilities
 * and budget are pre-resolved by {@link buildContext} (LOCKED_POSTURE / EMPTY_CAPABILITIES
 * when the identity carries none), so a missing input routes to approval, never autonomy.
 * Exported as the runtime-composition seam the unit suite drives directly (the sibling of
 * {@link createTasks}).
 */
export function createProposeActions(deps: {
  identity: EmployeeIdentity;
  posture: EmploymentPosture;
  capabilities: ResolvedCapabilitySet;
  budget: number;
  correlationId: string;
  events: BoundEvents;
  // R1 executor shadow (CEO Directive #016 / D-06) — all OPTIONAL with safe, inert defaults so
  // the doorman's existing callers and tests are unchanged. `shadow` defaults OFF; `executor`
  // defaults to the reference handle; `taskId` keys the (unwritten) application record.
  taskId?: string;
  executor?: Executor;
  shadow?: boolean;
}): (actions: ProposedAction[]) => Promise<GateVerdict[]> {
  const {
    identity,
    posture,
    capabilities,
    budget,
    correlationId,
    events,
    taskId = "",
    executor = REFERENCE_EXECUTOR,
    shadow = false,
  } = deps;
  return async function proposeActions(actions: ProposedAction[]): Promise<GateVerdict[]> {
    const verdicts: GateVerdict[] = [];
    for (const action of actions) {
      const verdict = evaluateAction(action, posture, capabilities, budget);
      if (verdict.decision === "needs_approval") {
        // MECHANISM (needs_approval): queue it for a human. Throw on refusal so the run
        // fails rather than dropping a side effect the gate said a human must see.
        const res = await requestApproval({
          aiEmployeeId: identity.employeeId,
          subjectType: action.subjectType,
          subjectId: action.subjectId,
          action: action.type,
          proposedPayload: action.payload,
          correlationId,
        });
        if (!res.ok) {
          throw new Error(`ctx.proposeActions: requestApproval failed: ${res.error}`);
        }
      } else {
        // MECHANISM (autonomous): audit the permitted decision. Best-effort — a failed
        // append is logged by the facet, never raised, so the spine cannot block the work.
        // R1 executor shadow (default-OFF): when enabled, COMPOSE the executor's plan + the
        // application key and record the observation on this SAME event (additive payload,
        // backward-compatible — no boundary crossed, no new verb). Off, the payload is
        // byte-identical to before (audit continuity).
        const shadowObservation = shadow
          ? observeExecutorShadow(executor, action, verdict, taskId, correlationId)
          : undefined;
        await events.emit({
          verb: "ai.action_permitted",
          objectType: action.subjectType,
          objectId: action.subjectId,
          payload: {
            action: action.type,
            capability: action.capability ?? null,
            ...(shadowObservation ? { shadow: shadowObservation } : {}),
          },
        });
      }
      verdicts.push(verdict);
    }
    return verdicts;
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
  // The events facet is shared with the doorman below, so an autonomous verdict's audit
  // emit (`ai.action_permitted`) lands as the same actor + correlation as everything else
  // this run appends to the spine. Posture/capabilities/budget are resolved once and
  // default to the deny-by-default floor when the identity carries none.
  const events = createEvents({ slug: identity.slug }, task.correlation_id);
  const capabilities = identity.capabilities ?? EMPTY_CAPABILITIES;
  const budget = task.cost_budget_micros ?? 0;
  const ctx: RunContext = {
    task,
    identity,
    memory,
    tasks: createTasks(identity, task, leaseOwner),
    events,
    comms: createComms({ slug: identity.slug }, task.correlation_id),
    proposeActions: createProposeActions({
      identity,
      posture: identity.posture ?? LOCKED_POSTURE,
      capabilities,
      budget,
      correlationId: task.correlation_id,
      events,
      // R1: thread the task id (keys the unwritten application record) and read the default-off
      // kill-switch. The executor defaults to REFERENCE_EXECUTOR — per-employee executor binding
      // is a later increment; R1 only proves the composition shadow-first.
      taskId: task.id,
      shadow: executorShadowEnabled(),
    }),
    correlationId: task.correlation_id,
    budget,
    deadline,
    signal,
    capabilities,
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

  let result: TaskResult | void;
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

  // Evidence-drain (XIII §10): fold the memory facet's recalled ids into the result
  // envelope's `evidence[]` before completion — provenance for free, zero handler code.
  result = drainEvidenceInto(result, ctx.memory.evidence());
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
