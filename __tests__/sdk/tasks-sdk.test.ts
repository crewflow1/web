import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit proof for the task-runner SDK (server/sdk/tasks.ts)
 * (CEO Directive #012 / D-02, PR-C; Bible Volume XII §11.2 + XIII §21).
 *
 * The runner BINDS the service layer (server/services/hq-tasks.ts → the seven
 * SECURITY DEFINER entry points) into the one run-loop every employee inherits.
 * We mock ONLY the admin client's RPC surface, so the REAL service wrappers, the
 * REAL facet, the REAL registry and the REAL run-loop execute end to end — only
 * the database round-trip is faked. That lets us pin the contract precisely:
 *
 *   - the registry holds exactly one handler per task_type (re-register replaces);
 *   - the minimal RunContext is { task, identity, memory, tasks, correlationId,
 *     budgetMicros } — memory bound to THIS employee + task, budget a passthrough;
 *   - RULE 3: ctx.tasks exposes create + checkpoint ONLY — never complete/fail;
 *   - a handler that RETURNS completes the task with its value; one that THROWS
 *     fails it (retryable unless NonRetryableError) — the handler never calls a
 *     terminal entry point itself (rules 3 & 4);
 *   - an empty queue is a clean "empty" outcome, not an error or a run;
 *   - a lost lease at complete/fail surfaces as "lease_lost", not a crash;
 *   - ctx.tasks.create auto-threads provenance (parent + correlation + createdBy);
 *   - drain is claim-one-and-exit: it stops on empty and honours the maxTasks cap.
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));
// Memory facet is imported transitively (ctx.memory); no verb is called here, but
// stub the embedding provider so the module graph never reaches for a network dep.
vi.mock("@/lib/ai/embeddings", () => ({ getEmbeddingProvider: vi.fn() }));

import {
  registerTaskHandler,
  getTaskHandler,
  registeredTaskTypes,
  clearTaskHandlers,
  runReadyTask,
  drainTaskType,
  runEmployee,
  createTask,
  NonRetryableError,
  type RunContext,
  type RunnerIdentity,
} from "@/server/sdk/tasks";

const EMP = "11111111-1111-1111-1111-111111111111";
const IDENTITY: RunnerIdentity = { employeeId: EMP, slug: "research-ai" };

type Row = Record<string, unknown>;

function makeTask(over: Row = {}): Row {
  return {
    id: "task-1",
    task_type: "t",
    status: "running",
    correlation_id: "corr-1",
    cost_budget_micros: 1500,
    payload: {},
    result: null,
    ...over,
  };
}

/** Args of the first rpc() call to `fn` (or undefined). */
function argsFor(fn: string): Row | undefined {
  const call = rpcMock.mock.calls.find((c) => c[0] === fn);
  return call?.[1] as Row | undefined;
}

/** How many times `fn` was called. */
function callsTo(fn: string): number {
  return rpcMock.mock.calls.filter((c) => c[0] === fn).length;
}

beforeEach(() => {
  rpcMock.mockReset();
  clearTaskHandlers();
});

// =====================================================================
// The registry — single task_type → handler (CEO decision 3).
// =====================================================================

describe("task registry — one handler per type", () => {
  it("registers, looks up, and lists task types", () => {
    const handler = async () => ({ ok: true });
    registerTaskHandler("alpha", IDENTITY, handler);
    registerTaskHandler("beta", IDENTITY, handler);

    expect(getTaskHandler("alpha")?.handler).toBe(handler);
    expect(getTaskHandler("missing")).toBeUndefined();
    expect(registeredTaskTypes().sort()).toEqual(["alpha", "beta"]);
  });

  it("re-registering a type REPLACES the handler (exactly one per type)", () => {
    const first = async () => ({ n: 1 });
    const second = async () => ({ n: 2 });
    registerTaskHandler("alpha", IDENTITY, first);
    registerTaskHandler("alpha", IDENTITY, second);

    expect(getTaskHandler("alpha")?.handler).toBe(second);
    expect(registeredTaskTypes()).toEqual(["alpha"]);
  });

  it("clearTaskHandlers empties the registry (test isolation)", () => {
    registerTaskHandler("alpha", IDENTITY, async () => ({}));
    clearTaskHandlers();
    expect(registeredTaskTypes()).toEqual([]);
  });
});

// =====================================================================
// RunContext assembly + the ctx.tasks facet (rule 3).
// =====================================================================

describe("RunContext — the minimal, identity-bound surface", () => {
  it("binds memory to this employee + task, passes correlation and budget through", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null };
      if (fn === "hq_ai_task_complete")
        return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
      return { data: null, error: null };
    });

    let seen: RunContext | undefined;
    await runReadyTask("t", async (ctx) => {
      seen = ctx;
      return undefined;
    }, IDENTITY);

    expect(seen).toBeTruthy();
    expect(seen!.task.id).toBe("task-1");
    expect(seen!.identity.employeeId).toBe(EMP);
    expect(seen!.correlationId).toBe("corr-1");
    expect(seen!.budgetMicros).toBe(1500);
    // ctx.memory is the bound facet, stamped with this employee + the running task.
    expect(seen!.memory.identity.employeeId).toBe(EMP);
    expect(seen!.memory.identity.currentTaskId).toBe("task-1");
  });

  it("defaults budgetMicros to 0 when the task reserved none", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask({ cost_budget_micros: null }) }, error: null };
      return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
    });

    let budget = -1;
    await runReadyTask("t", async (ctx) => {
      budget = ctx.budgetMicros;
    }, IDENTITY);
    expect(budget).toBe(0);
  });

  it("RULE 3: ctx.tasks exposes create + checkpoint ONLY — never complete/fail", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null };
      return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
    });

    let facet: RunContext["tasks"] | undefined;
    await runReadyTask("t", async (ctx) => {
      facet = ctx.tasks;
    }, IDENTITY);

    expect(typeof facet!.create).toBe("function");
    expect(typeof facet!.checkpoint).toBe("function");
    // The terminal verbs are NOT on the handler's surface — the runner owns them.
    expect((facet as unknown as Record<string, unknown>).complete).toBeUndefined();
    expect((facet as unknown as Record<string, unknown>).fail).toBeUndefined();
  });
});

// =====================================================================
// The run-loop — return → complete, throw → fail (rules 3 & 4).
// =====================================================================

describe("runReadyTask — completion and failure are the RUNNER's, off return/throw", () => {
  it("a handler that RETURNS completes the task with its value", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null };
      if (fn === "hq_ai_task_complete")
        return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
      return { data: null, error: null };
    });

    const outcome = await runReadyTask("t", async () => ({ verdict: "done" }), IDENTITY);

    expect(outcome).toEqual({ status: "completed", taskId: "task-1" });
    expect(argsFor("hq_ai_task_complete")).toMatchObject({
      p_task_id: "task-1",
      p_result: { verdict: "done" },
    });
    expect(callsTo("hq_ai_task_fail")).toBe(0);
  });

  it("a handler that THROWS fails the task as RETRYABLE (re-queued → 'failed', retried)", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null };
      if (fn === "hq_ai_task_fail")
        return { data: { ok: true, task: makeTask({ status: "pending" }) }, error: null };
      return { data: null, error: null };
    });

    const outcome = await runReadyTask("t", async () => {
      throw new Error("transient upstream");
    }, IDENTITY);

    expect(outcome).toEqual({
      status: "failed",
      taskId: "task-1",
      retried: true,
      error: "transient upstream",
    });
    expect(argsFor("hq_ai_task_fail")).toMatchObject({
      p_error: "transient upstream",
      p_retryable: true,
    });
    expect(callsTo("hq_ai_task_complete")).toBe(0);
  });

  it("NonRetryableError fails the task TERMINALLY (p_retryable=false → 'failed', not retried)", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null };
      if (fn === "hq_ai_task_fail")
        return { data: { ok: true, task: makeTask({ status: "failed" }) }, error: null };
      return { data: null, error: null };
    });

    const outcome = await runReadyTask("t", async () => {
      throw new NonRetryableError("bad input");
    }, IDENTITY);

    expect(outcome).toMatchObject({ status: "failed", retried: false });
    expect(argsFor("hq_ai_task_fail")).toMatchObject({ p_retryable: false });
  });

  it("an empty queue is a clean 'empty' — the handler never runs, nothing is completed", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: false, reason: "empty" }, error: null };
      return { data: null, error: null };
    });

    let ran = false;
    const outcome = await runReadyTask("t", async () => {
      ran = true;
    }, IDENTITY);

    expect(outcome).toEqual({ status: "empty" });
    expect(ran).toBe(false);
    expect(callsTo("hq_ai_task_complete")).toBe(0);
    expect(callsTo("hq_ai_task_fail")).toBe(0);
  });

  it("a lost lease at complete surfaces as 'lease_lost', not a crash", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null };
      if (fn === "hq_ai_task_complete")
        return { data: { ok: false, reason: "lease_lost" }, error: null };
      return { data: null, error: null };
    });

    const outcome = await runReadyTask("t", async () => ({ ok: true }), IDENTITY);
    expect(outcome).toEqual({ status: "lease_lost", taskId: "task-1" });
  });

  it("each invocation mints a UNIQUE lease owner (no handler-supplied actor → no spoofing)", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null };
      return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
    });

    await runReadyTask("t", async () => ({}), IDENTITY);
    await runReadyTask("t", async () => ({}), IDENTITY);

    const owners = rpcMock.mock.calls
      .filter((c) => c[0] === "hq_ai_task_claim")
      .map((c) => (c[1] as Row).p_lease_owner as string);
    expect(owners).toHaveLength(2);
    expect(new Set(owners).size).toBe(2); // distinct per invocation
    for (const o of owners) expect(o).toContain("research-ai");
  });
});

// =====================================================================
// ctx.tasks — create (auto-provenance) + checkpoint.
// =====================================================================

describe("ctx.tasks facet", () => {
  it("create auto-threads parent + correlation + createdBy from the running task", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null };
      if (fn === "hq_ai_task_create")
        return { data: { ok: true, task: makeTask({ id: "child-1" }) }, error: null };
      if (fn === "hq_ai_task_complete")
        return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
      return { data: null, error: null };
    });

    let childId = "";
    await runReadyTask("t", async (ctx) => {
      childId = await ctx.tasks.create({ taskType: "child-work" });
    }, IDENTITY);

    expect(childId).toBe("child-1");
    expect(argsFor("hq_ai_task_create")).toMatchObject({
      p_task_type: "child-work",
      p_parent_task_id: "task-1", // parented to the running task
      p_correlation_id: "corr-1", // same spine trace
      p_created_by: "research-ai", // attributed to this employee
    });
  });

  it("checkpoint persists a partial result; a lost lease makes it THROW (→ runner fails the task)", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null };
      if (fn === "hq_ai_task_checkpoint") return { data: false, error: null }; // lease lost
      if (fn === "hq_ai_task_fail")
        return { data: { ok: true, task: makeTask({ status: "pending" }) }, error: null };
      return { data: null, error: null };
    });

    const outcome = await runReadyTask("t", async (ctx) => {
      await ctx.tasks.checkpoint({ progress: 0.5 });
      return { never: "reached" };
    }, IDENTITY);

    expect(argsFor("hq_ai_task_checkpoint")).toMatchObject({ p_result: { progress: 0.5 } });
    // checkpoint threw → handler aborted → runner recorded a failure, not a completion.
    expect(outcome.status).toBe("failed");
    expect(callsTo("hq_ai_task_complete")).toBe(0);
  });
});

// =====================================================================
// Drain (claim-one-and-exit) + runEmployee (registry-driven).
// =====================================================================

describe("drainTaskType — claim one, run, repeat; exit on empty or cap", () => {
  it("drains until the queue empties, then EXITS", async () => {
    let claims = 0;
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim") {
        claims++;
        if (claims <= 2)
          return { data: { ok: true, task: makeTask({ id: `task-${claims}` }) }, error: null };
        return { data: { ok: false, reason: "empty" }, error: null };
      }
      if (fn === "hq_ai_task_complete")
        return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
      return { data: null, error: null };
    });

    const summary = await drainTaskType("t", async () => ({}), IDENTITY);

    expect(summary.claimed).toBe(2);
    expect(summary.completed).toBe(2);
    expect(callsTo("hq_ai_task_claim")).toBe(3); // 2 tasks + 1 empty probe, then stop
  });

  it("honours the maxTasks cap (claim-one-and-exit, bounded per invocation)", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null }; // never empty
      if (fn === "hq_ai_task_complete")
        return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
      return { data: null, error: null };
    });

    const summary = await drainTaskType("t", async () => ({}), IDENTITY, { maxTasks: 2 });
    expect(summary.completed).toBe(2);
    expect(callsTo("hq_ai_task_claim")).toBe(2); // stopped at the cap, not on empty
  });
});

describe("runEmployee — drains the employee's registered types this tick", () => {
  it("resolves the handler from the registry and drains it", async () => {
    let claims = 0;
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim") {
        claims++;
        if (claims === 1) return { data: { ok: true, task: makeTask() }, error: null };
        return { data: { ok: false, reason: "empty" }, error: null };
      }
      if (fn === "hq_ai_task_complete")
        return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
      return { data: null, error: null };
    });

    registerTaskHandler("qualify.lead", IDENTITY, async () => ({ verdict: "qualified" }));
    const summary = await runEmployee({ identity: IDENTITY, taskTypes: ["qualify.lead"] });
    expect(summary.completed).toBe(1);
  });

  it("counts an unregistered type as an error rather than throwing", async () => {
    const summary = await runEmployee({ identity: IDENTITY, taskTypes: ["nope"] });
    expect(summary.errors).toBe(1);
    expect(summary.claimed).toBe(0);
  });
});

// =====================================================================
// Standalone enqueue (any subsystem) — throw-based ABI.
// =====================================================================

describe("createTask — standalone enqueue", () => {
  it("returns the new id + dedupe flag on success", async () => {
    rpcMock.mockImplementation(() => ({
      data: { ok: true, task: makeTask({ id: "new-1" }), deduped: true },
      error: null,
    }));
    const res = await createTask({ taskType: "x" });
    expect(res).toEqual({ id: "new-1", deduped: true });
  });

  it("throws when the enqueue fails (the SDK ABI is throw-based)", async () => {
    rpcMock.mockImplementation(() => ({ data: null, error: { message: "boom" } }));
    await expect(createTask({ taskType: "x" })).rejects.toThrow(/tasks.create failed: boom/);
  });
});
