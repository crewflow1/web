import { describe, it, expect } from "vitest";
import {
  planExecution,
  executePlan,
  execute,
  createExecutor,
  REFERENCE_EXECUTOR,
  type ToolImplementation,
} from "@/server/sdk/executor";
import {
  REFERENCE_TOOL_REGISTRY,
  memoryWriteTool,
  commSendTool,
  isReversibleTool,
  estimateToolCostMicros,
  type RegisteredTool,
  type ToolArgs,
} from "@/server/sdk/tools";
import {
  evaluateAction,
  type EmploymentPosture,
  type GateVerdict,
  type ProposedAction,
} from "@/server/sdk/gate";

/**
 * Unit proof for the executor contract — server/sdk/executor.ts
 * (CEO Directive #014 / D-04, Phase C, increment C2; ADR 0009 Decisions 1, 3, 8, 9; Volume XIII §12).
 *
 * The executor is MECHANISM: it applies an action the gate has CLEARED, and refuses everything
 * else (the Executor Boundary Rule). These pin: planExecution refuses a non-autonomous verdict, an
 * unknown tool, a permission mismatch, and ill-formed args — and otherwise produces a frozen,
 * validated plan resolved READ-ONLY from the registry (the Registry Immutability Rule); executePlan
 * crosses the boundary ONLY through an injected implementation, capturing a typed applied/failed
 * outcome without throwing; execute short-circuits a refusal before any effect; and — the heart of
 * C2 — the gate (not the executor) decides clearance, so a send-class action is refused while a
 * memory-class one is applied, with the executor never re-running P4 or mutating the registry.
 */

// ── Postures + a capability set, reused from the gate's own discipline. ──
const permits: EmploymentPosture = { canExecute: true, requiresApproval: false };
const caps = (tokens: readonly string[] = []) => ({ tokens, source: "ai_employees" as const });

// A hand-made cleared verdict — isolates a boundary check from the gate's own logic.
const CLEARED: GateVerdict = { decision: "autonomous", reasons: [] };
const NOT_CLEARED: GateVerdict = { decision: "needs_approval", reasons: ["p4.irreversible"] };

/** Compose a proposed action from a tool exactly as C1 established (type = label, capability = permission). */
const actionFromTool = (
  tool: RegisteredTool,
  payload: ToolArgs,
  over: Partial<ProposedAction> = {},
): ProposedAction => ({
  type: tool.label,
  capability: tool.permission,
  subjectType: "lead",
  subjectId: "lead_1",
  reversible: isReversibleTool(tool),
  typedTarget: true,
  estimatedCostMicros: estimateToolCostMicros(tool, payload),
  payload,
  ...over,
});

// A boundary that records what it received and how often it was called — never the real effect.
function spyImpl(result: unknown = { ok: true }): {
  invoke: ToolImplementation;
  calls: ToolArgs[];
} {
  const calls: ToolArgs[] = [];
  const invoke: ToolImplementation = async (args) => {
    calls.push(args);
    return result;
  };
  return { invoke, calls };
}

// =====================================================================
// 1. planExecution — refuses everything the gate did not clear.
// =====================================================================

describe("planExecution — the execution boundary refuses", () => {
  it("refuses a non-autonomous verdict — apply only what the gate cleared (Executor Boundary Rule)", () => {
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified" });
    const r = planExecution(REFERENCE_TOOL_REGISTRY, action, NOT_CLEARED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.reason).toBe("not_cleared");
  });

  it("refuses an unknown tool — there is nothing to apply", () => {
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified" }, { type: "nope.missing" });
    const r = planExecution(REFERENCE_TOOL_REGISTRY, action, CLEARED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.reason).toBe("unknown_tool");
  });

  it("refuses a capability that disagrees with the resolved tool's permission (integrity, not authorisation)", () => {
    // type resolves memory.write, but the action claims comm.send — a confused-deputy mismatch.
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified" }, { capability: "comm.send" });
    const r = planExecution(REFERENCE_TOOL_REGISTRY, action, CLEARED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.reason).toBe("permission_mismatch");
  });

  it("refuses ill-formed args — an untyped target may not be applied (P4 atom 3 at the boundary)", () => {
    const action = actionFromTool(memoryWriteTool, {}, { payload: { score: 999 } }); // no verdict; score out of range
    const r = planExecution(REFERENCE_TOOL_REGISTRY, action, CLEARED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.reason).toBe("invalid_args");
  });
});

// =====================================================================
// 2. planExecution — produces a frozen, validated plan for a cleared action.
// =====================================================================

describe("planExecution — prepares a cleared action", () => {
  it("resolves the tool read-only and validates the payload into a frozen plan", () => {
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified", score: 87 });
    const r = planExecution(REFERENCE_TOOL_REGISTRY, action, CLEARED);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.tool).toBe(memoryWriteTool); // the SAME frozen registry object — not a copy
      expect(r.plan.args).toMatchObject({ verdict: "qualified", score: 87 });
      expect(Object.isFrozen(r.plan)).toBe(true);
    }
  });

  it("validates (does not pass raw) the payload — zod strips unknown keys at the boundary", () => {
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified", extra: "dropme" } as ToolArgs);
    const r = planExecution(REFERENCE_TOOL_REGISTRY, action, CLEARED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.args).not.toHaveProperty("extra");
  });

  it("trusts the verdict — it does not re-run P4 (an action's own flags are not re-judged)", () => {
    // The action is marked irreversible/untyped, but the verdict is CLEARED: the executor applies
    // policy NOWHERE — it trusts the gate's clearance and plans regardless of the action's flags.
    const action = actionFromTool(
      memoryWriteTool,
      { verdict: "qualified" },
      { reversible: false, typedTarget: false },
    );
    const r = planExecution(REFERENCE_TOOL_REGISTRY, action, CLEARED);
    expect(r.ok).toBe(true);
  });
});

// =====================================================================
// 3. executePlan — crosses the boundary only via the injected impl.
// =====================================================================

describe("executePlan — applies through the injected boundary", () => {
  const plan = (() => {
    const r = planExecution(REFERENCE_TOOL_REGISTRY, actionFromTool(memoryWriteTool, { verdict: "qualified" }), CLEARED);
    if (!r.ok) throw new Error("fixture: expected a plan");
    return r.plan;
  })();

  it("captures the implementation's result as an applied outcome", async () => {
    const { invoke, calls } = spyImpl({ wrote: "qualified" });
    const outcome = await executePlan(plan, invoke);
    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") {
      expect(outcome.label).toBe("memory.write");
      expect(outcome.result).toEqual({ wrote: "qualified" });
    }
    expect(calls).toHaveLength(1); // applied exactly once
    expect(calls[0]).toMatchObject({ verdict: "qualified" }); // the VALIDATED args
  });

  it("captures a thrown Error as a failed outcome — it does not propagate", async () => {
    const invoke: ToolImplementation = async () => {
      throw new Error("boundary refused the tampered call");
    };
    const outcome = await executePlan(plan, invoke);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error).toBe("boundary refused the tampered call");
  });

  it("normalises a non-Error throw into a message", async () => {
    const raw: ToolImplementation = async () => {
      throw "raw string failure";
    };
    const weird: ToolImplementation = async () => {
      throw { not: "an error" };
    };
    expect(await executePlan(plan, raw)).toMatchObject({ status: "failed", error: "raw string failure" });
    expect(await executePlan(plan, weird)).toMatchObject({
      status: "failed",
      error: "tool implementation failed",
    });
  });
});

// =====================================================================
// 4. execute — plan then apply; a refusal short-circuits the boundary.
// =====================================================================

describe("execute — end-to-end, refusal before any effect", () => {
  it("a refusal NEVER reaches the injected implementation", async () => {
    const { invoke, calls } = spyImpl();
    const action = actionFromTool(commSendTool, { channel: "email", body: "hi" });
    const r = await execute(REFERENCE_TOOL_REGISTRY, action, NOT_CLEARED, invoke);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.reason).toBe("not_cleared");
    expect(calls).toHaveLength(0); // the boundary stayed shut
  });

  it("a cleared action crosses the boundary and reports its outcome", async () => {
    const { invoke, calls } = spyImpl({ id: "mem_1" });
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified" });
    const r = await execute(REFERENCE_TOOL_REGISTRY, action, CLEARED, invoke);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.outcome).toMatchObject({ status: "applied", label: "memory.write" });
    expect(calls).toHaveLength(1);
  });
});

// =====================================================================
// 5. createExecutor / REFERENCE_EXECUTOR — registry-bound facade.
// =====================================================================

describe("createExecutor — the registry-bound facade", () => {
  it("delegates plan/apply/execute to the pure functions and is frozen", async () => {
    const ex = createExecutor(REFERENCE_TOOL_REGISTRY);
    expect(Object.isFrozen(ex)).toBe(true);

    const action = actionFromTool(memoryWriteTool, { verdict: "qualified" });
    const planned = ex.plan(action, CLEARED);
    expect(planned.ok).toBe(true);

    const { invoke, calls } = spyImpl({ id: "mem_2" });
    const r = await ex.execute(action, CLEARED, invoke);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("ships REFERENCE_EXECUTOR bound to the C1 reference registry", () => {
    const planned = REFERENCE_EXECUTOR.plan(
      actionFromTool(memoryWriteTool, { verdict: "qualified" }),
      CLEARED,
    );
    expect(planned.ok).toBe(true);
  });
});

// =====================================================================
// 6. The heart of C2 — the GATE decides clearance; the executor applies.
// =====================================================================

describe("the gate decides, the executor applies only what is cleared", () => {
  it("a reversible, in-scope, in-budget memory tool is cleared by the gate and APPLIED", async () => {
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified", score: 87 });
    const verdict = evaluateAction(action, permits, caps(["memory.write"]), 1_000);
    expect(verdict.decision).toBe("autonomous"); // the gate cleared it

    const { invoke, calls } = spyImpl({ id: "mem_3" });
    const r = await execute(REFERENCE_TOOL_REGISTRY, action, verdict, invoke);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.outcome.status).toBe("applied");
    expect(calls).toHaveLength(1);
  });

  it("an irreversible send tool is NOT cleared by the gate, so the executor refuses it", async () => {
    const action = actionFromTool(commSendTool, { channel: "email", body: "hi" });
    const verdict = evaluateAction(action, permits, caps(["comm.send"]), 1_000);
    expect(verdict.decision).toBe("needs_approval"); // p4.irreversible routes to approval

    const { invoke, calls } = spyImpl();
    const r = await execute(REFERENCE_TOOL_REGISTRY, action, verdict, invoke);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.reason).toBe("not_cleared");
    expect(calls).toHaveLength(0);
  });

  it("never mutates the registry — the catalogue and its tools are unchanged after applying", async () => {
    const before = REFERENCE_TOOL_REGISTRY.labels();
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified" });
    await execute(REFERENCE_TOOL_REGISTRY, action, CLEARED, spyImpl().invoke);
    expect(REFERENCE_TOOL_REGISTRY.labels()).toEqual(before);
    expect(Object.isFrozen(memoryWriteTool)).toBe(true);
    expect(REFERENCE_TOOL_REGISTRY.resolve("memory.write")).toBe(memoryWriteTool);
  });
});
