import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  execute,
  planExecution,
  REFERENCE_EXECUTOR,
  type ToolImplementation,
} from "@/server/sdk/executor";
import {
  REFERENCE_TOOL_REGISTRY,
  memoryWriteTool,
  isReversibleTool,
  estimateToolCostMicros,
  type RegisteredTool,
  type ToolArgs,
} from "@/server/sdk/tools";
import { type GateVerdict, type ProposedAction } from "@/server/sdk/gate";

/**
 * CrewFlow HQ — executor trust-boundary invariants
 * (CEO Directive #014 / D-04, Phase C, increment C2; ADR 0009 Decisions 1, 3, 8, 9; the Executor
 * Boundary Rule + the Registry Immutability Rule).
 *
 * The executor (server/sdk/executor.ts) is MECHANISM: it applies an already-cleared action and
 * nothing else. By canon it must NOT decide autonomy, authorise capability, request approval,
 * drive the Task Engine, or make a real call of its own — the only effect it ever performs is the
 * INJECTED implementation the caller supplies (ADR 0009 Decision 3). And it CONSUMES the registry
 * read-only; it never mutates it (the Registry Immutability Rule). C2 proves this as a matter of
 * SOURCE, not discipline, exactly as the doorman's purity and the registry's are proven by source.
 *
 * Each fact below, and what breaks if it silently flips:
 *   • The module imports ONLY its sibling pure contracts `./tools` and `./gate` — no admin/service
 *     client, no facet, no Approval Engine, no Task Engine (`./tasks`), and no `server-only`. A
 *     single such import would let the executor reach AROUND its injected boundary for a side
 *     effect (and would break UI-importability).
 *   • The executable source names no execution construct (`.rpc(`/`.from(`/`fetch(`/a client
 *     factory), no approval/lifecycle call (`requestApproval`/`failTask`/`hq_ai_task_*`), and no
 *     policy decision (`evaluateAction`/`isReversibleTool`/`estimateToolCostMicros`). The executor
 *     consumes a verdict; it must not be able to PRODUCE one, nor re-run P4, nor touch the queue.
 *     (`parseToolArgs` and `invoke` are NOT forbidden — validating the typed target and calling the
 *     injected boundary are the executor's sanctioned work.)
 *   • The executor exposes only plan/apply/execute — no decide/authorise/approve member.
 *   • Behaviourally: it applies ONLY a cleared verdict (a refusal never reaches the boundary), it
 *     re-decides nothing (a needs-approval verdict is refused however good the action looks), and
 *     it never mutates the frozen registry it resolves from.
 *
 * Comment text is stripped first, so the prose that DOCUMENTS the contract (which names "approval",
 * "Task Engine", "evaluateAction", etc. to explain what the module does NOT do) can neither satisfy
 * a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Every module specifier the source imports — `from "x"` and bare `import "x"`. */
function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const bareRe = /\bimport\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  while ((m = bareRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

const EXECUTOR = "server/sdk/executor.ts";
const ALLOWED_IMPORTS = ["./tools", "./gate"];

// =====================================================================
// 0. The C2 contract file exists.
// =====================================================================

describe("executor — the contract exists", () => {
  it("ships server/sdk/executor.ts", () => {
    expect(existsSync(resolve(ROOT, EXECUTOR)), EXECUTOR).toBe(true);
  });
});

// =====================================================================
// 1. It imports only the sibling pure contracts — no client/facet/engine.
// =====================================================================

describe("executor — imports consume the contracts, they do not reach", () => {
  const code = codeOf(read(EXECUTOR));

  it("imports nothing but ./tools and ./gate", () => {
    const specs = importSpecifiers(code);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(ALLOWED_IMPORTS, `unexpected import: ${spec}`).toContain(spec);
    }
  });

  it("does not import server-only — the UI may import the contract (the output.ts discipline)", () => {
    expect(code).not.toContain("server-only");
  });

  it("reaches for no Task Engine, Approval Engine, client, or facet module", () => {
    for (const forbidden of [
      "./tasks", // the runner / Task Engine — no runner wiring in C2
      "hq-approvals",
      "hq-tasks",
      "supabase",
      "/facets",
      "admin",
    ]) {
      expect(code, `must not import ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 2. The source names no execution, approval, lifecycle, or decision verb.
// =====================================================================

describe("executor — the source applies only through its injected boundary", () => {
  const code = codeOf(read(EXECUTOR));

  it("contains no execution construct of its own (the only effect is the injected impl)", () => {
    for (const forbidden of [
      ".rpc(", // a SECURITY DEFINER call — that lives behind the injected boundary
      ".from(", // a table read/write
      "fetch(", // an external call (Phase D's gateway, not here)
      "createClient",
      "createServiceClient",
      "supabaseAdmin",
    ]) {
      expect(code, `must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("makes no approval or task-lifecycle call — policy/approval/lifecycle are not the executor's", () => {
    for (const forbidden of [
      "requestApproval",
      "approveApproval",
      "failTask",
      "checkpointTask",
      "hq_ai_task_complete",
      "hq_ai_task_fail",
    ]) {
      expect(code, `must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("re-runs no policy decision — it consumes a verdict, it never produces one or re-judges P4", () => {
    for (const forbidden of [
      "evaluateAction", // the gate's decision — the executor must not re-decide
      "isReversibleTool", // P4 atom 1 — already weighed by the gate
      "estimateToolCostMicros", // P4 atom 5 — already weighed by the gate
    ]) {
      expect(code, `must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 3. The executor exposes only plan/apply/execute.
// =====================================================================

describe("executor — it plans and applies, it does not decide", () => {
  it("exposes only plan/apply/execute members", () => {
    const keys = Object.keys(REFERENCE_EXECUTOR).sort();
    expect(keys).toEqual(["apply", "execute", "plan"]);
    for (const forbidden of ["decide", "classify", "evaluate", "authorise", "authorize", "approve", "gate"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 4. Behaviour — applies only cleared, re-decides nothing, never mutates.
// =====================================================================

const CLEARED: GateVerdict = { decision: "autonomous", reasons: [] };
const NOT_CLEARED: GateVerdict = { decision: "needs_approval", reasons: ["posture.requires_approval"] };

const actionFromTool = (tool: RegisteredTool, payload: ToolArgs): ProposedAction => ({
  type: tool.label,
  capability: tool.permission,
  subjectType: "lead",
  subjectId: "lead_1",
  reversible: isReversibleTool(tool),
  typedTarget: true,
  estimatedCostMicros: estimateToolCostMicros(tool, payload),
  payload,
});

function countingImpl(): { invoke: ToolImplementation; count: () => number } {
  let n = 0;
  const invoke: ToolImplementation = async () => {
    n += 1;
    return { ok: true };
  };
  return { invoke, count: () => n };
}

describe("executor — applies only what the gate cleared", () => {
  it("a non-cleared verdict is refused and NEVER reaches the injected boundary", async () => {
    const { invoke, count } = countingImpl();
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified" });
    const r = await execute(REFERENCE_TOOL_REGISTRY, action, NOT_CLEARED, invoke);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.reason).toBe("not_cleared");
    expect(count()).toBe(0); // the executor performed no effect
  });

  it("re-decides nothing — a needs-approval verdict is refused however reversible/in-scope the action looks", () => {
    // The action is a perfectly autonomous-looking reversible memory write; the verdict is the only
    // thing the executor reads, and it says needs_approval. The executor does not overrule the gate.
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified", score: 87 });
    const r = planExecution(REFERENCE_TOOL_REGISTRY, action, NOT_CLEARED);
    expect(r.ok).toBe(false);
  });

  it("a cleared verdict crosses the boundary exactly once through the injected impl", async () => {
    const { invoke, count } = countingImpl();
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified" });
    const r = await execute(REFERENCE_TOOL_REGISTRY, action, CLEARED, invoke);
    expect(r.ok).toBe(true);
    expect(count()).toBe(1);
  });
});

describe("executor — consumes the registry read-only, never mutates it (Registry Immutability Rule)", () => {
  it("resolves the SAME frozen registry object — not a copy — and produces a frozen plan", () => {
    const r = planExecution(
      REFERENCE_TOOL_REGISTRY,
      actionFromTool(memoryWriteTool, { verdict: "qualified" }),
      CLEARED,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.tool).toBe(memoryWriteTool); // identity — read-only reference into the registry
      expect(Object.isFrozen(r.plan.tool)).toBe(true);
      expect(Object.isFrozen(r.plan)).toBe(true);
    }
  });

  it("leaves the catalogue and its tools unchanged after a full execute", async () => {
    const labelsBefore = REFERENCE_TOOL_REGISTRY.labels();
    const listBefore = REFERENCE_TOOL_REGISTRY.list();
    await execute(
      REFERENCE_TOOL_REGISTRY,
      actionFromTool(memoryWriteTool, { verdict: "qualified" }),
      CLEARED,
      countingImpl().invoke,
    );
    expect(REFERENCE_TOOL_REGISTRY.labels()).toEqual(labelsBefore);
    expect(REFERENCE_TOOL_REGISTRY.list()).toEqual(listBefore);
    expect(REFERENCE_TOOL_REGISTRY.resolve("memory.write")).toBe(memoryWriteTool);
    expect(Object.isFrozen(memoryWriteTool)).toBe(true);
  });
});
