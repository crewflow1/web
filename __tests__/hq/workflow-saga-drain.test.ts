import { describe, it, expect, beforeEach, vi } from "vitest";
import { stepRequiresApproval, APPROVAL_GATED_DEPARTMENTS } from "@/lib/hq/workflow/model";

/**
 * The AUTONOMOUS saga-drain — behaviour proofs (no database).
 *
 * The drain replaces the manual-ONLY advance: it advances ready steps across active
 * sagas, EXCEPT steps mapping to an approval-gated action, which it HALTS on and
 * leaves for a human's manual advance. These execute the REAL service against a
 * stateful in-memory Supabase mock (sagas / steps / tasks) plus mocked Task-Engine
 * seams, proving the load-bearing behaviours a source grep cannot:
 *
 *   • advances a READY, ungated step (dispatches its task, syncs its status);
 *   • HALTS at a ready APPROVAL-GATED step (no task, step stays pending);
 *   • honours dependency edges (a step whose dependency isn't done is not dispatched);
 *   • re-syncs an already-linked step from its real task (progress propagation) —
 *     even a gated one, since sync is not a new action;
 *   • IDEMPOTENT: a second pass creates no second task.
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

  // Task-Engine enqueue: stable-dedupe by key, creates a 'pending' task.
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

  return { state, admin, enqueueTask };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/server/services/hq-tasks", () => ({
  enqueueTask: (input: Record<string, unknown>) => h.enqueueTask(input),
  setTaskStage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: (row: Record<string, unknown>) => {
    h.state.activity.push(row);
    return Promise.resolve(undefined);
  },
}));

import { drainReadySagaSteps } from "@/server/services/hq-workflow";

function reset() {
  h.state.sagas = [];
  h.state.steps = [];
  h.state.tasks = [];
  h.state.activity = [];
}

function saga(id: string, status = "planned"): Row {
  const row: Row = { id, status, title: `saga ${id}`, template_key: null, created_by: null, decision_id: null, created_at: "t", updated_at: "t" };
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

beforeEach(reset);

// ---------------------------------------------------------------------
// stepRequiresApproval — the pure gate.
// ---------------------------------------------------------------------

describe("stepRequiresApproval — the approval gate", () => {
  it("gates externally-visible / irreversible departments", () => {
    for (const dept of APPROVAL_GATED_DEPARTMENTS) {
      expect(stepRequiresApproval({ department: dept })).toBe(true);
      // Case-insensitive — roster casing drift cannot silently open a gate.
      expect(stepRequiresApproval({ department: dept.toUpperCase() })).toBe(true);
    }
  });

  it("does NOT gate internal-build departments", () => {
    for (const dept of ["Research", "Product", "Design", "Engineering", "QA"]) {
      expect(stepRequiresApproval({ department: dept })).toBe(false);
    }
  });

  it("gates a step with NO department (fail-safe)", () => {
    expect(stepRequiresApproval({ department: null })).toBe(true);
    expect(stepRequiresApproval({ department: "  " })).toBe(true);
  });
});

// ---------------------------------------------------------------------
// drainReadySagaSteps — autonomous behaviour.
// ---------------------------------------------------------------------

describe("drainReadySagaSteps — advances ready, ungated steps", () => {
  it("dispatches a ready ungated step and syncs its status", async () => {
    saga("s1");
    step({ id: "st1", saga_id: "s1", ordinal: 1, department: "Engineering" });

    const res = await drainReadySagaSteps();

    expect(res.steps_dispatched).toBe(1);
    expect(res.held_for_approval).toBe(0);
    expect(h.state.tasks).toHaveLength(1);
    const st = h.state.steps.find((s) => s.id === "st1")!;
    expect(st.hq_ai_task_id).toBe("task-1");
    expect(st.status).toBe("running"); // a pending task ⇒ running step
    // Saga rolled up to running.
    expect(h.state.sagas.find((s) => s.id === "s1")!.status).toBe("running");
  });
});

describe("drainReadySagaSteps — HALTS at approval-gated steps", () => {
  it("does not dispatch a ready gated step; it is held for a human", async () => {
    saga("s1");
    step({ id: "st1", saga_id: "s1", ordinal: 1, department: "Marketing" });

    const res = await drainReadySagaSteps();

    expect(res.steps_dispatched).toBe(0);
    expect(res.held_for_approval).toBe(1);
    expect(h.state.tasks).toHaveLength(0); // NO task created
    const st = h.state.steps.find((s) => s.id === "st1")!;
    expect(st.hq_ai_task_id).toBeNull();
    expect(st.status).toBe("pending"); // untouched — waits for manual advance
  });
});

describe("drainReadySagaSteps — honours dependency edges", () => {
  it("dispatches only the root; a step whose dependency isn't done waits", async () => {
    saga("s1");
    step({ id: "st1", saga_id: "s1", ordinal: 1, department: "Engineering" });
    step({ id: "st2", saga_id: "s1", ordinal: 2, department: "Engineering", depends_on_ordinal: 1 });

    const res = await drainReadySagaSteps();

    expect(res.steps_dispatched).toBe(1); // only st1
    expect(h.state.steps.find((s) => s.id === "st2")!.hq_ai_task_id).toBeNull();
    expect(h.state.steps.find((s) => s.id === "st2")!.status).toBe("pending");
  });
});

describe("drainReadySagaSteps — re-syncs already-linked steps (progress)", () => {
  it("flips a linked step to done when its task completed — even a gated one", async () => {
    saga("s1", "running");
    h.state.tasks.push({ id: "task-x", dedupe_key: "saga_step:st1", status: "completed" });
    step({
      id: "st1",
      saga_id: "s1",
      ordinal: 1,
      department: "Marketing", // gated, but already linked ⇒ sync is not a new action
      hq_ai_task_id: "task-x",
      status: "running",
    });

    const res = await drainReadySagaSteps();

    expect(res.steps_synced).toBe(1);
    expect(res.held_for_approval).toBe(0);
    expect(h.state.steps.find((s) => s.id === "st1")!.status).toBe("done");
  });
});

describe("drainReadySagaSteps — idempotency", () => {
  it("a second pass creates no second task", async () => {
    saga("s1");
    step({ id: "st1", saga_id: "s1", ordinal: 1, department: "Engineering" });

    await drainReadySagaSteps();
    expect(h.state.tasks).toHaveLength(1);

    const res2 = await drainReadySagaSteps();
    expect(h.state.tasks).toHaveLength(1); // no new task
    expect(res2.steps_dispatched).toBe(0); // already linked ⇒ re-sync, not dispatch
    expect(res2.steps_synced).toBe(1);
  });
});

describe("drainReadySagaSteps — never touches terminal sagas", () => {
  it("skips done/abandoned sagas entirely", async () => {
    saga("done1", "done");
    saga("gone1", "abandoned");
    step({ id: "st1", saga_id: "done1", ordinal: 1, department: "Engineering" });
    step({ id: "st2", saga_id: "gone1", ordinal: 1, department: "Engineering" });

    const res = await drainReadySagaSteps();

    expect(res.sagas_scanned).toBe(0);
    expect(res.steps_dispatched).toBe(0);
    expect(h.state.tasks).toHaveLength(0);
  });
});
