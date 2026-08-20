import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SDLC_LIFECYCLE,
  SDLC_STAGES,
  SDLC_STAGE_KEYS,
} from "@/lib/hq/workflow/sdlc";
import {
  decomposeDirective,
  getTemplate,
  SAGA_TEMPLATES,
} from "@/lib/hq/workflow/decompose";
import {
  validateStepGraph,
  hasCycle,
  isStepReady,
  stepRequiresApproval,
  type SagaStep,
} from "@/lib/hq/workflow/model";
import { PIPELINE_STAGES } from "@/lib/hq/boardroom-cards";

/**
 * The governed SDLC LIFECYCLE saga template — proofs.
 *
 * The lifecycle chain (Spec → Design → Engineering → Test → Documentation → Review →
 * Deployment) is built as a DETERMINISTIC template over the EXISTING saga engine. Two
 * tiers of proof here:
 *
 *   A. the PURE template contract — the chain instantiates in full, dependency
 *      ordering holds, exactly deployment is human-approval gated, the stage↔pipeline
 *      correspondence matches the service's DEPARTMENT_STAGE map, and decomposition is
 *      deterministic;
 *   B. the DRIVEN behaviour — the real `drainReadySagaSteps` service, over the same
 *      in-memory Supabase mock the drain suite uses, WALKS the whole chain one ready
 *      step at a time, dispatches idempotently (no double-fire), HALTS at the gated
 *      deployment for a human, and audits every advance.
 */

const NOW = new Date("2026-08-20T12:00:00.000Z");

// =====================================================================
// A. The pure template contract.
// =====================================================================

describe("SDLC lifecycle — the template is registered and well-formed", () => {
  it("is in the catalogue under its stable key", () => {
    expect(getTemplate("sdlc_lifecycle")).toBe(SDLC_LIFECYCLE);
    expect(SAGA_TEMPLATES).toContain(SDLC_LIFECYCLE);
  });

  it("instantiates the FULL seven-stage chain in order", () => {
    const res = decomposeDirective({ title: "Ship feature X", templateKey: "sdlc_lifecycle" }, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.steps).toHaveLength(SDLC_STAGE_KEYS.length);
    expect(res.plan.steps.map((s) => s.department)).toEqual([
      "Product",
      "Design",
      "Engineering",
      "QA",
      "Documentation",
      "Review",
      "Operations",
    ]);
    // 1-based contiguous ordinals in stage order.
    expect(res.plan.steps.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("is a well-formed, acyclic, single linear dependency chain", () => {
    const res = decomposeDirective({ title: "X", templateKey: "sdlc_lifecycle" }, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(validateStepGraph(res.plan.steps)).toEqual({ ok: true });
    expect(hasCycle(res.plan.steps)).toBe(false);
    // The root has no dependency; every later stage depends on exactly the one before.
    expect(res.plan.steps[0]!.dependsOnOrdinal).toBeNull();
    for (const s of res.plan.steps.slice(1)) {
      expect(s.dependsOnOrdinal).toBe(s.ordinal - 1);
    }
  });

  it("SDLC_STAGES and the produced template never drift", () => {
    expect(SDLC_LIFECYCLE.steps).toHaveLength(SDLC_STAGES.length);
    SDLC_LIFECYCLE.steps.forEach((step, i) => {
      const stage = SDLC_STAGES[i]!;
      expect(step.title).toBe(stage.title);
      expect(step.department).toBe(stage.department);
      expect(step.role).toBe(stage.role);
    });
    expect(SDLC_STAGES.map((s) => s.key)).toEqual([...SDLC_STAGE_KEYS]);
  });

  it("carries only real Master-Plan pipeline stages", () => {
    for (const stage of SDLC_STAGES) {
      expect(PIPELINE_STAGES).toContain(stage.pipelineStage);
    }
    // The chain covers exactly the delivery-lifecycle stages, in order.
    expect(SDLC_STAGES.map((s) => s.pipelineStage)).toEqual([
      "specification",
      "design",
      "engineering",
      "testing",
      "documentation",
      "review",
      "deployment",
    ]);
  });

  it("gates EXACTLY the deployment stage for human approval — every other stage is internal-build", () => {
    for (const stage of SDLC_STAGES) {
      // The declared expectation matches the model's real gate for the department.
      expect(stepRequiresApproval({ department: stage.department })).toBe(stage.requiresApproval);
    }
    const gated = SDLC_STAGES.filter((s) => s.requiresApproval).map((s) => s.key);
    expect(gated).toEqual(["deployment"]);
  });

  it("is DETERMINISTIC — identical inputs (even a different `now`) give an identical graph", () => {
    const a = decomposeDirective({ title: "Ship", templateKey: "sdlc_lifecycle" }, NOW);
    const b = decomposeDirective(
      { title: "Ship", templateKey: "sdlc_lifecycle" },
      new Date("2001-01-01T00:00:00.000Z"),
    );
    expect(a).toEqual(b);
  });
});

// =====================================================================
// B. Driven behaviour — the real service walks the whole chain.
// =====================================================================

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

/** Seed a real SDLC saga (planned) with its full seven-step chain, all pending. */
function seedSdlcSaga(sagaId = "sdlc-1"): void {
  h.state.sagas.push({
    id: sagaId,
    status: "planned",
    title: "SDLC saga",
    template_key: "sdlc_lifecycle",
    created_by: null,
    decision_id: null,
    created_at: "t",
    updated_at: "t",
  });
  SDLC_LIFECYCLE.steps.forEach((spec, i) => {
    h.state.steps.push({
      id: `st${i + 1}`,
      saga_id: sagaId,
      ordinal: i + 1,
      title: spec.title,
      department: spec.department,
      role: spec.role,
      depends_on_ordinal: spec.dependsOnOrdinal,
      hq_ai_task_id: null,
      status: "pending",
      created_at: "t",
      updated_at: "t",
    });
  });
}

const stepById = (id: string): Row => h.state.steps.find((s) => s.id === id)!;

/**
 * Drive the saga forward by simulating the employee runners: drain, then complete the
 * task behind any step the drain left `running`, and repeat. The drain snapshots
 * readiness at each pass start, so a stage takes effect over successive ticks (sync a
 * predecessor to `done` on one pass, dispatch the newly-ready step on the next) — the
 * same cross-tick progress the real cron makes. Stops once Review (st6) is done and the
 * gated Deployment (st7) is being held. Bounded so a stuck chain fails loudly.
 */
async function driveToDeploymentGate(): Promise<{ lastHeld: number; passes: number }> {
  let lastHeld = 0;
  for (let i = 1; i <= 60; i++) {
    const res = await drainReadySagaSteps();
    lastHeld = res.held_for_approval;
    if (stepById("st6").status === "done" && stepById("st7").status === "pending" && res.held_for_approval >= 1) {
      return { lastHeld, passes: i };
    }
    // The employee runners finish any dispatched (running) work between ticks.
    for (const s of h.state.steps) {
      if (s.status === "running" && typeof s.hq_ai_task_id === "string") {
        const t = h.state.tasks.find((t) => t.id === s.hq_ai_task_id);
        if (t) t.status = "completed";
      }
    }
  }
  throw new Error("chain never reached the deployment gate within the pass budget");
}

beforeEach(reset);

describe("SDLC lifecycle — the drain walks the whole chain one ready step at a time", () => {
  it("dispatches only the ready root first (dependency ordering holds)", async () => {
    seedSdlcSaga();
    const res = await drainReadySagaSteps();

    expect(res.steps_dispatched).toBe(1); // only Spec (st1), the root
    expect(res.held_for_approval).toBe(0); // deployment not reached yet
    expect(h.state.tasks).toHaveLength(1);
    expect(stepById("st1").status).toBe("running");
    // Every downstream stage is still waiting on its predecessor.
    for (const id of ["st2", "st3", "st4", "st5", "st6", "st7"]) {
      expect(stepById(id).hq_ai_task_id).toBeNull();
      expect(stepById(id).status).toBe("pending");
    }
  });

  it("advances Spec → Design → … → Review as each task completes, then HALTS at gated Deployment", async () => {
    seedSdlcSaga();
    const { lastHeld } = await driveToDeploymentGate();

    // The six internal-build stages all completed, in order.
    for (const id of ["st1", "st2", "st3", "st4", "st5", "st6"]) {
      expect(stepById(id).status, `${id} should be done`).toBe("done");
    }
    // Deployment / Operations is READY but APPROVAL-GATED — held for a human.
    expect(lastHeld).toBeGreaterThanOrEqual(1);
    expect(stepById("st7").status).toBe("pending"); // untouched — waits for manual advance
    expect(stepById("st7").hq_ai_task_id).toBeNull(); // no deployment task auto-created

    // Exactly six tasks were ever created — one per ungated stage, none for deployment —
    // and they were dispatched in strict lifecycle order.
    expect(h.state.tasks).toHaveLength(6);
    expect(h.state.tasks.map((t) => t.dedupe_key)).toEqual([
      "saga_step:st1",
      "saga_step:st2",
      "saga_step:st3",
      "saga_step:st4",
      "saga_step:st5",
      "saga_step:st6",
    ]);
    // The gated deployment stage was never audited as advanced by the drain.
    expect(
      h.state.activity.some((a) => a.action === "saga.step_advanced" && a.targetId === "st7"),
    ).toBe(false);
  });

  it("is IDEMPOTENT — a re-run creates no second task and does not re-dispatch the held gate", async () => {
    seedSdlcSaga();
    await driveToDeploymentGate(); // st6 done, st7 held
    const tasksAfter = h.state.tasks.length;
    expect(tasksAfter).toBe(6);

    const again = await drainReadySagaSteps();
    expect(h.state.tasks).toHaveLength(tasksAfter); // no new task
    expect(again.steps_dispatched).toBe(0); // nothing new dispatched (all done or gated)
    expect(again.held_for_approval).toBeGreaterThanOrEqual(1); // gate still held
    expect(stepById("st7").hq_ai_task_id).toBeNull();
  });

  it("audits every autonomous step advance (provenance)", async () => {
    seedSdlcSaga();
    await drainReadySagaSteps(); // dispatch the root

    const advances = h.state.activity.filter((a) => a.action === "saga.step_advanced");
    expect(advances.length).toBeGreaterThanOrEqual(1);
    expect((advances[0]!.metadata as Row).saga_id).toBe("sdlc-1");
    expect(advances[0]!.targetTable).toBe("hq_saga_steps");
  });

  it("a human's manual advance is the approval that releases the deployment gate", async () => {
    // The drain never dispatches Operations; only isStepReady + a manual advance can.
    // Proven here at the model level: the deployment step is READY once Review is done,
    // yet still gated — so the release is a deliberate human act, not automation.
    const res = decomposeDirective({ title: "X", templateKey: "sdlc_lifecycle" }, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const steps: SagaStep[] = res.plan.steps.map((s) =>
      s.ordinal === 6 ? { ...s, status: "done" } : s,
    );
    const deploy = steps.find((s) => s.ordinal === 7)!;
    expect(isStepReady(deploy, steps)).toBe(true); // dependency satisfied
    expect(stepRequiresApproval(deploy)).toBe(true); // yet still needs a human
  });
});
