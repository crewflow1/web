import { describe, expect, it } from "vitest";
import {
  assertScoreIsSumOfFactors,
  generateRota,
  SOLVER_SCORE,
  type MemberQualification,
  type RotaPlanInput,
} from "@/lib/schedule/solver";
import { buildScheduleWindow } from "@/lib/schedule/window";
import type { ScheduledJobRow } from "@/lib/schedule/conflicts";

/**
 * The OPTIONAL skill-match term of the deterministic rota solver.
 *
 * The term must (1) be inert unless BOTH a job requirement and member
 * qualifications are supplied — so every existing plan is byte-identical; (2)
 * PREFER a holder without EXCLUDING a non-holder (a soft, positive-only factor);
 * (3) stay explainable — the delta is exactly the shown factor and the score is
 * the sum of the factors. No model, no clock: pure.
 */

const NOW = new Date("2026-08-10T09:00:00Z");
const WINDOW = buildScheduleWindow(NOW);

function job(over: Partial<ScheduledJobRow> & { id: string }): ScheduledJobRow {
  return {
    id: over.id,
    assigned_to: over.assigned_to ?? null,
    scheduled_date: over.scheduled_date ?? "2026-08-12",
    status: over.status ?? "new",
    customer_name: over.customer_name ?? "Acme",
  };
}

function baseInput(over: Partial<RotaPlanInput> = {}): RotaPlanInput {
  return {
    window: WINDOW,
    rota: [],
    jobs: [job({ id: "j-1" })],
    leave: [],
    custody: [],
    roster: [
      { userId: "u-alice", name: "Alice", role: "staff" },
      { userId: "u-zoe", name: "Zoe", role: "staff" },
    ],
    ...over,
  };
}

const holds = (id: string, ...types: string[]): readonly MemberQualification[] =>
  types.map((t, i) => ({ id: `${id}-q${i}`, qualificationType: t }));

describe("skill match is inert without inputs (backward compatible)", () => {
  it("emits no skill_match factor when the job declares no requirement", () => {
    const plan = generateRota(baseInput());
    for (const a of plan.assignments) {
      expect(a.factors.some((f) => f.code === "skill_match")).toBe(false);
    }
  });

  it("produces a byte-identical plan with and without empty skill maps", () => {
    const without = generateRota(baseInput());
    const withEmpty = generateRota(
      baseInput({
        jobRequiredQualifications: new Map(),
        memberQualifications: new Map(),
      }),
    );
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(without));
  });
});

describe("skill match prefers a holder without excluding a non-holder", () => {
  const input = baseInput({
    jobRequiredQualifications: new Map([["j-1", ["cscs"]]]),
    memberQualifications: new Map([["u-alice", holds("u-alice", "cscs")]]),
  });

  it("chooses the qualified member even against the alphabetically-first name", () => {
    const plan = generateRota(input);
    expect(plan.assignments).toHaveLength(1);
    // Alice holds CSCS; Zoe does not. Alice wins on skill, not on name order.
    expect(plan.assignments[0]!.userId).toBe("u-alice");
    // Both were still feasible — the non-holder was not gated out.
    expect(plan.assignments[0]!.candidateCount).toBe(2);
  });

  it("scores the holder with the exact per-qual delta and cites the record", () => {
    const plan = generateRota(input);
    const skill = plan.assignments[0]!.factors.find((f) => f.code === "skill_match")!;
    expect(skill).toBeTruthy();
    expect(skill.delta).toBe(SOLVER_SCORE.perHeldRequiredQual);
    expect(skill.evidence).toEqual(["u-alice-q0"]);
    expect(assertScoreIsSumOfFactors(plan.assignments[0]!)).toBe(true);
  });

  it("still staffs the job with a non-holder when nobody is qualified", () => {
    const plan = generateRota(
      baseInput({
        jobRequiredQualifications: new Map([["j-1", ["cscs"]]]),
        memberQualifications: new Map(),
      }),
    );
    expect(plan.assignments).toHaveLength(1);
    const skill = plan.assignments[0]!.factors.find((f) => f.code === "skill_match")!;
    // A zero-delta factor that STILL names the unmet requirement.
    expect(skill.delta).toBe(0);
    expect(skill.text).toContain("holds none");
    expect(assertScoreIsSumOfFactors(plan.assignments[0]!)).toBe(true);
  });
});

describe("skill match is capped and deterministic", () => {
  it("caps the bonus so competence never dwarfs the availability gate", () => {
    const required = ["cscs", "smsts", "sssts", "first_aid"];
    const plan = generateRota(
      baseInput({
        roster: [{ userId: "u-alice", name: "Alice", role: "staff" }],
        jobRequiredQualifications: new Map([["j-1", required]]),
        memberQualifications: new Map([["u-alice", holds("u-alice", ...required)]]),
      }),
    );
    const skill = plan.assignments[0]!.factors.find((f) => f.code === "skill_match")!;
    // 4 × 45 = 180 would exceed the cap; it is clamped to skillMatchCap.
    expect(skill.delta).toBe(SOLVER_SCORE.skillMatchCap);
    expect(4 * SOLVER_SCORE.perHeldRequiredQual).toBeGreaterThan(SOLVER_SCORE.skillMatchCap);
    expect(assertScoreIsSumOfFactors(plan.assignments[0]!)).toBe(true);
  });

  it("counts only required types the member holds (extra tickets do not score)", () => {
    const plan = generateRota(
      baseInput({
        roster: [{ userId: "u-alice", name: "Alice", role: "staff" }],
        jobRequiredQualifications: new Map([["j-1", ["cscs", "smsts"]]]),
        // Holds CSCS (required) + first_aid (not required for this job).
        memberQualifications: new Map([["u-alice", holds("u-alice", "cscs", "first_aid")]]),
      }),
    );
    const skill = plan.assignments[0]!.factors.find((f) => f.code === "skill_match")!;
    expect(skill.delta).toBe(SOLVER_SCORE.perHeldRequiredQual); // 1 of 2 held
    expect(skill.text).toContain("holds 1 of 2 required");
  });
});
