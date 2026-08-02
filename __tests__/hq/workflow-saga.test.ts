import { describe, it, expect } from "vitest";
import {
  validateStepGraph,
  hasCycle,
  isStepReady,
  deriveSagaStatus,
  sagaProgress,
  isTerminalStep,
  SAGA_STATUSES,
  STEP_STATUSES,
  type SagaStep,
  type StepStatus,
} from "@/lib/hq/workflow/model";
import {
  decomposeDirective,
  getTemplate,
  SAGA_TEMPLATES,
} from "@/lib/hq/workflow/decompose";

/**
 * Workflow-Saga PURE MODEL + DETERMINISTIC decomposition — unit proofs.
 *
 * The graph model (validation, cycle detection, dependency readiness, honest status
 * rollup) and the template decomposition are pure and deterministic; these pin the
 * template → step-graph contract, dependency ordering, and the no-cycles guarantee.
 */

const NOW = new Date("2026-08-03T12:00:00.000Z");

function step(
  ordinal: number,
  dependsOnOrdinal: number | null,
  status: StepStatus = "pending",
): SagaStep {
  return { ordinal, title: `step ${ordinal}`, department: "Eng", role: "eng", dependsOnOrdinal, status };
}

// ---------------------------------------------------------------------
// validateStepGraph.
// ---------------------------------------------------------------------

describe("validateStepGraph", () => {
  it("accepts a well-formed linear chain", () => {
    const steps = [step(1, null), step(2, 1), step(3, 2)];
    expect(validateStepGraph(steps)).toEqual({ ok: true });
  });

  it("accepts a branch (two steps depending on the same earlier step)", () => {
    const steps = [step(1, null), step(2, 1), step(3, 1)];
    expect(validateStepGraph(steps).ok).toBe(true);
  });

  it("rejects an empty graph", () => {
    const res = validateStepGraph([]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toMatch(/at least one step/);
  });

  it("rejects duplicate ordinals", () => {
    const res = validateStepGraph([step(1, null), step(1, null)]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/duplicate ordinal 1/);
  });

  it("rejects non-contiguous ordinals", () => {
    const res = validateStepGraph([step(1, null), step(3, 1)]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/not contiguous/);
  });

  it("rejects a dependency on a non-existent ordinal", () => {
    const res = validateStepGraph([step(1, null), step(2, 9)]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/does not exist/);
  });

  it("rejects a dependency on a LATER step (edges must point earlier)", () => {
    const res = validateStepGraph([step(1, 2), step(2, null)]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/LATER step/);
  });

  it("rejects a self-dependency", () => {
    // Self-dep on a valid ordinal; validated distinctly from the 'later step' rule.
    const res = validateStepGraph([step(1, null), { ...step(2, 2) }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toMatch(/depends on itself/);
  });
});

// ---------------------------------------------------------------------
// hasCycle — the no-cycles guarantee, proven directly.
// ---------------------------------------------------------------------

describe("hasCycle", () => {
  it("is false for an acyclic chain", () => {
    expect(hasCycle([step(1, null), step(2, 1), step(3, 2)])).toBe(false);
  });

  it("detects a two-node cycle (1↔2)", () => {
    // A graph the ordinal-ordering rule would also reject, but hasCycle proves the
    // acyclicity independently of that rule.
    expect(hasCycle([step(1, 2), step(2, 1)])).toBe(true);
  });

  it("detects a self-loop", () => {
    expect(hasCycle([step(1, 1)])).toBe(true);
  });

  it("is false for a branch (single-predecessor forest)", () => {
    expect(hasCycle([step(1, null), step(2, 1), step(3, 1)])).toBe(false);
  });
});

// ---------------------------------------------------------------------
// isStepReady — dependency readiness.
// ---------------------------------------------------------------------

describe("isStepReady", () => {
  it("a root step is always ready", () => {
    const steps = [step(1, null)];
    expect(isStepReady(steps[0]!, steps)).toBe(true);
  });

  it("a dependent step is NOT ready until its predecessor is done", () => {
    const steps = [step(1, null, "running"), step(2, 1)];
    expect(isStepReady(steps[1]!, steps)).toBe(false);
  });

  it("a dependent step becomes ready once its predecessor is done", () => {
    const steps = [step(1, null, "done"), step(2, 1)];
    expect(isStepReady(steps[1]!, steps)).toBe(true);
  });

  it("an unsatisfiable dependency (missing predecessor) is fail-safe: not ready", () => {
    const steps = [step(2, 1)]; // predecessor 1 absent
    expect(isStepReady(steps[0]!, steps)).toBe(false);
  });
});

// ---------------------------------------------------------------------
// deriveSagaStatus — the honest rollup.
// ---------------------------------------------------------------------

describe("deriveSagaStatus", () => {
  it("no steps → planned", () => {
    expect(deriveSagaStatus([])).toBe("planned");
  });

  it("all pending → planned", () => {
    expect(deriveSagaStatus([step(1, null), step(2, 1)])).toBe("planned");
  });

  it("any running → running", () => {
    expect(deriveSagaStatus([step(1, null, "running"), step(2, 1)])).toBe("running");
  });

  it("blocked with nothing running → blocked", () => {
    expect(deriveSagaStatus([step(1, null, "blocked"), step(2, 1)])).toBe("blocked");
  });

  it("running wins over blocked", () => {
    expect(deriveSagaStatus([step(1, null, "blocked"), step(2, 1, "running")])).toBe("running");
  });

  it("all done → done", () => {
    expect(deriveSagaStatus([step(1, null, "done"), step(2, 1, "done")])).toBe("done");
  });

  it("all terminal but one failed → blocked (never a false 'done')", () => {
    expect(deriveSagaStatus([step(1, null, "done"), step(2, 1, "failed")])).toBe("blocked");
  });

  it("done + skipped (all terminal, no failures) → done", () => {
    expect(deriveSagaStatus([step(1, null, "done"), step(2, 1, "skipped")])).toBe("done");
  });

  it("never derives 'abandoned' (a human-only terminal act)", () => {
    // Exhaust a spread of arrangements; none may produce 'abandoned'.
    const arrangements: StepStatus[][] = [
      ["pending"],
      ["running", "blocked"],
      ["done", "failed"],
      ["done", "skipped"],
      ["blocked", "pending"],
    ];
    for (const statuses of arrangements) {
      const steps = statuses.map((st, i) => step(i + 1, i === 0 ? null : i, st));
      expect(deriveSagaStatus(steps)).not.toBe("abandoned");
    }
  });
});

describe("sagaProgress + isTerminalStep", () => {
  it("counts each status and computes donePct", () => {
    const steps = [step(1, null, "done"), step(2, 1, "running"), step(3, 2, "pending"), step(4, 3, "done")];
    const p = sagaProgress(steps);
    expect(p).toMatchObject({ total: 4, done: 2, running: 1, pending: 1, donePct: 50 });
  });

  it("isTerminalStep is true only for done/skipped/failed", () => {
    expect(isTerminalStep("done")).toBe(true);
    expect(isTerminalStep("skipped")).toBe(true);
    expect(isTerminalStep("failed")).toBe(true);
    expect(isTerminalStep("pending")).toBe(false);
    expect(isTerminalStep("running")).toBe(false);
    expect(isTerminalStep("blocked")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Status vocabularies match the migration's CHECK sets.
// ---------------------------------------------------------------------

describe("status vocabularies", () => {
  it("saga statuses are the five the migration CHECK admits", () => {
    expect([...SAGA_STATUSES]).toEqual(["planned", "running", "blocked", "done", "abandoned"]);
  });
  it("step statuses are the six the migration CHECK admits", () => {
    expect([...STEP_STATUSES]).toEqual(["pending", "running", "blocked", "done", "skipped", "failed"]);
  });
});

// ---------------------------------------------------------------------
// decomposeDirective — deterministic template → step graph.
// ---------------------------------------------------------------------

describe("decomposeDirective", () => {
  it("every catalogue template yields a well-formed, acyclic graph", () => {
    for (const t of SAGA_TEMPLATES) {
      const res = decomposeDirective({ title: "X", templateKey: t.key }, NOW);
      expect(res.ok, `${t.key} should decompose`).toBe(true);
      if (res.ok) {
        expect(validateStepGraph(res.plan.steps)).toEqual({ ok: true });
        expect(hasCycle(res.plan.steps)).toBe(false);
      }
    }
  });

  it("assigns 1-based contiguous ordinals in template order", () => {
    const res = decomposeDirective({ title: "Launch", templateKey: "product_launch" }, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const ordinals = res.plan.steps.map((s) => s.ordinal);
      expect(ordinals).toEqual(ordinals.map((_, i) => i + 1));
      expect(res.plan.steps[0]!.title).toBe(getTemplate("product_launch")!.steps[0]!.title);
    }
  });

  it("produces steps born 'pending' and a saga born 'planned'", () => {
    const res = decomposeDirective({ title: "Launch", templateKey: "product_launch" }, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plan.status).toBe("planned");
      expect(res.plan.steps.every((s) => s.status === "pending")).toBe(true);
    }
  });

  it("is DETERMINISTIC — identical inputs (even different `now`) give identical graphs", () => {
    const a = decomposeDirective({ title: "Launch", templateKey: "incident_response" }, NOW);
    const b = decomposeDirective(
      { title: "Launch", templateKey: "incident_response" },
      new Date("2020-01-01T00:00:00.000Z"),
    );
    expect(a).toEqual(b);
  });

  it("carries the dependency edges from the template", () => {
    const res = decomposeDirective({ title: "Onboard", templateKey: "customer_onboarding" }, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The first step is a root; each later step depends on an earlier one.
      expect(res.plan.steps[0]!.dependsOnOrdinal).toBeNull();
      for (const s of res.plan.steps.slice(1)) {
        expect(s.dependsOnOrdinal).not.toBeNull();
        expect(s.dependsOnOrdinal!).toBeLessThan(s.ordinal);
      }
    }
  });

  it("refuses an unknown template", () => {
    const res = decomposeDirective({ title: "X", templateKey: "nope" }, NOW);
    expect(res).toEqual({ ok: false, error: "unknown_template" });
  });

  it("refuses an empty title", () => {
    const res = decomposeDirective({ title: "  ", templateKey: "product_launch" }, NOW);
    expect(res).toEqual({ ok: false, error: "title_required" });
  });
});
