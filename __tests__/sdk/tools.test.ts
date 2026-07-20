import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  defineTool,
  createToolRegistry,
  isReversibleTool,
  estimateToolCostMicros,
  parseToolArgs,
  memoryWriteTool,
  commSendTool,
  REFERENCE_TOOL_REGISTRY,
  type RegisteredTool,
  type ToolArgs,
} from "@/server/sdk/tools";
import { evaluateAction, type EmploymentPosture, type ProposedAction } from "@/server/sdk/gate";

/**
 * Unit proof for the typed tool registry — server/sdk/tools.ts
 * (CEO Directive #014 / D-04, Phase C, increment C1; ADR 0009 Decision 2; substrate Volume XIII §12).
 *
 * The registry DESCRIBES capability — it does not authorise it and it does not execute it (the
 * Executor Boundary Rule). These pin: the constructor produces frozen descriptive metadata; the
 * registry resolves/lists with stable order and rejects duplicate labels; the two P4-facing
 * properties derive correctly (reversibility → atom 1, cost estimate → atom 5, normalised); arg
 * validation is total; and — the heart of C1 — the tool-derived facts compose into the pure gate
 * exactly as the executor (C2) will consume them, with the gate (not the registry) still deciding.
 */

// ── Postures, reused from the gate's own discipline. ──────────────────
const permits: EmploymentPosture = { canExecute: true, requiresApproval: false };
const locked: EmploymentPosture = { canExecute: false, requiresApproval: true };
// A resolved capability set carrying the given tokens (source is informational to the gate).
const caps = (tokens: readonly string[] = []) => ({ tokens, source: "ai_employees" as const });

// =====================================================================
// 1. defineTool — frozen, descriptive metadata (no behaviour).
// =====================================================================

describe("defineTool — descriptive metadata", () => {
  it("preserves every declared property", () => {
    expect(memoryWriteTool.label).toBe("memory.write");
    expect(memoryWriteTool.permission).toBe("memory.write");
    expect(memoryWriteTool.reversibilityClass).toBe("reversible");
    expect(typeof memoryWriteTool.costEstimator).toBe("function");
    expect(memoryWriteTool.argSchema).toBeInstanceOf(z.ZodType);
  });

  it("returns a FROZEN tool — a tool is immutable data", () => {
    expect(Object.isFrozen(memoryWriteTool)).toBe(true);
    expect(Object.isFrozen(commSendTool)).toBe(true);
  });

  it("carries no invocation/execution member — it describes, it does not run", () => {
    const keys = Object.keys(memoryWriteTool);
    for (const forbidden of ["invoke", "run", "execute", "apply", "handler", "call"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 2. createToolRegistry — read-only index, stable order, unique labels.
// =====================================================================

describe("createToolRegistry — the catalogue", () => {
  it("resolves and reports membership by label", () => {
    expect(REFERENCE_TOOL_REGISTRY.resolve("memory.write")).toBe(memoryWriteTool);
    expect(REFERENCE_TOOL_REGISTRY.resolve("comm.send")).toBe(commSendTool);
    expect(REFERENCE_TOOL_REGISTRY.resolve("nope.missing")).toBeUndefined();
    expect(REFERENCE_TOOL_REGISTRY.has("memory.write")).toBe(true);
    expect(REFERENCE_TOOL_REGISTRY.has("nope.missing")).toBe(false);
  });

  it("lists tools and labels in a stable, label-sorted order", () => {
    expect(REFERENCE_TOOL_REGISTRY.labels()).toEqual(["comm.send", "memory.write"]);
    expect(REFERENCE_TOOL_REGISTRY.list().map((t) => t.label)).toEqual([
      "comm.send",
      "memory.write",
    ]);
  });

  it("freezes its listings — the catalogue is immutable", () => {
    expect(Object.isFrozen(REFERENCE_TOOL_REGISTRY.list())).toBe(true);
    expect(Object.isFrozen(REFERENCE_TOOL_REGISTRY.labels())).toBe(true);
  });

  it("rejects a duplicate label — resolution must be unambiguous", () => {
    expect(() => createToolRegistry([memoryWriteTool, memoryWriteTool])).toThrow(/duplicate/i);
  });
});

// =====================================================================
// 3. isReversibleTool — P4 atom 1 (reversible) as a tool property.
// =====================================================================

describe("isReversibleTool — P4 atom 1", () => {
  it("maps each reversibility class to the gate's reversible fact", () => {
    expect(isReversibleTool(memoryWriteTool)).toBe(true);
    expect(isReversibleTool(commSendTool)).toBe(false);
  });
});

// =====================================================================
// 4. estimateToolCostMicros — P4 atom 5, normalised to a non-neg int.
// =====================================================================

describe("estimateToolCostMicros — P4 atom 5", () => {
  it("returns the estimator's value for valid args", () => {
    expect(estimateToolCostMicros(commSendTool, { channel: "sms", body: "hi" })).toBe(1_000);
    expect(estimateToolCostMicros(commSendTool, { channel: "email", body: "hi" })).toBe(0);
    expect(estimateToolCostMicros(memoryWriteTool, { verdict: "qualified" })).toBe(0);
  });

  it("normalises a non-finite, negative, or fractional estimate", () => {
    const mk = (n: number): RegisteredTool =>
      defineTool({
        label: "probe.cost",
        permission: "probe.cost",
        argSchema: z.object({}),
        costEstimator: () => n,
        reversibilityClass: "reversible",
      });
    expect(estimateToolCostMicros(mk(-5), {})).toBe(0); // negative floors to 0
    expect(estimateToolCostMicros(mk(Number.NaN), {})).toBe(0); // NaN floors to 0
    expect(estimateToolCostMicros(mk(Number.POSITIVE_INFINITY), {})).toBe(0); // non-finite floors to 0
    expect(estimateToolCostMicros(mk(1.2), {})).toBe(2); // fractional rounds UP (never understated)
  });
});

// =====================================================================
// 5. parseToolArgs — typed-target validation (P4 atom 3), total.
// =====================================================================

describe("parseToolArgs — argument validation", () => {
  it("accepts arguments that satisfy the schema", () => {
    const r = parseToolArgs(memoryWriteTool, { verdict: "qualified", score: 87 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toMatchObject({ verdict: "qualified", score: 87 });
  });

  it("rejects arguments that violate the schema — without throwing", () => {
    const bad = parseToolArgs(commSendTool, { channel: "carrier-pigeon", body: "hi" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(typeof bad.error).toBe("string");

    const empty = parseToolArgs(commSendTool, { channel: "email", body: "" });
    expect(empty.ok).toBe(false);
  });
});

// =====================================================================
// 6. P4 COMPATIBILITY — the heart of C1: tool facts compose into the gate.
// =====================================================================

/**
 * Compose a proposed action from a tool exactly as the executor (C2) will: the gate's
 * `reversible` and `estimatedCostMicros` are DERIVED from the tool via the C1 helpers. This is
 * the typed contract the executor consumes — the registry supplies facts; the gate decides.
 */
const actionFromTool = (
  tool: RegisteredTool,
  args: ToolArgs,
  over: Partial<ProposedAction> = {},
): ProposedAction => ({
  type: tool.label,
  capability: tool.permission,
  subjectType: "lead",
  subjectId: "lead_1",
  reversible: isReversibleTool(tool),
  typedTarget: true,
  estimatedCostMicros: estimateToolCostMicros(tool, args),
  ...over,
});

describe("tool facts compose into the pure gate (P4 compatibility)", () => {
  it("a reversible, in-scope, in-budget tool routes AUTONOMOUS", () => {
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified", score: 87 });
    const v = evaluateAction(action, permits, caps(["memory.write"]), 1_000);
    expect(v).toEqual({ decision: "autonomous", reasons: [] });
  });

  it("an irreversible tool routes NEEDS_APPROVAL with p4.irreversible", () => {
    const action = actionFromTool(commSendTool, { channel: "email", body: "hi" });
    const v = evaluateAction(action, permits, caps(["comm.send"]), 1_000);
    expect(v.decision).toBe("needs_approval");
    expect(v.reasons).toContain("p4.irreversible");
  });

  it("a held permission that the employee LACKS routes scope.missing_capability", () => {
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified" });
    const v = evaluateAction(action, permits, caps([]), 1_000); // holds no tokens
    expect(v.decision).toBe("needs_approval");
    expect(v.reasons).toContain("scope.missing_capability");
  });

  it("the tool's cost estimate drives p4.over_budget (atom 5 flows from the registry)", () => {
    // Same irreversible tool, two channels: the SMS estimate (1_000) exceeds a 500 budget; email (0) does not.
    const sms = actionFromTool(commSendTool, { channel: "sms", body: "hi" });
    const email = actionFromTool(commSendTool, { channel: "email", body: "hi" });
    expect(evaluateAction(sms, permits, caps(["comm.send"]), 500).reasons).toContain("p4.over_budget");
    expect(evaluateAction(email, permits, caps(["comm.send"]), 500).reasons).not.toContain(
      "p4.over_budget",
    );
  });

  it("resolving a tool grants NO autonomy — the posture floor still gates every action", () => {
    // Even the otherwise-autonomous reversible tool routes to approval under the Built locked floor.
    const action = actionFromTool(memoryWriteTool, { verdict: "qualified" });
    const v = evaluateAction(action, locked, caps(["memory.write"]), 1_000);
    expect(v.decision).toBe("needs_approval");
    expect(v.reasons).toEqual(
      expect.arrayContaining(["posture.can_execute", "posture.requires_approval"]),
    );
  });
});

// =====================================================================
// 7. The reference surface exists (descriptive examples, no behaviour).
// =====================================================================

describe("reference tools", () => {
  it("ships memory.write (reversible) and comm.send (irreversible)", () => {
    expect(REFERENCE_TOOL_REGISTRY.labels()).toEqual(["comm.send", "memory.write"]);
    expect(memoryWriteTool.reversibilityClass).toBe("reversible");
    expect(commSendTool.reversibilityClass).toBe("irreversible");
  });
});
