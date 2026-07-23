import { describe, it, expect } from "vitest";
import {
  riskRating, riskBand, canTransition, isEditable, validateHazard, validateRa,
  canIssue, overallRiskBand, RA_STATUSES,
} from "@/lib/health-safety/rams";

describe("riskRating + riskBand — the 5×5 matrix", () => {
  it("rating is likelihood × severity", () => {
    expect(riskRating(4, 5)).toBe(20);
    expect(riskRating(1, 1)).toBe(1);
  });
  it("bands follow the HSE construction convention at the boundaries", () => {
    expect(riskBand(1)).toBe("low");
    expect(riskBand(4)).toBe("low");
    expect(riskBand(5)).toBe("medium");
    expect(riskBand(9)).toBe("medium");
    expect(riskBand(10)).toBe("high");
    expect(riskBand(15)).toBe("high");
    expect(riskBand(16)).toBe("critical");
    expect(riskBand(25)).toBe("critical");
  });
});

describe("status lifecycle", () => {
  it("only a draft is editable", () => {
    expect(isEditable("draft")).toBe(true);
    for (const s of ["issued", "superseded", "withdrawn"] as const) expect(isEditable(s)).toBe(false);
  });
  it("allows exactly draft→issued, issued→superseded/withdrawn", () => {
    expect(canTransition("draft", "issued")).toBe(true);
    expect(canTransition("issued", "superseded")).toBe(true);
    expect(canTransition("issued", "withdrawn")).toBe(true);
    // disallowed
    expect(canTransition("draft", "superseded")).toBe(false);
    expect(canTransition("issued", "draft")).toBe(false);
    expect(canTransition("superseded", "issued")).toBe(false);
    expect(canTransition("withdrawn", "issued")).toBe(false);
  });
  it("every status is covered", () => {
    expect(RA_STATUSES).toEqual(["draft", "issued", "superseded", "withdrawn"]);
  });
});

describe("validateHazard", () => {
  const ok = { hazard: "Fall", likelihood: 4, severity: 5, controlMeasures: "Scaffold" };
  it("accepts a complete hazard", () => {
    expect(validateHazard(ok)).toEqual([]);
  });
  it("requires hazard + controls", () => {
    expect(validateHazard({ ...ok, hazard: " " })).toContain("Hazard is required.");
    expect(validateHazard({ ...ok, controlMeasures: "" })).toContain("At least one control measure is required.");
  });
  it("bounds likelihood + severity to 1–5", () => {
    expect(validateHazard({ ...ok, likelihood: 0 })).toContain("Likelihood must be 1–5.");
    expect(validateHazard({ ...ok, severity: 6 })).toContain("Severity must be 1–5.");
    expect(validateHazard({ ...ok, likelihood: 2.5 })).toContain("Likelihood must be 1–5.");
  });
  it("residual risk is both-or-neither and cannot exceed initial", () => {
    expect(validateHazard({ ...ok, residualLikelihood: 2 })).toContain("Residual risk needs both a likelihood and a severity, or neither.");
    // residual 4×5=20 > initial 1×1=1 → rejected
    expect(validateHazard({ hazard: "x", controlMeasures: "y", likelihood: 1, severity: 1, residualLikelihood: 4, residualSeverity: 5 }))
      .toContain("Residual risk cannot be higher than the initial risk.");
    // valid residual (lower)
    expect(validateHazard({ ...ok, residualLikelihood: 1, residualSeverity: 2 })).toEqual([]);
  });
});

describe("validateRa", () => {
  it("requires title + activity", () => {
    expect(validateRa({ title: "", activity: "" })).toEqual(
      expect.arrayContaining(["Title is required.", "Activity is required."]),
    );
  });
  it("rejects a review date before the assessment date", () => {
    expect(validateRa({ title: "t", activity: "a", assessmentDate: "2026-02-01", reviewDate: "2026-01-01" }))
      .toContain("Review date cannot be before the assessment date.");
  });
  it("accepts a valid header", () => {
    expect(validateRa({ title: "Roof", activity: "Tiling", assessmentDate: "2026-01-01", reviewDate: "2026-06-01" })).toEqual([]);
  });
});

describe("canIssue — a RAMS must be a complete safety document", () => {
  const base = { status: "draft" as const, title: "Roof", activity: "Tiling", assessorId: "u1", hazardCount: 1 };
  it("issues a complete draft", () => {
    expect(canIssue(base)).toEqual({ ok: true, reasons: [] });
  });
  it("blocks with reasons when incomplete", () => {
    expect(canIssue({ ...base, assessorId: null }).reasons).toContain("An assessor must be named.");
    expect(canIssue({ ...base, hazardCount: 0 }).reasons).toContain("At least one hazard must be assessed.");
    expect(canIssue({ ...base, status: "issued" }).reasons).toContain("Only a draft can be issued.");
    expect(canIssue({ ...base, title: " " }).ok).toBe(false);
  });
});

describe("overallRiskBand — worst residual across hazards", () => {
  it("is null with no hazards", () => {
    expect(overallRiskBand([])).toBeNull();
  });
  it("uses residual when present, initial otherwise, and takes the worst", () => {
    expect(overallRiskBand([
      { likelihood: 5, severity: 5, residualLikelihood: 1, residualSeverity: 1 }, // residual 1 → low
      { likelihood: 3, severity: 3 }, // initial 9 → medium
    ])).toBe("medium");
    expect(overallRiskBand([
      { likelihood: 5, severity: 5, residualLikelihood: 4, residualSeverity: 4 }, // residual 16 → critical
    ])).toBe("critical");
  });
});
