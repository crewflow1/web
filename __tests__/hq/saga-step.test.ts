import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The `saga_step` runner — unit proofs (roadmap G6: the missing handler).
 *
 * THE DEFECT: hq-workflow's `dispatchOrSyncStep` enqueues every dispatched saga
 * step as an hq_ai_tasks row of task_type "saga_step", but NO handler was ever
 * registered for that type — so every dispatched step's task sat `pending`
 * forever and no saga could ever complete. This suite pins the fix:
 *
 *   • SOURCE CONTRACT — the runner registers a handler for exactly the type the
 *     dispatch path enqueues, and the saga-drain actually calls the runner's
 *     drain (the wiring that makes queued-orphaned tasks claimable);
 *   • REGISTRATION — driving the real drain surface registers "saga_step" in the
 *     real SDK registry;
 *   • HANDLER BEHAVIOUR — against an in-memory admin mock, the REAL handler:
 *     executes a ready step deterministically (envelope + provenance record),
 *     no-ops idempotently on an already-terminal step (crash re-claim safety),
 *     no-ops on a terminal saga, throws NonRetryableError on malformed input /
 *     a vanished step (a retry cannot fix those), and throws a RETRYABLE error
 *     when the dependency is not yet done (the graph edge, re-verified);
 *   • STEP-STATE MAPPING — the drain's re-sync maps every real task status onto
 *     the honest step status (completed→done, failed→failed, cancelled→skipped,
 *     blocked→blocked, in-flight→running), which is what lets a completed
 *     saga_step task roll its saga to done.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state: { sagas: Row[]; steps: Row[]; tasks: Row[]; activity: Row[] } = {
    sagas: [],
    steps: [],
    tasks: [],
    activity: [],
  };
  let taskSeq = 0;

  function tableFor(name: string): Row[] {
    if (name === "hq_workflow_sagas") return state.sagas;
    if (name === "hq_saga_steps") return state.steps;
    if (name === "hq_ai_tasks") return state.tasks;
    throw new Error(`unexpected table ${name}`);
  }

  function makeQuery(rows: Row[]) {
    const q = {
      _op: "select" as "select" | "update",
      _payload: null as Row | null,
      _eq: [] as Array<[string, unknown]>,
      _in: [] as Array<[string, ReadonlyArray<unknown>]>,
      select() {
        return q;
      },
      update(p: Row) {
        q._op = "update";
        q._payload = p;
        return q;
      },
      eq(col: string, val: unknown) {
        q._eq.push([col, val]);
        return q;
      },
      in(col: string, vals: ReadonlyArray<unknown>) {
        q._in.push([col, vals]);
        return q;
      },
      order() {
        return q;
      },
      limit() {
        return q;
      },
      _match(r: Row): boolean {
        for (const [c, v] of q._eq) if (r[c] !== v) return false;
        for (const [c, vals] of q._in) if (!vals.includes(r[c])) return false;
        return true;
      },
      _run(): { data: Row[]; error: null } {
        const matched = rows.filter((r) => q._match(r));
        if (q._op === "update" && q._payload) {
          for (const r of matched) Object.assign(r, q._payload);
        }
        return { data: matched.map((r) => ({ ...r })), error: null };
      },
      maybeSingle() {
        const res = q._run();
        return Promise.resolve({ data: res.data[0] ?? null, error: res.error });
      },
      then<T>(onF: (v: { data: Row[]; error: null }) => T) {
        return Promise.resolve(q._run()).then(onF);
      },
    };
    return q;
  }

  const admin = {
    from(name: string) {
      return makeQuery(tableFor(name));
    },
  };

  function enqueueTask(input: {
    dedupeKey?: string | null;
    [k: string]: unknown;
  }): Promise<{ ok: true; task: Row; deduped: boolean }> {
    const key = input.dedupeKey ?? null;
    if (key) {
      const existing = state.tasks.find((t) => t.dedupe_key === key);
      if (existing) return Promise.resolve({ ok: true, task: { ...existing }, deduped: true });
    }
    taskSeq += 1;
    const task: Row = { id: `task-${taskSeq}`, dedupe_key: key, status: "pending" };
    state.tasks.push(task);
    return Promise.resolve({ ok: true, task: { ...task }, deduped: false });
  }

  // The engine surface the SDK binds — claim always empty here (the registration
  // proof needs the surface, not a live queue).
  const claimTask = vi.fn(async () => ({ ok: true as const, task: null }));

  return { state, admin, enqueueTask, claimTask };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: (row: Record<string, unknown>) => {
    h.state.activity.push(row);
    return Promise.resolve(undefined);
  },
}));
vi.mock("@/server/services/hq-tasks", () => ({
  enqueueTask: (input: Record<string, unknown>) => h.enqueueTask(input),
  setTaskStage: vi.fn().mockResolvedValue(undefined),
  claimTask: h.claimTask,
  completeTask: vi.fn(async () => ({ ok: true, task: null })),
  checkpointTask: vi.fn(async () => ({ ok: true, alive: true })),
  failTask: vi.fn(async () => ({ ok: true, task: { status: "failed" } })),
  heartbeatTask: vi.fn(async () => ({ ok: true, alive: true })),
  cancelTask: vi.fn(async () => ({ ok: true, task: null })),
}));
vi.mock("@/server/services/hq-worker-runner-kit", () => ({
  resolveWorkerIdentity: vi.fn(async (slug: string) => ({
    identity: { employeeId: slug, slug },
    employeeId: null,
  })),
  normaliseWorkerOutcome: (o: { status: string; taskId?: string; error?: string }) =>
    o.status === "completed" || o.status === "empty"
      ? { ok: true, status: o.status === "empty" ? "skipped" : "completed", taskId: o.taskId }
      : { ok: false, status: "failed", taskId: o.taskId, error: o.error ?? "failed" },
}));

import {
  sagaStepHandler,
  drainSagaStepTasks,
  SAGA_STEP_TASK_TYPE,
} from "@/server/services/hq-saga-step-runner";
import { drainReadySagaSteps } from "@/server/services/hq-workflow";
import {
  NonRetryableError,
  registeredTaskTypes,
  clearTaskHandlers,
  type RunContext,
} from "@/server/sdk/tasks";

function reset() {
  h.state.sagas = [];
  h.state.steps = [];
  h.state.tasks = [];
  h.state.activity = [];
}
beforeEach(reset);

function saga(id: string, status = "running"): Row {
  const row: Row = { id, status, title: `saga ${id}`, template_key: null };
  h.state.sagas.push(row);
  return row;
}
function step(over: Partial<Row> & { id: string; saga_id: string; ordinal: number }): Row {
  const row: Row = {
    title: `step ${over.ordinal}`,
    department: "Engineering",
    role: "engineer",
    depends_on_ordinal: null,
    hq_ai_task_id: null,
    status: "pending",
    created_at: "t",
    updated_at: "t",
    ...over,
  };
  h.state.steps.push(row);
  return row;
}

/** A minimal claimed-task context — the handler only reads task fields. */
function ctxFor(task: Partial<Row>): RunContext {
  return {
    task: {
      id: "task-ctx",
      task_type: SAGA_STEP_TASK_TYPE,
      subject_kind: "saga_step",
      subject_id: null,
      payload: {},
      ...task,
    },
  } as unknown as RunContext;
}

// ---------------------------------------------------------------------
// Source contract — the registration + wiring a grep proves.
// ---------------------------------------------------------------------

describe("saga_step · source contract", () => {
  const runnerSrc = readFileSync(
    path.join(process.cwd(), "server/services/hq-saga-step-runner.ts"),
    "utf8",
  );
  const workflowSrc = readFileSync(
    path.join(process.cwd(), "server/services/hq-workflow.ts"),
    "utf8",
  );

  it("the runner registers a handler for EXACTLY the type the dispatch enqueues", () => {
    expect(SAGA_STEP_TASK_TYPE).toBe("saga_step");
    expect(runnerSrc).toMatch(/registerTaskHandler\(SAGA_STEP_TASK_TYPE/);
    // The dispatch side of the contract: hq-workflow enqueues this same literal.
    expect(workflowSrc).toMatch(/taskType:\s*"saga_step"/);
  });

  it("the saga-drain calls the runner's drain (queued-orphaned tasks become claimable)", () => {
    expect(workflowSrc).toMatch(/drainSagaStepTasks\(/);
    expect(workflowSrc).toMatch(
      /import \{ drainSagaStepTasks \} from "@\/server\/services\/hq-saga-step-runner"/,
    );
  });
});

// ---------------------------------------------------------------------
// Registration — driving the real drain registers the type in the real SDK.
// ---------------------------------------------------------------------

describe("saga_step · registration in the SDK registry", () => {
  it("drainSagaStepTasks registers 'saga_step' and drains through the engine", async () => {
    clearTaskHandlers();
    const res = await drainSagaStepTasks(3);
    expect(res.ok).toBe(true);
    expect(registeredTaskTypes()).toContain("saga_step");
    // The drain reached the REAL engine surface (claim), found the queue empty.
    expect(h.claimTask).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Handler behaviour — the real handler against the in-memory substrate.
// ---------------------------------------------------------------------

describe("sagaStepHandler · deterministic execution", () => {
  it("executes a ready root step: envelope + provenance record", async () => {
    saga("s1");
    step({ id: "st1", saga_id: "s1", ordinal: 1, status: "running" });

    const out = (await sagaStepHandler(
      ctxFor({ payload: { saga_id: "s1", step_id: "st1" } }),
    )) as Record<string, unknown>;

    expect(out.outcome).toBe("executed");
    const exec = out.step_execution as Record<string, unknown>;
    expect(exec.kind).toBe("saga_step_execution");
    expect((exec.step as Row).id).toBe("st1");
    expect((exec.saga as Row).id).toBe("s1");
    expect(exec.dependency).toBeNull();
    // The provenance record landed, attributed to the step.
    const act = h.state.activity.find((a) => a.action === "saga.step_executed");
    expect(act).toBeTruthy();
    expect(act!.targetId).toBe("st1");
  });

  it("executes a dependent step only when its dependency is done — and records the edge", async () => {
    saga("s1");
    step({ id: "st1", saga_id: "s1", ordinal: 1, status: "done" });
    step({
      id: "st2",
      saga_id: "s1",
      ordinal: 2,
      depends_on_ordinal: 1,
      status: "running",
    });

    const out = (await sagaStepHandler(
      ctxFor({ payload: { step_id: "st2" } }),
    )) as Record<string, unknown>;
    expect(out.outcome).toBe("executed");
    const exec = out.step_execution as Record<string, unknown>;
    expect(exec.dependency).toEqual({ ordinal: 1, status: "done" });
  });

  it("RETRYABLE: a dependency not yet done throws a plain (retryable) error", async () => {
    saga("s1");
    step({ id: "st1", saga_id: "s1", ordinal: 1, status: "running" });
    step({ id: "st2", saga_id: "s1", ordinal: 2, depends_on_ordinal: 1, status: "running" });

    const attempt = sagaStepHandler(ctxFor({ payload: { step_id: "st2" } }));
    await expect(attempt).rejects.toThrow(/dependency/);
    await expect(
      sagaStepHandler(ctxFor({ payload: { step_id: "st2" } })),
    ).rejects.not.toBeInstanceOf(NonRetryableError);
  });

  it("TERMINAL: no step id at all (payload AND subject empty) is non-retryable", async () => {
    await expect(
      sagaStepHandler(ctxFor({ payload: {}, subject_kind: "other", subject_id: null })),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("TERMINAL: a vanished step row is non-retryable", async () => {
    await expect(
      sagaStepHandler(ctxFor({ payload: { step_id: "ghost" } })),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("falls back to the task subject when the payload carries no step_id", async () => {
    saga("s1");
    step({ id: "st1", saga_id: "s1", ordinal: 1, status: "running" });
    const out = (await sagaStepHandler(
      ctxFor({ payload: {}, subject_kind: "saga_step", subject_id: "st1" }),
    )) as Record<string, unknown>;
    expect(out.outcome).toBe("executed");
  });

  it("IDEMPOTENT: an already-terminal step is a no-op (crash re-claim safety)", async () => {
    saga("s1");
    step({ id: "st1", saga_id: "s1", ordinal: 1, status: "done" });

    const out = (await sagaStepHandler(
      ctxFor({ payload: { step_id: "st1" } }),
    )) as Record<string, unknown>;
    expect(out.outcome).toBe("already_terminal");
    // No second execution record for a terminal step.
    expect(h.state.activity.filter((a) => a.action === "saga.step_executed")).toHaveLength(0);
  });

  it("a terminal saga freezes its stragglers — explicit no-op, not silent-stuck", async () => {
    saga("s1", "abandoned");
    step({ id: "st1", saga_id: "s1", ordinal: 1, status: "running" });

    const out = (await sagaStepHandler(
      ctxFor({ payload: { step_id: "st1" } }),
    )) as Record<string, unknown>;
    expect(out.outcome).toBe("saga_terminal");
  });
});

// ---------------------------------------------------------------------
// Step-state mapping — the sync half that turns a completed task into a done
// step (and a failed task into a failed step, escalating the saga honestly).
// ---------------------------------------------------------------------

describe("saga_step · task-status → step-status mapping (via the drain's re-sync)", () => {
  async function syncOne(taskStatus: string): Promise<Row> {
    reset();
    saga("s1");
    h.state.tasks.push({ id: "t1", dedupe_key: "saga_step:st1", status: taskStatus });
    step({ id: "st1", saga_id: "s1", ordinal: 1, hq_ai_task_id: "t1", status: "running" });
    await drainReadySagaSteps();
    return h.state.steps.find((s) => s.id === "st1")!;
  }

  it("completed → done; the saga rolls to done", async () => {
    const st = await syncOne("completed");
    expect(st.status).toBe("done");
    expect(h.state.sagas.find((s) => s.id === "s1")!.status).toBe("done");
  });

  it("failed → failed; the saga escalates to blocked (the honest terminal-failure state)", async () => {
    const st = await syncOne("failed");
    expect(st.status).toBe("failed");
    expect(h.state.sagas.find((s) => s.id === "s1")!.status).toBe("blocked");
  });

  it("cancelled → skipped", async () => {
    expect((await syncOne("cancelled")).status).toBe("skipped");
  });

  it("blocked → blocked", async () => {
    expect((await syncOne("blocked")).status).toBe("blocked");
  });

  it("in-flight (running) stays running — no fabricated progress", async () => {
    expect((await syncOne("running")).status).toBe("running");
  });
});
