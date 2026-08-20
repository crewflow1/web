import { describe, it, expect } from "vitest";
import {
  executeVerified,
  featureHqAutonomousApplyEnabled,
  planExecution,
  verifiedToOutcome,
  type BoundToolImplementation,
  type ExecutionPlan,
} from "@/server/sdk/executor";
import { REFERENCE_TOOL_REGISTRY } from "@/server/sdk/tools";
import type { GateVerdict, ProposedAction } from "@/server/sdk/gate";

/**
 * CrewFlow HQ — the COMPLETED apply mechanism (P2 HQ Autonomous Apply): executeVerified runs the
 * full lifecycle — execute → verify → rollback — over a bound tool implementation, capturing the
 * immutable stage trail. The shadow only PLANNED; C2's executePlan only APPLIED; this is the whole
 * apply act, and verifiedToOutcome narrows it back to the stable outcome the apply-once store records.
 *
 * All of this is INERT in production: the build flag (featureHqAutonomousApplyEnabled) is off, so no
 * authority ever resolves a bound tool. These tests exercise the machinery DIRECTLY, behind the flag.
 */

const CLEARED: GateVerdict = { decision: "autonomous", reasons: [] };

/** A cleared, typed plan for the reversible reference tool `memory.write`. */
function memoryWritePlan(payload: Record<string, unknown> = { verdict: "qualified" }): ExecutionPlan {
  const action: ProposedAction = {
    type: "memory.write",
    subjectType: "lead",
    subjectId: "lead_1",
    reversible: true,
    typedTarget: true,
    payload,
  };
  const planned = planExecution(REFERENCE_TOOL_REGISTRY, action, CLEARED);
  if (!planned.ok) throw new Error(`test setup: plan refused: ${planned.refusal.reason}`);
  return planned.plan;
}

describe("featureHqAutonomousApplyEnabled — the production-execution lock is default OFF", () => {
  it("is true ONLY for the exact literal 'on'", () => {
    expect(featureHqAutonomousApplyEnabled({})).toBe(false);
    expect(featureHqAutonomousApplyEnabled({ FEATURE_HQ_AUTONOMOUS_APPLY: "" })).toBe(false);
    expect(featureHqAutonomousApplyEnabled({ FEATURE_HQ_AUTONOMOUS_APPLY: "ON" })).toBe(false);
    expect(featureHqAutonomousApplyEnabled({ FEATURE_HQ_AUTONOMOUS_APPLY: "true" })).toBe(false);
    expect(featureHqAutonomousApplyEnabled({ FEATURE_HQ_AUTONOMOUS_APPLY: "1" })).toBe(false);
    expect(featureHqAutonomousApplyEnabled({ FEATURE_HQ_AUTONOMOUS_APPLY: "on" })).toBe(true);
  });
});

describe("executeVerified — a happy apply with verification records approved → executed → verified", () => {
  it("crosses the boundary, verifies, and returns applied with the full stage trail", async () => {
    let applied = 0;
    let verified = 0;
    const bound: BoundToolImplementation = {
      label: "memory.write",
      apply: async (args) => {
        applied += 1;
        return { echoed: args };
      },
      verify: async () => {
        verified += 1;
        return true;
      },
    };
    const outcome = await executeVerified(memoryWritePlan(), bound);
    expect(applied).toBe(1);
    expect(verified).toBe(1);
    expect(outcome.status).toBe("applied");
    if (outcome.status === "applied") {
      expect(outcome.result).toEqual({ echoed: { verdict: "qualified" } });
    }
    expect(outcome.steps.map((s) => s.stage)).toEqual(["approved", "executed", "verified"]);
  });

  it("with no verifier, the boundary's success IS the outcome (approved → executed)", async () => {
    const bound: BoundToolImplementation = { label: "memory.write", apply: async () => ({ ok: true }) };
    const outcome = await executeVerified(memoryWritePlan(), bound);
    expect(outcome.status).toBe("applied");
    expect(outcome.steps.map((s) => s.stage)).toEqual(["approved", "executed"]);
  });
});

describe("executeVerified — a failed verification ROLLS BACK, and the outcome is a compensated failure", () => {
  it("runs rollback, records rolled_back, and returns failed(rolledBack:true)", async () => {
    let rolledBack = 0;
    const bound: BoundToolImplementation = {
      label: "memory.write",
      apply: async () => ({ id: "m1" }),
      verify: async () => false, // the effect did not land as intended
      rollback: async () => {
        rolledBack += 1;
      },
    };
    const outcome = await executeVerified(memoryWritePlan(), bound);
    expect(rolledBack).toBe(1);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.rolledBack).toBe(true);
      expect(outcome.error).toMatch(/verification failed/);
    }
    expect(outcome.steps.map((s) => s.stage)).toEqual(["approved", "executed", "rolled_back"]);
  });

  it("a failed verification with NO rollback available is an uncompensated failure", async () => {
    const bound: BoundToolImplementation = {
      label: "memory.write",
      apply: async () => ({ id: "m1" }),
      verify: async () => false,
    };
    const outcome = await executeVerified(memoryWritePlan(), bound);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.rolledBack).toBe(false);
    expect(outcome.steps.map((s) => s.stage)).toEqual(["approved", "executed", "failed"]);
  });

  it("a THROWING rollback is captured as a failed step, never propagated", async () => {
    const bound: BoundToolImplementation = {
      label: "memory.write",
      apply: async () => ({ id: "m1" }),
      verify: async () => false,
      rollback: async () => {
        throw new Error("rollback boom");
      },
    };
    const outcome = await executeVerified(memoryWritePlan(), bound);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.rolledBack).toBe(false);
    expect(outcome.steps.some((s) => s.detail.includes("rollback threw"))).toBe(true);
  });
});

describe("executeVerified — a throwing boundary never applies, and never propagates", () => {
  it("captures the boundary throw as failed (no rollback — there is no result to compensate)", async () => {
    const bound: BoundToolImplementation = {
      label: "memory.write",
      apply: async () => {
        throw new Error("boundary boom");
      },
      rollback: async () => {
        throw new Error("rollback must not be reached when apply itself threw");
      },
    };
    const outcome = await executeVerified(memoryWritePlan(), bound);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.rolledBack).toBe(false);
      expect(outcome.error).toBe("boundary boom");
    }
    expect(outcome.steps.map((s) => s.stage)).toEqual(["approved", "failed"]);
  });

  it("a THROWING verifier triggers rollback exactly like a false verifier", async () => {
    let rolledBack = 0;
    const bound: BoundToolImplementation = {
      label: "memory.write",
      apply: async () => ({ id: "m1" }),
      verify: async () => {
        throw new Error("verify boom");
      },
      rollback: async () => {
        rolledBack += 1;
      },
    };
    const outcome = await executeVerified(memoryWritePlan(), bound);
    expect(rolledBack).toBe(1);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error).toMatch(/verification threw/);
  });
});

describe("verifiedToOutcome — narrows the rich outcome to the stable apply-once outcome", () => {
  it("applied → applied (records the marker); anything else → failed (no stuck marker)", async () => {
    const okBound: BoundToolImplementation = { label: "memory.write", apply: async () => ({ ok: true }) };
    const ok = verifiedToOutcome(await executeVerified(memoryWritePlan(), okBound));
    expect(ok).toMatchObject({ status: "applied", label: "memory.write" });

    const badBound: BoundToolImplementation = {
      label: "memory.write",
      apply: async () => ({ ok: true }),
      verify: async () => false,
      rollback: async () => {},
    };
    const bad = verifiedToOutcome(await executeVerified(memoryWritePlan(), badBound));
    expect(bad.status).toBe("failed"); // a rolled-back apply is NEVER an applied marker
  });
});
