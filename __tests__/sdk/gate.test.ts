import { describe, it, expect } from "vitest";
import {
  evaluateAction,
  type EmploymentPosture,
  type GateReason,
  type GateVerdict,
  type ProposedAction,
} from "@/server/sdk/gate";

/**
 * Unit proof for the doorman — the pure permission gate (server/sdk/gate.ts)
 * (CEO Directive #014 / D-04, Phase B; ADR 0008 Decisions 4 & 8; substrate README §P4).
 *
 * The gate is the most security-critical code in the SDK, and it is a PURE FUNCTION — so its
 * deny-by-default contract is proven by a table of inputs, with no mocks and no transport.
 * These pin: the three doorman layers (posture · capability scope · the five P4 atoms), the
 * posture floor (can_execute=false / requires_approval=true is decisive on its own), each P4
 * atom mapped to exactly its {@link GateReason}, the declarative `autonomous ⇔ no reasons`
 * invariant, and purity (deterministic, non-mutating, fresh result each call). The gate
 * returns POLICY, never mechanism: there is nothing to mock because it calls nothing.
 */

// A posture that PERMITS autonomy — the opposite of the Built default-locked floor.
const permits: EmploymentPosture = { canExecute: true, requiresApproval: false };
// The Built default-locked floor (lib/ai-employees/model.ts normalizePermissions).
const locked: EmploymentPosture = { canExecute: false, requiresApproval: true };

// A resolved capability set carrying the given tokens (source is informational to the gate).
const caps = (tokens: readonly string[] = []) => ({ tokens, source: "ai_employees" as const });

/**
 * A baseline proposed action that — under `permits`, a matching capability set, and budget
 * headroom — passes every layer and atom (reversible, bounded, typed, no capability required,
 * no cost). Each test flips exactly what it is probing.
 */
const baseAction = (over: Partial<ProposedAction> = {}): ProposedAction => ({
  type: "memory.write",
  subjectType: "lead",
  subjectId: "lead_1",
  reversible: true,
  typedTarget: true,
  ...over,
});

// =====================================================================
// 0. The autonomous floor — every layer and atom passes.
// =====================================================================

describe("evaluateAction — the autonomous case", () => {
  it("permits an action that passes posture, scope, and all five P4 atoms", () => {
    const v = evaluateAction(baseAction(), permits, caps(), 1_000);
    expect(v).toEqual<GateVerdict>({ decision: "autonomous", reasons: [] });
  });

  it("decision is `autonomous` EXACTLY when there are no reasons", () => {
    const samples: GateVerdict[] = [
      evaluateAction(baseAction(), permits, caps(), 1_000), // passes
      evaluateAction(baseAction({ reversible: false }), permits, caps(), 1_000), // fails an atom
      evaluateAction(baseAction(), locked, caps(), 1_000), // fails posture
    ];
    for (const v of samples) {
      expect(v.decision === "autonomous").toBe(v.reasons.length === 0);
    }
  });
});

// =====================================================================
// 1. Layer 1 — employee posture is the floor (decisive on its own).
// =====================================================================

describe("evaluateAction — layer 1: the posture floor", () => {
  it("the Built default-locked posture forces approval even for an otherwise-autonomous action", () => {
    const v = evaluateAction(baseAction(), locked, caps(), 1_000); // every atom passes
    expect(v.decision).toBe("needs_approval");
    // the atoms all pass, so ONLY the two posture reasons are present
    expect(v.reasons).toEqual(["posture.can_execute", "posture.requires_approval"]);
  });

  it("can_execute=false is decisive even when requires_approval=false", () => {
    const v = evaluateAction(
      baseAction(),
      { canExecute: false, requiresApproval: false },
      caps(),
      1_000,
    );
    expect(v.decision).toBe("needs_approval");
    expect(v.reasons).toEqual(["posture.can_execute"]);
  });

  it("requires_approval=true is decisive even when can_execute=true and all atoms pass", () => {
    const v = evaluateAction(
      baseAction(),
      { canExecute: true, requiresApproval: true },
      caps(),
      1_000,
    );
    expect(v.decision).toBe("needs_approval");
    expect(v.reasons).toEqual(["posture.requires_approval"]);
  });
});

// =====================================================================
// 2. Single-cause failures — each layer/atom maps to EXACTLY its reason.
//    (Under `permits` posture, so only the probed check can fire.)
// =====================================================================

type FailureCase = {
  name: string;
  action: Partial<ProposedAction>;
  tokens?: readonly string[];
  budget?: number;
  reason: GateReason;
};

const SINGLE_FAILURES: readonly FailureCase[] = [
  { name: "irreversible action", action: { reversible: false }, reason: "p4.irreversible" },
  { name: "empty subject id (unbounded)", action: { subjectId: "" }, reason: "p4.blast_radius" },
  { name: "whitespace subject id (unbounded)", action: { subjectId: "   " }, reason: "p4.blast_radius" },
  { name: "wildcard subject id (unbounded)", action: { subjectId: "*" }, reason: "p4.blast_radius" },
  { name: "untyped target", action: { typedTarget: false }, reason: "p4.untyped_target" },
  {
    name: "capability not held",
    action: { capability: "email.send" },
    tokens: [],
    reason: "scope.missing_capability",
  },
  {
    name: "estimated cost exceeds budget",
    action: { estimatedCostMicros: 2_000 },
    budget: 1_000,
    reason: "p4.over_budget",
  },
  {
    name: "positive cost with no budget headroom",
    action: { estimatedCostMicros: 1 },
    budget: 0,
    reason: "p4.over_budget",
  },
];

describe("evaluateAction — single-cause failures map to exactly one reason", () => {
  for (const c of SINGLE_FAILURES) {
    it(`${c.name} → [${c.reason}]`, () => {
      const v = evaluateAction(
        baseAction(c.action),
        permits,
        caps(c.tokens ?? []),
        c.budget ?? 1_000,
      );
      expect(v.decision).toBe("needs_approval");
      expect(v.reasons).toEqual([c.reason]);
    });
  }
});

// =====================================================================
// 3. Boundary passes — the cases that must stay autonomous.
// =====================================================================

type PassCase = {
  name: string;
  action: Partial<ProposedAction>;
  tokens?: readonly string[];
  budget?: number;
};

const BOUNDARY_PASSES: readonly PassCase[] = [
  { name: "cost equals budget", action: { estimatedCostMicros: 1_000 }, budget: 1_000 },
  { name: "cost below budget", action: { estimatedCostMicros: 999 }, budget: 1_000 },
  { name: "no cost estimate, zero budget (a costless action)", action: {}, budget: 0 },
  { name: "zero cost, zero budget", action: { estimatedCostMicros: 0 }, budget: 0 },
  {
    name: "capability held",
    action: { capability: "email.send" },
    tokens: ["calendar.read", "email.send", "memory.write"],
  },
  { name: "no capability required (layer 2 does not fire)", action: {}, tokens: [] },
];

describe("evaluateAction — boundary cases that stay autonomous", () => {
  for (const c of BOUNDARY_PASSES) {
    it(`${c.name} → autonomous`, () => {
      const v = evaluateAction(
        baseAction(c.action),
        permits,
        caps(c.tokens ?? []),
        c.budget ?? 1_000,
      );
      expect(v).toEqual<GateVerdict>({ decision: "autonomous", reasons: [] });
    });
  }
});

// =====================================================================
// 4. Composition & deny-by-default — a complete, declarative explanation.
// =====================================================================

describe("evaluateAction — composition and deny-by-default", () => {
  it("collects ALL applicable reasons under the locked floor (not just the first)", () => {
    const v = evaluateAction(
      baseAction({
        capability: "email.send", // not held
        subjectId: "*", // unbounded
        reversible: false, // irreversible
        typedTarget: false, // untyped
        estimatedCostMicros: 5_000, // over budget
      }),
      locked, // can_execute=false, requires_approval=true
      caps([]), // holds nothing
      1_000,
    );
    expect(v.decision).toBe("needs_approval");
    // every failing layer/atom is named — and p4.out_of_scope is NOT emitted in Phase B
    // (it is the #015 parameter-scope seam), so it must be absent here.
    expect(new Set(v.reasons)).toEqual(
      new Set<GateReason>([
        "posture.can_execute",
        "posture.requires_approval",
        "scope.missing_capability",
        "p4.irreversible",
        "p4.blast_radius",
        "p4.untyped_target",
        "p4.over_budget",
      ]),
    );
    expect(v.reasons).not.toContain("p4.out_of_scope");
  });

  it("a wholly-empty descriptor under the locked floor never slips through as autonomous", () => {
    const v = evaluateAction(
      { type: "", subjectType: "", subjectId: "", reversible: false, typedTarget: false },
      locked,
      caps([]),
      0,
    );
    expect(v.decision).toBe("needs_approval");
    expect(v.reasons.length).toBeGreaterThan(0);
  });

  it("routes a reversible HQ-internal write to autonomous, an irreversible email to approval", () => {
    const internalWrite = evaluateAction(
      baseAction({ type: "memory.write", reversible: true, typedTarget: true }),
      permits,
      caps(),
      1_000,
    );
    expect(internalWrite.decision).toBe("autonomous");

    const email = evaluateAction(
      baseAction({ type: "email.send", capability: "email.send", reversible: false }),
      permits,
      caps(["email.send"]),
      1_000,
    );
    expect(email.decision).toBe("needs_approval");
    expect(email.reasons).toEqual(["p4.irreversible"]);
  });
});

// =====================================================================
// 5. Purity — declarative, deterministic, non-mutating.
// =====================================================================

describe("evaluateAction — purity (a declarative policy leaf)", () => {
  it("is deterministic: the same inputs yield deep-equal verdicts", () => {
    const a = evaluateAction(baseAction({ reversible: false }), permits, caps(), 1_000);
    const b = evaluateAction(baseAction({ reversible: false }), permits, caps(), 1_000);
    expect(a).toEqual(b);
  });

  it("mutates no input and triggers no side effect (frozen inputs are safe)", () => {
    const action = Object.freeze(baseAction({ capability: "x" }));
    const posture = Object.freeze({ ...locked });
    const tokens = Object.freeze(["y"]);
    const capabilities = Object.freeze({ tokens, source: "ai_employees" as const });
    expect(() => evaluateAction(action, posture, capabilities, 0)).not.toThrow();
    expect(tokens).toEqual(["y"]); // the capability set is read, never written
  });

  it("returns a FRESH reasons array each call (no shared mutable state)", () => {
    const a = evaluateAction(baseAction({ reversible: false }), permits, caps(), 1_000);
    const b = evaluateAction(baseAction({ reversible: false }), permits, caps(), 1_000);
    expect(a.reasons).not.toBe(b.reasons);
    a.reasons.push("p4.over_budget");
    expect(b.reasons).toEqual(["p4.irreversible"]); // b is unaffected by mutating a
  });
});
