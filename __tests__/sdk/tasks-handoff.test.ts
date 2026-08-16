import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit proof for the deterministic employee-to-employee handoff bus
 * (server/sdk/tasks.ts → ctx.tasks.handoff).
 *
 * A handoff is modelled as a CHILD task — parented to the running task, in the
 * SAME spine trace, carrying the source task's id on `depends_on` (the DAG
 * lineage), assigned to the target employee — PLUS an auditable `ai.handoff`
 * fact on the Event Spine. We mock ONLY the admin client's RPC surface, so the
 * REAL enqueue wrapper, the REAL events facet, and the REAL run-loop execute end
 * to end; only the database round-trip is faked. That pins the contract:
 *
 *   - handoff creates the child via hq_ai_task_create with parent_task_id = the
 *     running task, depends_on = [source, ...extra] (de-duped), assigned to the
 *     target, same correlation, created_by = this employee;
 *   - it emits exactly one `ai.handoff` fact (hq_emit_event) — object = the child
 *     task, target = the receiving employee, payload carries from/to + reason;
 *   - a dedupe hit is NOT a fresh handoff: the child id is returned but NO
 *     `ai.handoff` fact is emitted (no double-counting delegation);
 *   - a failed enqueue THROWS (the throw-based ABI), so the run records a failure.
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock, bind: () => rpcMock }),
}));
// The memory facet is imported transitively (ctx.memory); stub the embedding
// provider so the module graph never reaches for a network dep.
vi.mock("@/lib/ai/embeddings", () => ({ getEmbeddingProvider: vi.fn() }));

import { runReadyTask, type EmployeeIdentity } from "@/server/sdk/tasks";

const EMP = "11111111-1111-1111-1111-111111111111";
const IDENTITY: EmployeeIdentity = { employeeId: EMP, slug: "research-ai" };

type Row = Record<string, unknown>;

function makeTask(over: Row = {}): Row {
  return {
    id: "task-src",
    task_type: "research_company",
    status: "running",
    correlation_id: "corr-1",
    subject_kind: "company",
    subject_id: "co-1",
    cost_budget_micros: 0,
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
});

describe("ctx.tasks.handoff — deterministic employee-to-employee handoff", () => {
  it("enqueues a child task (parent + depends_on lineage, assigned to the target) and emits ai.handoff", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null };
      if (fn === "hq_ai_task_create")
        return { data: { ok: true, task: makeTask({ id: "task-child" }), deduped: false }, error: null };
      if (fn === "hq_emit_event") return { data: 42, error: null };
      if (fn === "hq_ai_task_complete")
        return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
      return { data: null, error: null };
    });

    let result: { taskId: string; deduped: boolean } | undefined;
    await runReadyTask(
      "research_company",
      async (ctx) => {
        result = await ctx.tasks.handoff({
          taskType: "qualify_company",
          toEmployeeId: "lead-qualification",
          reason: "research complete — qualify next",
          dependsOn: ["task-src", "dep-extra"],
        });
      },
      IDENTITY,
    );

    expect(result).toEqual({ taskId: "task-child", deduped: false });

    // The child task: parented + same trace + assigned to the target + lineage.
    expect(argsFor("hq_ai_task_create")).toMatchObject({
      p_task_type: "qualify_company",
      p_parent_task_id: "task-src",
      p_correlation_id: "corr-1",
      p_assigned_employee_id: "lead-qualification",
      p_created_by: "research-ai",
      p_subject_kind: "company", // inherited from the running task
      p_subject_id: "co-1",
    });
    // depends_on ALWAYS carries the source task, de-duped with the caller's extras.
    expect(argsFor("hq_ai_task_create")!.p_depends_on).toEqual(["task-src", "dep-extra"]);

    // Exactly one auditable handoff fact, object = child task, target = employee.
    expect(callsTo("hq_emit_event")).toBe(1);
    const evt = argsFor("hq_emit_event")!;
    expect(evt).toMatchObject({
      p_verb: "ai.handoff",
      p_object_type: "ai_task",
      p_object_id: "task-child",
      p_target_type: "ai_employee",
      p_target_id: "lead-qualification",
      p_actor_type: "ai_employee",
      p_actor_id: "research-ai",
    });
    expect(evt.p_payload).toMatchObject({
      from_task_id: "task-src",
      to_task_id: "task-child",
      from_employee: "research-ai",
      to_employee: "lead-qualification",
      task_type: "qualify_company",
      reason: "research complete — qualify next",
    });
  });

  it("a dedupe hit returns the child id but emits NO ai.handoff (no double-counted delegation)", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null };
      if (fn === "hq_ai_task_create")
        return { data: { ok: true, task: makeTask({ id: "task-existing" }), deduped: true }, error: null };
      if (fn === "hq_ai_task_complete")
        return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
      return { data: null, error: null };
    });

    let result: { taskId: string; deduped: boolean } | undefined;
    await runReadyTask(
      "research_company",
      async (ctx) => {
        result = await ctx.tasks.handoff({
          taskType: "qualify_company",
          toEmployeeId: "lead-qualification",
          reason: "dupe",
        });
      },
      IDENTITY,
    );

    expect(result).toEqual({ taskId: "task-existing", deduped: true });
    expect(callsTo("hq_emit_event")).toBe(0);
  });

  it("a failed enqueue THROWS → the runner fails the task", async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim")
        return { data: { ok: true, task: makeTask() }, error: null };
      if (fn === "hq_ai_task_create")
        return { data: null, error: { message: "boom" } };
      if (fn === "hq_ai_task_fail")
        return { data: { ok: true, task: makeTask({ status: "failed" }) }, error: null };
      return { data: null, error: null };
    });

    const outcome = await runReadyTask(
      "research_company",
      async (ctx) => {
        await ctx.tasks.handoff({ taskType: "qualify_company", reason: "x" });
      },
      IDENTITY,
    );

    expect(outcome.status).toBe("failed");
    expect(callsTo("hq_emit_event")).toBe(0);
  });
});
