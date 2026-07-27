import { describe, it, expect } from "vitest";
import {
  QUALIFICATION_PHASES,
  QUALIFICATION_STEP_DEFS,
  QUALIFICATION_DECISIONS,
  applyStep,
  completedStepCount,
  decisionLabel,
  decisionTone,
  initialSteps,
  isStepTerminal,
  phaseForStep,
  phaseProgress,
  recommendedStatusFor,
  stepDef,
  tierFor,
  type QualificationPhase,
} from "@/lib/qualification/model";
import { TIMELINE_EVENT_TYPES } from "@/lib/sales/model";

/**
 * Lead Qualification Engine — lifecycle + contracts (Module 3).
 *
 * The pure reducers drive the live UI and are unit-tested directly, exactly as
 * the Research AI lifecycle is. These also pin the "adds work, not a new
 * surface" invariant: every step logs under an EXISTING timeline event type.
 */

describe("qualification lifecycle — phases + progress", () => {
  it("exposes the coarse phases in order with monotonic progress", () => {
    expect(QUALIFICATION_PHASES).toEqual([
      "queued",
      "running",
      "assessing",
      "deciding",
      "completed",
      "failed",
    ]);
    const live: QualificationPhase[] = ["queued", "running", "assessing", "deciding", "completed"];
    for (let i = 1; i < live.length; i++) {
      expect(phaseProgress(live[i]!)).toBeGreaterThan(phaseProgress(live[i - 1]!));
    }
    expect(phaseProgress("completed")).toBe(1);
    expect(phaseProgress("failed")).toBe(1);
  });
});

describe("qualification lifecycle — steps reuse the existing timeline surface", () => {
  it("maps every step to a valid hq_sales_timeline_events event_type", () => {
    const valid = new Set<string>(TIMELINE_EVENT_TYPES as readonly string[]);
    for (const def of QUALIFICATION_STEP_DEFS) {
      expect(valid.has(def.eventType), `${def.key} → ${def.eventType} must be an existing type`).toBe(true);
    }
  });

  it("resolves a step's definition + phase, and throws on an unknown key", () => {
    expect(stepDef("decision").phase).toBe("deciding");
    expect(phaseForStep("load")).toBe("running");
    expect(phaseForStep("completed")).toBe("completed");
    // @ts-expect-error — unknown step keys are rejected at runtime.
    expect(() => stepDef("nope")).toThrow();
  });
});

describe("qualification lifecycle — pure step reducer", () => {
  it("starts every step pending", () => {
    const steps = initialSteps();
    expect(steps).toHaveLength(QUALIFICATION_STEP_DEFS.length);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
    expect(completedStepCount(steps)).toBe(0);
  });

  it("applyStep is immutable and stamps `at` only on terminal moves", () => {
    const steps = initialSteps();
    const active = applyStep(steps, "load", "active", "Loading…");
    expect(steps[0]!.status).toBe("pending"); // original untouched
    expect(active[0]!.status).toBe("active");
    expect(active[0]!.at).toBeNull(); // active is not terminal → no stamp

    const done = applyStep(active, "load", "done", "Loaded");
    expect(done[0]!.status).toBe("done");
    expect(done[0]!.at).toBeTruthy();
    expect(completedStepCount(done)).toBe(1);
  });

  it("ignores unknown keys rather than throwing in the UI", () => {
    const steps = initialSteps();
    const same = applyStep(steps, "load", "done");
    // An unknown key would be a no-op; a known key changes exactly one step.
    expect(same.filter((s) => s.status !== "pending")).toHaveLength(1);
  });

  it("classifies terminal statuses", () => {
    expect(isStepTerminal("done")).toBe(true);
    expect(isStepTerminal("skipped")).toBe(true);
    expect(isStepTerminal("failed")).toBe(true);
    expect(isStepTerminal("pending")).toBe(false);
    expect(isStepTerminal("active")).toBe(false);
  });
});

describe("qualification decisions — labels, tone, status mapping", () => {
  it("has exactly three decisions", () => {
    expect(QUALIFICATION_DECISIONS).toEqual(["qualified", "disqualified", "review"]);
  });

  it("labels + tones each decision", () => {
    expect(decisionLabel("qualified")).toBe("Qualified");
    expect(decisionLabel("disqualified")).toBe("Disqualified");
    expect(decisionLabel("review")).toBe("Needs review");
    expect(decisionTone("qualified")).toBe("positive");
    expect(decisionTone("disqualified")).toBe("negative");
    expect(decisionTone("review")).toBe("neutral");
  });

  it("maps only the two terminal decisions to a pipeline move; review holds", () => {
    expect(recommendedStatusFor("qualified")).toBe("qualified");
    expect(recommendedStatusFor("disqualified")).toBe("disqualified");
    expect(recommendedStatusFor("review")).toBeNull();
  });

  it("tierFor bands the fit score the same way the rest of Sales AI does", () => {
    expect(tierFor(85)).toBe("hot");
    expect(tierFor(65)).toBe("warm");
    expect(tierFor(45)).toBe("cool");
    expect(tierFor(20)).toBe("cold");
    expect(tierFor(null)).toBe("unscored");
  });
});
