import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { enqueueTask, setTaskStage, type TaskStatus } from "@/server/services/hq-tasks";
import type { PipelineStage } from "@/lib/hq/boardroom-cards";
import {
  deriveSagaStatus,
  isStepReady,
  isTerminalStep,
  sagaProgress,
  stepRequiresApproval,
  type SagaStatus,
  type SagaStep,
  type SagaProgress,
  type StepStatus,
} from "@/lib/hq/workflow/model";
import { decomposeDirective, getTemplate } from "@/lib/hq/workflow/decompose";
import { drainSagaStepTasks } from "@/server/services/hq-saga-step-runner";
import type { DrainSummary } from "@/server/sdk/tasks";

/**
 * CrewFlow HQ — the Workflow-Saga service (the foundation aggregator).
 *
 * The thin, super-admin-gated server API over the Workflow-Saga engine (migration
 * 20261104000000). A saga sits ABOVE the Task Engine: it decomposes a directive into
 * a cross-department step GRAPH (deterministic templates — lib/hq/workflow), and
 * each step maps to a single hq_ai_tasks row that is created and staged ONLY through
 * the existing Task-Engine authority.
 *
 * The boundary, made explicit:
 *   • Every mutation is gated on isSuperAdminEmail HERE, in code — because the writes
 *     below use the service-role admin client, which BYPASSES RLS, so the gate cannot
 *     live in an RLS policy (the same reason HQ access is a request-path gate, and
 *     the same shape hq-decisions.ts uses). #456: a saga is HQ-GLOBAL admin data —
 *     it carries no org_id and never blends tenant orgs.
 *   • Steps create/advance HQ tasks THROUGH the Task-Engine entry points
 *     (`enqueueTask` → hq_ai_task_create, `setTaskStage` → hq_ai_task_set_stage RPC),
 *     NEVER a bare insert/update on hq_ai_tasks. The saga's own tables are written
 *     directly (they are the sanctioned write path for the saga); hq_ai_tasks is not.
 *   • NO FABRICATED PROGRESS. A step's status is derived from the REAL state of its
 *     linked task (loud reads); a saga's status is derived from its steps
 *     (deriveSagaStatus). Neither is asserted independently of the work.
 *
 * Every read fails LOUDLY (readFailure) rather than rendering an empty state on a
 * failed query. Every function returns a discriminated result; none throw on a
 * business outcome.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

// hq_workflow_sagas / hq_saga_steps are service-role-only HQ tables, not in the
// generated Supabase types — cast past the typed client (the same `as unknown as`
// shim hq-decisions.ts uses; a typing convenience, not logic).
type DbList<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
interface Query<T> extends DbList<T> {
  select(columns: string): Query<T>;
  insert(payload: unknown): Query<T>;
  update(payload: unknown): Query<T>;
  eq(column: string, value: unknown): Query<T>;
  in(column: string, values: ReadonlyArray<unknown>): Query<T>;
  order(column: string, options?: { ascending?: boolean }): Query<T>;
  limit(count: number): Query<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}

function sagas(admin: AdminClient): Query<SagaRow> {
  return admin.from("hq_workflow_sagas" as never) as unknown as Query<SagaRow>;
}
function steps(admin: AdminClient): Query<StepRow> {
  return admin.from("hq_saga_steps" as never) as unknown as Query<StepRow>;
}

const SAGA_COLUMNS =
  "id, decision_id, title, template_key, status, created_by, created_at, updated_at";
const STEP_COLUMNS =
  "id, saga_id, ordinal, title, department, role, depends_on_ordinal, hq_ai_task_id, status, created_at, updated_at";

export type SagaRow = {
  id: string;
  decision_id: string | null;
  title: string;
  template_key: string | null;
  status: SagaStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type StepRow = {
  id: string;
  saga_id: string;
  ordinal: number;
  title: string;
  department: string | null;
  role: string | null;
  depends_on_ordinal: number | null;
  hq_ai_task_id: string | null;
  status: StepStatus;
  created_at: string;
  updated_at: string;
};

/** A saga with its ordered steps and a deterministic progress summary. */
export type SagaWithSteps = {
  saga: SagaRow;
  steps: StepRow[];
  progress: SagaProgress;
};

/** The human acting on a saga. Every mutation is gated on this email's HQ status. */
export type Actor = { id: string | null; email: string | null };

export type SagaResult =
  | { ok: true; saga: SagaWithSteps }
  | { ok: false; error: string };

// ---------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------

/** A mutation is HQ-only. Returns null when allowed, an error result otherwise. */
function actorGate(actor: Actor): { ok: false; error: string } | null {
  if (!isSuperAdminEmail(actor.email)) return { ok: false, error: "forbidden" };
  return null;
}

/** Project a persisted step row onto the pure model's step shape. */
function toModelStep(row: StepRow): SagaStep {
  return {
    ordinal: row.ordinal,
    title: row.title,
    department: row.department,
    role: row.role,
    dependsOnOrdinal: row.depends_on_ordinal,
    status: row.status,
  };
}

/**
 * The honest step status for a task's REAL execution status. A step reflects the
 * live state of the work, never a fabricated one:
 *   • any non-terminal task (pending/claimed/running/verifying/waiting_approval) ⇒
 *     'running' — the work is dispatched and in flight;
 *   • completed ⇒ 'done'; failed ⇒ 'failed'; cancelled ⇒ 'skipped';
 *   • blocked ⇒ 'blocked'.
 */
function stepStatusForTask(taskStatus: TaskStatus): StepStatus {
  switch (taskStatus) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "skipped";
    case "blocked":
      return "blocked";
    default:
      return "running";
  }
}

/**
 * Department → the Master-Plan PRODUCT pipeline stage its work belongs to. Used to
 * stamp a dispatched task's stage through the sanctioned set_stage RPC, so a saga's
 * tasks actually TRAVERSE the fifteen-stage lifecycle (each move appends an immutable
 * hq_ai_task_stage_events row — measurable and auditable). A department with no clear
 * stage correspondence is left unstaged (null), which is valid. The full-lifecycle
 * template (product_launch) names one distinct department per stage so this map is a
 * clean 1:1 across a launch saga.
 */
export const DEPARTMENT_STAGE: Readonly<Record<string, PipelineStage>> = {
  Executive: "idea",
  Research: "research",
  Product: "specification",
  Architecture: "architecture",
  Design: "design",
  Engineering: "engineering",
  QA: "testing",
  Documentation: "documentation",
  Approval: "approval",
  Marketing: "marketing",
  Sales: "sales",
  Operations: "deployment",
  Monitoring: "monitoring",
  Review: "review",
  Improvement: "continuous-improvement",
  Support: "review",
  "Customer Success": "review",
};

async function readSagaRow(admin: AdminClient, id: string): Promise<SagaRow | null> {
  const { data, error } = await sagas(admin).select(SAGA_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw readFailure("hq-workflow: saga row", error);
  return data ?? null;
}

async function readStepRows(admin: AdminClient, sagaId: string): Promise<StepRow[]> {
  const { data, error } = await steps(admin)
    .select(STEP_COLUMNS)
    .eq("saga_id", sagaId)
    .order("ordinal", { ascending: true });
  if (error) throw readFailure("hq-workflow: saga steps", error);
  return Array.isArray(data) ? data : [];
}

async function assembleSaga(admin: AdminClient, sagaRow: SagaRow): Promise<SagaWithSteps> {
  const stepRows = await readStepRows(admin, sagaRow.id);
  return {
    saga: sagaRow,
    steps: stepRows,
    progress: sagaProgress(stepRows.map(toModelStep)),
  };
}

// ---------------------------------------------------------------------
// 1. Create — a super-admin decomposes a directive into a saga.
// ---------------------------------------------------------------------

export type CreateSagaInput = {
  creator: Actor;
  title: string;
  templateKey: string;
  /** Optionally link the directive this saga decomposes. */
  decisionId?: string | null;
};

/**
 * Decompose a directive with a DETERMINISTIC template and persist the saga plus its
 * step graph. Super-admin only. The deterministic decomposition (decomposeDirective)
 * is the substrate; the AI-assisted seam (lib/hq/workflow/ai-decompose.ts) is dark
 * and is not consulted here — the service builds the deterministic saga so it never
 * depends on a bound model.
 */
export async function createSaga(input: CreateSagaInput): Promise<SagaResult> {
  const denied = actorGate(input.creator);
  if (denied) return denied;

  const decomposed = decomposeDirective(
    { title: input.title, templateKey: input.templateKey },
    new Date(),
  );
  if (!decomposed.ok) return { ok: false, error: decomposed.error };
  const plan = decomposed.plan;

  const admin = createAdminClient();
  const { data: sagaRow, error: sagaErr } = await sagas(admin)
    .insert({
      title: plan.title,
      template_key: plan.templateKey || null,
      status: plan.status,
      decision_id: input.decisionId ?? null,
      created_by: input.creator.id,
    })
    .select(SAGA_COLUMNS)
    .maybeSingle();
  if (sagaErr || !sagaRow) {
    console.error("[hq-workflow] createSaga failed", sagaErr);
    return { ok: false, error: sagaErr?.message ?? "create_failed" };
  }

  // Persist the step graph. The steps go in as one array insert (append-only event
  // per step is emitted by the DB trigger). If this fails, the saga row's cascade
  // makes an orphaned-steps state impossible; we surface the error loudly.
  const { error: stepErr } = await steps(admin)
    .insert(
      plan.steps.map((s) => ({
        saga_id: sagaRow.id,
        ordinal: s.ordinal,
        title: s.title,
        department: s.department,
        role: s.role,
        depends_on_ordinal: s.dependsOnOrdinal,
        status: s.status,
      })),
    )
    .select(STEP_COLUMNS);
  if (stepErr) {
    console.error("[hq-workflow] createSaga step insert failed", stepErr);
    return { ok: false, error: stepErr.message };
  }

  await recordAdminActivity({
    actorId: input.creator.id,
    actorEmail: input.creator.email,
    action: "saga.created",
    targetTable: "hq_workflow_sagas",
    targetId: sagaRow.id,
    metadata: { title: plan.title, template_key: plan.templateKey, steps: plan.steps.length },
  });

  return { ok: true, saga: await assembleSaga(admin, sagaRow) };
}

// ---------------------------------------------------------------------
// 2. Advance — dispatch (or re-sync) one step, honestly reflecting its task.
// ---------------------------------------------------------------------

export type AdvanceStepInput = {
  actor: Actor;
  sagaId: string;
  stepId: string;
};

/**
 * Advance one step. Super-admin only. In order:
 *
 *   1. refuse if the saga is terminal (done/abandoned) — a frozen saga is not
 *      advanced;
 *   2. refuse if the step's dependency is not yet `done` (`not_ready`) — the graph's
 *      edges are honoured;
 *   3. if the step has NO linked task, CREATE one through the Task-Engine authority
 *      (`enqueueTask` → hq_ai_task_create) and, when the department maps to a
 *      product stage, stamp it through the sanctioned RPC (`setTaskStage` →
 *      hq_ai_task_set_stage). NEVER a bare hq_ai_tasks insert;
 *   4. READ the linked task's REAL execution status (loud read) and set the step's
 *      status from it — no fabricated progress;
 *   5. recompute the saga's status from its steps (deriveSagaStatus) and persist it.
 */
export async function advanceStep(input: AdvanceStepInput): Promise<SagaResult> {
  const denied = actorGate(input.actor);
  if (denied) return denied;

  const admin = createAdminClient();
  const sagaRow = await readSagaRow(admin, input.sagaId);
  if (!sagaRow) return { ok: false, error: "not_found" };
  if (sagaRow.status === "done" || sagaRow.status === "abandoned") {
    return { ok: false, error: "saga_terminal" };
  }

  const stepRows = await readStepRows(admin, input.sagaId);
  const step = stepRows.find((s) => s.id === input.stepId);
  if (!step) return { ok: false, error: "step_not_found" };

  // 2. Dependency readiness — the graph's edge must be satisfied.
  if (!isStepReady(toModelStep(step), stepRows.map(toModelStep))) {
    return { ok: false, error: "not_ready" };
  }

  // 3+4. Dispatch (or re-sync) the step through the shared core. A MANUAL advance is
  // the human's own approval, so it is NOT subject to the drain's approval gate — a
  // super-admin may advance any ready step, gated or not.
  const dispatched = await dispatchOrSyncStep(admin, input.sagaId, step, input.actor);
  if (!dispatched.ok) return { ok: false, error: dispatched.error };

  // 5. Recompute + persist the saga status from its (now-updated) steps.
  const finalSaga = await recomputeSagaStatus(admin, sagaRow);
  return { ok: true, saga: await assembleSaga(admin, finalSaga) };
}

// ---------------------------------------------------------------------
// The shared step-advance core — used by BOTH the manual advance and the drain.
// ---------------------------------------------------------------------

type DispatchResult =
  | { ok: true; taskId: string; stepStatus: StepStatus }
  | { ok: false; error: string };

/**
 * Dispatch (or re-sync) ONE step, honestly reflecting its task. The load-bearing
 * primitive shared by `advanceStep` (a human's manual advance) and
 * `drainReadySagaSteps` (the autonomous cron):
 *
 *   • if the step has NO linked task, CREATE one through the Task-Engine authority
 *     (`enqueueTask` → hq_ai_task_create) with a STABLE dedupe key
 *     (`saga_step:<id>`), so two overlapping callers can never create two tasks —
 *     the second is deduped to the first. NEVER a bare hq_ai_tasks insert;
 *   • stamp the product stage through the sanctioned set_stage RPC when the
 *     department maps to one;
 *   • READ the linked task's REAL execution status (loud read) and set the step's
 *     status from it — no fabricated progress.
 *
 * It does NOT recompute the saga status (the caller does, once) and does NOT check
 * the approval gate (the caller decides whether a step may be dispatched). Audits the
 * per-step advance so both paths share one immutable provenance record.
 */
async function dispatchOrSyncStep(
  admin: AdminClient,
  sagaId: string,
  step: StepRow,
  actor: Actor,
): Promise<DispatchResult> {
  let taskId = step.hq_ai_task_id;
  if (!taskId) {
    const enq = await enqueueTask({
      taskType: "saga_step",
      payload: {
        saga_id: sagaId,
        step_id: step.id,
        ordinal: step.ordinal,
        title: step.title,
        department: step.department,
        role: step.role,
      },
      subjectKind: "saga_step",
      subjectId: step.id,
      // A stable dedupe key so a double-advance (or two overlapping drains) does not
      // create two tasks.
      dedupeKey: `saga_step:${step.id}`,
      origin: "saga",
      createdBy: actor.id,
    });
    if (!enq.ok) return { ok: false, error: `task_create_failed:${enq.reason}` };
    taskId = enq.task.id;

    // Stamp the product stage through the sanctioned set_stage RPC when the
    // department maps to one. A non-mapping department is left unstaged (valid).
    const stage = step.department ? DEPARTMENT_STAGE[step.department] : undefined;
    if (stage) await setTaskStage(taskId, stage);
  }

  // Read the linked task's REAL status — no fabricated progress.
  const taskStatus = await readTaskStatus(admin, taskId);
  if (taskStatus === null) return { ok: false, error: "task_read_failed" };
  const nextStepStatus = stepStatusForTask(taskStatus);

  const { error: updErr } = await steps(admin)
    .update({ hq_ai_task_id: taskId, status: nextStepStatus })
    .eq("id", step.id)
    .select(STEP_COLUMNS);
  if (updErr) {
    console.error("[hq-workflow] dispatchOrSyncStep: step update failed", updErr);
    return { ok: false, error: updErr.message };
  }

  await recordAdminActivity({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "saga.step_advanced",
    targetTable: "hq_saga_steps",
    targetId: step.id,
    metadata: { saga_id: sagaId, task_id: taskId, step_status: nextStepStatus },
  });

  return { ok: true, taskId, stepStatus: nextStepStatus };
}

/** Recompute a saga's status from its (freshly-read) steps and persist any change. */
async function recomputeSagaStatus(admin: AdminClient, sagaRow: SagaRow): Promise<SagaRow> {
  const refreshed = await readStepRows(admin, sagaRow.id);
  const derived = deriveSagaStatus(refreshed.map(toModelStep));
  if (derived === sagaRow.status) return sagaRow;
  const { data: updatedSaga, error } = await sagas(admin)
    .update({ status: derived })
    .eq("id", sagaRow.id)
    .select(SAGA_COLUMNS)
    .maybeSingle();
  if (error) {
    console.error("[hq-workflow] recomputeSagaStatus: saga status update failed", error);
    return sagaRow;
  }
  return updatedSaga ?? sagaRow;
}

// ---------------------------------------------------------------------
// 2b. Drain — autonomously advance every READY, UNGATED step across active sagas.
// ---------------------------------------------------------------------

export type SagaDrainResult = {
  /** Active sagas scanned this pass. */
  sagas_scanned: number;
  /** Steps dispatched (a new task created) this pass. */
  steps_dispatched: number;
  /** Already-linked steps whose status was re-synced from their real task. */
  steps_synced: number;
  /** READY steps left untouched because they map to an approval-gated action. */
  held_for_approval: number;
  /** Per-step failures (logged; the pass continues). */
  errors: number;
  /**
   * The `saga_step` TASK-EXECUTION summary for this pass (G6). Before the sync
   * scan, the drain runs the canonical `saga_step` runner
   * (server/services/hq-saga-step-runner.ts) so dispatched steps' tasks are
   * actually EXECUTED — the missing half that left every saga stuck `running`
   * forever. Null only when the executor pass itself faulted (logged; the sync
   * pass still runs, so propagation is never blocked by an executor fault).
   */
  step_tasks: DrainSummary | null;
  durationMs: number;
};

/**
 * The AUTONOMOUS saga-drain — the cron authority that replaces the manual-ONLY
 * advance. It walks the active sagas and, for each:
 *
 *   • re-syncs any ALREADY-LINKED, non-terminal step from its real task status, so a
 *     completed task propagates and unblocks its dependents (progress, not a new
 *     action);
 *   • DISPATCHES any step that is ready (its dependency is `done`), undispatched, and
 *     NOT approval-gated — creating its task through the Task-Engine authority;
 *   • HALTS at any ready step that maps to an approval-gated action
 *     (`stepRequiresApproval`) — it is left `pending` for a super-admin's manual
 *     advance. The autonomous path never dispatches a gated action.
 *
 * It runs WITHOUT a super-admin actor (a cron has none) and therefore deliberately
 * skips `actorGate`; but it can ONLY open internal Task-Engine work — it never
 * decides, never approves, and takes no irreversible external action (the Task Engine
 * itself does not execute; apply authority ships dark). Audited as the system actor.
 *
 * IDEMPOTENT: dispatch is guarded by the step's stable dedupe key, so an overlapping
 * tick cannot double-create; a step already dispatched is only re-synced. BOUNDED by
 * `limit` sagas per pass, ordered stalest-first (a fairness cursor), so a claimed
 * saga rotates to the back and no tail can starve.
 */
export async function drainReadySagaSteps(
  opts: { limit?: number } = {},
): Promise<SagaDrainResult> {
  const startedAt = Date.now();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const system: Actor = { id: null, email: null };
  const admin = createAdminClient();

  // 0. EXECUTE the dispatched work first (G6): drain ready `saga_step` tasks
  // through the canonical runner, so this same pass's re-sync below can propagate
  // the completions into the steps (completed → done → dependents ready). This is
  // also the REPAIR path for the queued-orphaned backlog: `hq_ai_task_claim`
  // selects by task_type + pending, so every stuck task becomes claimable here
  // with no data surgery. Best-effort — an executor fault is logged and counted,
  // never allowed to block the sync/dispatch scan.
  let stepTasks: DrainSummary | null = null;
  let errors = 0;
  try {
    const drained = await drainSagaStepTasks(limit);
    stepTasks = {
      claimed: drained.claimed,
      completed: drained.completed,
      failed: drained.failed,
      retried: drained.retried,
      leaseLost: drained.leaseLost,
      errors: drained.errors,
    };
  } catch (e) {
    console.error(
      "[hq-workflow] drainReadySagaSteps: saga_step task drain failed",
      e instanceof Error ? e.message : String(e),
    );
    errors++;
  }

  // Active sagas only (planned/running/blocked), stalest-first — a recency cursor so
  // a saga touched this pass rotates behind the ones not yet reached.
  const { data: activeSagas, error: listErr } = await sagas(admin)
    .select(SAGA_COLUMNS)
    .in("status", ["planned", "running", "blocked"])
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (listErr) throw readFailure("hq-workflow: active sagas for drain", listErr);

  let stepsDispatched = 0;
  let stepsSynced = 0;
  let heldForApproval = 0;
  const sagaRows = Array.isArray(activeSagas) ? activeSagas : [];

  for (const sagaRow of sagaRows) {
    try {
      const stepRows = await readStepRows(admin, sagaRow.id);
      const modelSteps = stepRows.map(toModelStep);

      for (const step of stepRows) {
        // Terminal steps are done with — nothing to advance.
        if (isTerminalStep(step.status)) continue;

        const linked = step.hq_ai_task_id !== null;
        if (linked) {
          // Re-sync a dispatched step's status from its real task (progress
          // propagation — not a new action, so the approval gate does not apply).
          const synced = await dispatchOrSyncStep(admin, sagaRow.id, step, system);
          if (synced.ok) stepsSynced++;
          else errors++;
          continue;
        }

        // Undispatched: only ready steps can move.
        if (!isStepReady(toModelStep(step), modelSteps)) continue;

        // The gate: a ready step mapping to an approval-gated action WAITS for a
        // human's manual advance — the autonomous drain never dispatches it.
        if (stepRequiresApproval(step)) {
          heldForApproval++;
          continue;
        }

        const dispatched = await dispatchOrSyncStep(admin, sagaRow.id, step, system);
        if (dispatched.ok) stepsDispatched++;
        else errors++;
      }

      // Recompute the saga's status once, from its now-updated steps.
      await recomputeSagaStatus(admin, sagaRow);
    } catch (e) {
      console.error(
        "[hq-workflow] drainReadySagaSteps: saga failed",
        sagaRow.id,
        e instanceof Error ? e.message : String(e),
      );
      errors++;
    }
  }

  return {
    sagas_scanned: sagaRows.length,
    steps_dispatched: stepsDispatched,
    steps_synced: stepsSynced,
    held_for_approval: heldForApproval,
    errors,
    step_tasks: stepTasks,
    durationMs: Date.now() - startedAt,
  };
}

/** Read one hq_ai_tasks row's execution status. A READ only — never a mutation. */
async function readTaskStatus(admin: AdminClient, taskId: string): Promise<TaskStatus | null> {
  const { data, error } = (await (
    admin.from("hq_ai_tasks" as never) as unknown as {
      select(c: string): {
        eq(col: string, v: unknown): {
        maybeSingle(): PromiseLike<{ data: { status: TaskStatus } | null; error: { message: string } | null }>;
      };
      };
    }
  )
    .select("status")
    .eq("id", taskId)
    .maybeSingle()) as { data: { status: TaskStatus } | null; error: { message: string } | null };
  if (error) {
    console.error("[hq-workflow] readTaskStatus failed", error);
    return null;
  }
  return data?.status ?? null;
}

// ---------------------------------------------------------------------
// 3. Abandon — a HUMAN terminal act (never derived from step states).
// ---------------------------------------------------------------------

export async function abandonSaga(input: { actor: Actor; sagaId: string }): Promise<SagaResult> {
  const denied = actorGate(input.actor);
  if (denied) return denied;

  const admin = createAdminClient();
  const sagaRow = await readSagaRow(admin, input.sagaId);
  if (!sagaRow) return { ok: false, error: "not_found" };
  if (sagaRow.status === "abandoned") return { ok: true, saga: await assembleSaga(admin, sagaRow) };
  if (sagaRow.status === "done") return { ok: false, error: "saga_terminal" };

  const { data: updated, error } = await sagas(admin)
    .update({ status: "abandoned" })
    .eq("id", input.sagaId)
    .select(SAGA_COLUMNS)
    .maybeSingle();
  if (error || !updated) {
    console.error("[hq-workflow] abandonSaga failed", error);
    return { ok: false, error: error?.message ?? "abandon_failed" };
  }
  await recordAdminActivity({
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    action: "saga.abandoned",
    targetTable: "hq_workflow_sagas",
    targetId: input.sagaId,
  });
  return { ok: true, saga: await assembleSaga(admin, updated) };
}

// ---------------------------------------------------------------------
// 4. Reads — the saga list and one saga's detail. LOUD reads.
// ---------------------------------------------------------------------

export async function getSaga(id: string): Promise<SagaWithSteps | null> {
  const admin = createAdminClient();
  const sagaRow = await readSagaRow(admin, id);
  if (!sagaRow) return null;
  return assembleSaga(admin, sagaRow);
}

/** List sagas, newest first. Pass a status to filter; omit for all. */
export async function listSagas(
  opts: { status?: SagaStatus; limit?: number } = {},
): Promise<SagaRow[]> {
  const admin = createAdminClient();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  let query = sagas(admin).select(SAGA_COLUMNS);
  if (opts.status) query = query.eq("status", opts.status);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) throw readFailure("hq-workflow: sagas", error);
  return Array.isArray(data) ? data : [];
}

/** The deterministic template catalogue, for the create form. */
export { SAGA_TEMPLATES } from "@/lib/hq/workflow/decompose";
export { getTemplate };
