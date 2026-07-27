import { describe, it, expect } from "vitest";
import {
  RESEARCH_PHASES,
  RESEARCH_PHASE_LABELS,
  RESEARCH_STEP_DEFS,
  RESEARCH_STEP_LABEL,
  applyStep,
  clampScore,
  completedStepCount,
  emptyIntelligence,
  employeeBandLabel,
  initialSteps,
  isStepTerminal,
  phaseForStep,
  phaseProgress,
  stepDef,
  type ResearchPhase,
  type ResearchStepKey,
} from "@/lib/research/model";

/**
 * Research AI — lifecycle contracts (CEO Directive 005, Phase 1 + 9).
 *
 * The coarse phase progression, the fine-grained live checklist reducer, and
 * the honest band helpers are the spine of the live UX and the audit trail.
 * These pin the behaviour the UI and runner depend on.
 */

describe("research phases", () => {
  it("names the eight directive phases in order", () => {
    expect(RESEARCH_PHASES).toEqual([
      "queued",
      "running",
      "researching",
      "analysing",
      "scoring",
      "reasoning",
      "completed",
      "failed",
    ]);
  });

  it("has a label for every phase", () => {
    for (const p of RESEARCH_PHASES) {
      expect(RESEARCH_PHASE_LABELS[p]).toBeTruthy();
    }
  });

  it("advances progress monotonically through the working phases", () => {
    const working: ResearchPhase[] = [
      "queued",
      "running",
      "researching",
      "analysing",
      "scoring",
      "reasoning",
      "completed",
    ];
    for (let i = 1; i < working.length; i++) {
      expect(phaseProgress(working[i]!)).toBeGreaterThan(
        phaseProgress(working[i - 1]!),
      );
    }
  });

  it("pins both terminal phases to a full bar", () => {
    expect(phaseProgress("completed")).toBe(1);
    expect(phaseProgress("failed")).toBe(1);
  });

  it("keeps every progress value within 0–1", () => {
    for (const p of RESEARCH_PHASES) {
      const v = phaseProgress(p);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("research step definitions", () => {
  it("defines eleven steps with unique keys", () => {
    expect(RESEARCH_STEP_DEFS).toHaveLength(11);
    const keys = new Set(RESEARCH_STEP_DEFS.map((s) => s.key));
    expect(keys.size).toBe(11);
  });

  it("maps every step onto a real phase and a label", () => {
    for (const def of RESEARCH_STEP_DEFS) {
      expect(RESEARCH_PHASES).toContain(def.phase);
      expect(def.label).toBeTruthy();
      expect(def.eventType).toBeTruthy();
      expect(RESEARCH_STEP_LABEL[def.key]).toBe(def.label);
      expect(phaseForStep(def.key)).toBe(def.phase);
    }
  });

  it("resolves a known step and throws on an unknown one", () => {
    expect(stepDef("website").key).toBe("website");
    expect(() => stepDef("nope" as ResearchStepKey)).toThrow();
  });

  it("ends with the completed step", () => {
    expect(RESEARCH_STEP_DEFS.at(-1)?.key).toBe("completed");
  });
});

describe("initialSteps", () => {
  it("returns one pending, unstamped state per defined step", () => {
    const steps = initialSteps();
    expect(steps).toHaveLength(RESEARCH_STEP_DEFS.length);
    for (const s of steps) {
      expect(s.status).toBe("pending");
      expect(s.detail).toBeNull();
      expect(s.at).toBeNull();
    }
  });
});

describe("isStepTerminal", () => {
  it("treats done/skipped/failed as terminal and pending/active as not", () => {
    expect(isStepTerminal("done")).toBe(true);
    expect(isStepTerminal("skipped")).toBe(true);
    expect(isStepTerminal("failed")).toBe(true);
    expect(isStepTerminal("pending")).toBe(false);
    expect(isStepTerminal("active")).toBe(false);
  });
});

describe("applyStep reducer", () => {
  it("stamps `at` only on a terminal transition", () => {
    const steps = initialSteps();
    const active = applyStep(steps, "website", "active", "fetching…", "2026-01-01T00:00:00Z");
    const websiteActive = active.find((s) => s.key === "website")!;
    expect(websiteActive.status).toBe("active");
    expect(websiteActive.detail).toBe("fetching…");
    // active is not terminal → no timestamp.
    expect(websiteActive.at).toBeNull();

    const done = applyStep(active, "website", "done", "ok", "2026-01-01T00:00:05Z");
    const websiteDone = done.find((s) => s.key === "website")!;
    expect(websiteDone.status).toBe("done");
    expect(websiteDone.at).toBe("2026-01-01T00:00:05Z");
  });

  it("ignores an unknown key without throwing or mutating the input", () => {
    const steps = initialSteps();
    const out = applyStep(steps, "ghost" as ResearchStepKey, "done");
    expect(out).toHaveLength(steps.length);
    expect(out.every((s) => s.status === "pending")).toBe(true);
    // original array untouched
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("touches only the targeted step", () => {
    const steps = initialSteps();
    const out = applyStep(steps, "score", "done", null, "2026-01-01T00:00:00Z");
    for (const s of out) {
      if (s.key === "score") expect(s.status).toBe("done");
      else expect(s.status).toBe("pending");
    }
  });
});

describe("completedStepCount", () => {
  it("counts only terminal steps", () => {
    let steps = initialSteps();
    expect(completedStepCount(steps)).toBe(0);
    steps = applyStep(steps, "website", "done");
    steps = applyStep(steps, "technology", "skipped");
    steps = applyStep(steps, "contacts", "active"); // not terminal
    steps = applyStep(steps, "companies_house", "failed");
    expect(completedStepCount(steps)).toBe(3);
  });
});

describe("employeeBandLabel", () => {
  it("maps headcount to honest bands and never invents precision", () => {
    expect(employeeBandLabel(null)).toBe("Unknown");
    expect(employeeBandLabel(5)).toBe("Micro (1–9)");
    expect(employeeBandLabel(9)).toBe("Micro (1–9)");
    expect(employeeBandLabel(10)).toBe("Small (10–49)");
    expect(employeeBandLabel(49)).toBe("Small (10–49)");
    expect(employeeBandLabel(50)).toBe("Mid (50–249)");
    expect(employeeBandLabel(249)).toBe("Mid (50–249)");
    expect(employeeBandLabel(250)).toBe("Large (250+)");
  });
});

describe("clampScore", () => {
  it("clamps to 0–100 and rounds", () => {
    expect(clampScore(-12)).toBe(0);
    expect(clampScore(150)).toBe(100);
    expect(clampScore(73.6)).toBe(74);
    expect(clampScore(0)).toBe(0);
    expect(clampScore(100)).toBe(100);
  });
});

describe("emptyIntelligence", () => {
  it("is honestly empty — every scalar null, every list empty", () => {
    const i = emptyIntelligence();
    expect(i.overview).toBeNull();
    expect(i.industry).toBeNull();
    expect(i.constructionSector).toBeNull();
    expect(i.employeeEstimate).toBeNull();
    expect(i.revenueEstimateGbp).toBeNull();
    expect(i.websiteQualityScore).toBeNull();
    expect(i.digitalMaturityScore).toBeNull();
    expect(i.confidence).toBeNull();
    expect(i.services).toEqual([]);
    expect(i.specialisms).toEqual([]);
    expect(i.locations).toEqual([]);
    expect(i.softwareUsed).toEqual([]);
    expect(i.painPoints).toEqual([]);
    expect(i.buyingSignals).toEqual([]);
    expect(i.growthIndicators).toEqual([]);
  });
});
