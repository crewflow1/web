import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * P4 — honest pipeline-stage stamping for standing task types.
 *
 * `setTaskStage` used to have ONE caller (the saga dispatch). The standing task
 * types with a NATURAL product-pipeline stage now stamp it the same way — at
 * dispatch, inside `enqueueTask`, through the one sanctioned stage RPC
 * (`hq_ai_task_set_stage`) — because the stage RPC freezes terminal rows, so
 * stamping "after completion" is structurally impossible.
 *
 * Pins:
 *   1. THE MAPPING IS DEFENDED AND CLOSED: exactly the three sales runners →
 *      'research', product_proposal → 'idea', and the thirteen exec reviews →
 *      'review'. Every value is a real PIPELINE_STAGES member. No forced
 *      mapping for types with no natural stage (support_reply_draft,
 *      saga_step — the saga path stamps its own DEPARTMENT_STAGE).
 *   2. ENQUEUE STAMPS mapped types through the set_stage RPC, and the returned
 *      row carries the stamped stage.
 *   3. NO stamp for unmapped types, and NO re-stamp on a deduped return (the
 *      original create already stamped).
 *   4. A failed stamp NEVER fails the enqueue (stage is presentation
 *      provenance, orthogonal to the execution lifecycle).
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

import {
  enqueueTask,
  TASK_TYPE_PIPELINE_STAGE,
  type TaskRow,
} from "@/server/services/hq-tasks";
import { PIPELINE_STAGES } from "@/lib/hq/boardroom-cards";

function taskRow(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-1",
    task_type: "research_company",
    status: "pending",
    pipeline_stage: null,
    payload: {},
    result: null,
    correlation_id: "corr-1",
    origin: "manual",
    ...over,
  } as unknown as TaskRow;
}

/** rpc dispatcher keyed by function name. */
function dispatch(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    const h = handlers[fn];
    if (!h) throw new Error(`unexpected rpc ${fn}`);
    return h(args);
  });
}

beforeEach(() => {
  rpcMock.mockReset();
});

describe("the mapping table — closed, defended, and stage-vocabulary-valid", () => {
  it("maps EXACTLY the defended set: 3 sales runners, product_proposal, 13 exec reviews", () => {
    expect(Object.keys(TASK_TYPE_PIPELINE_STAGE).sort()).toEqual(
      [
        // Sales runners — prospect intelligence + preparation ⇒ research.
        "research_company",
        "qualify_company",
        "generate_email",
        // Product AI demand→proposal sweep — the birth of an initiative ⇒ idea.
        "product_proposal",
        // The thirteen exec reviews — reviews of deterministic boards ⇒ review.
        "ceo_review",
        "cfo_review",
        "coo_review",
        "cto_review",
        "customer_success_review",
        "exec_assistant_review",
        "finance_review",
        "marketing_review",
        "operations_review",
        "product_review",
        "qa_review",
        "sales_review",
        "support_review",
      ].sort(),
    );
    expect(TASK_TYPE_PIPELINE_STAGE.research_company).toBe("research");
    expect(TASK_TYPE_PIPELINE_STAGE.qualify_company).toBe("research");
    expect(TASK_TYPE_PIPELINE_STAGE.generate_email).toBe("research");
    expect(TASK_TYPE_PIPELINE_STAGE.product_proposal).toBe("idea");
    for (const t of Object.keys(TASK_TYPE_PIPELINE_STAGE).filter((k) => k.endsWith("_review"))) {
      expect(TASK_TYPE_PIPELINE_STAGE[t]).toBe("review");
    }
  });

  it("every mapped stage is a real member of the fifteen-stage vocabulary", () => {
    for (const stage of Object.values(TASK_TYPE_PIPELINE_STAGE)) {
      expect(PIPELINE_STAGES).toContain(stage);
    }
  });

  it("does NOT force a stage onto types with no natural mapping", () => {
    // The saga path stamps its own DEPARTMENT_STAGE; support drafting and the
    // roster workers' ops tasks have no product-pipeline stage — unstaged is
    // the honest state.
    for (const t of [
      "saga_step",
      "support_reply_draft",
      "database_integrity",
      "orchestration_routing",
      "memory_curation",
    ]) {
      expect(TASK_TYPE_PIPELINE_STAGE[t]).toBeUndefined();
    }
  });
});

describe("enqueueTask stamps mapped types through the sanctioned set_stage RPC", () => {
  it("research_company: create → set_stage('research'), returning the stamped row", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    dispatch({
      hq_ai_task_create: (args) => {
        calls.push(["hq_ai_task_create", args]);
        return { data: { ok: true, task: taskRow(), deduped: false }, error: null };
      },
      hq_ai_task_set_stage: (args) => {
        calls.push(["hq_ai_task_set_stage", args]);
        return {
          data: { ok: true, task: taskRow({ pipeline_stage: "research" }) },
          error: null,
        };
      },
    });

    const res = await enqueueTask({ taskType: "research_company" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.task.pipeline_stage).toBe("research");
    expect(calls.map(([fn]) => fn)).toEqual(["hq_ai_task_create", "hq_ai_task_set_stage"]);
    expect(calls[1]![1]).toMatchObject({ p_task_id: "task-1", p_stage: "research" });
  });

  it("an exec review stamps 'review'", async () => {
    dispatch({
      hq_ai_task_create: () => ({
        data: { ok: true, task: taskRow({ task_type: "finance_review" }), deduped: false },
        error: null,
      }),
      hq_ai_task_set_stage: (args) => {
        expect(args.p_stage).toBe("review");
        return {
          data: { ok: true, task: taskRow({ task_type: "finance_review", pipeline_stage: "review" }) },
          error: null,
        };
      },
    });
    const res = await enqueueTask({ taskType: "finance_review" });
    expect(res.ok && res.task.pipeline_stage).toBe("review");
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it("an UNMAPPED type never touches the stage RPC", async () => {
    dispatch({
      hq_ai_task_create: () => ({
        data: { ok: true, task: taskRow({ task_type: "support_reply_draft" }), deduped: false },
        error: null,
      }),
    });
    const res = await enqueueTask({ taskType: "support_reply_draft" });
    expect(res.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("a DEDUPED return is not re-stamped (the original create already stamped)", async () => {
    dispatch({
      hq_ai_task_create: () => ({
        data: {
          ok: true,
          task: taskRow({ pipeline_stage: "research" }),
          deduped: true,
        },
        error: null,
      }),
    });
    const res = await enqueueTask({ taskType: "research_company" });
    expect(res.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("a FAILED stamp never fails the enqueue — the created task is returned unstaged", async () => {
    dispatch({
      hq_ai_task_create: () => ({
        data: { ok: true, task: taskRow(), deduped: false },
        error: null,
      }),
      hq_ai_task_set_stage: () => ({
        data: { ok: false, reason: "not_updatable" },
        error: null,
      }),
    });
    const res = await enqueueTask({ taskType: "research_company" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.task.id).toBe("task-1");
    expect(res.task.pipeline_stage).toBeNull();
  });
});
