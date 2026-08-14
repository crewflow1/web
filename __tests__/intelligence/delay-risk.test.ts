import { describe, it, expect } from "vitest";
import {
  computeDelayRiskBoard,
  delayRiskMetric,
  DEFAULT_DELAY_THRESHOLDS,
} from "@/lib/intelligence/delay-risk";
import type { ProgrammeVarianceRollup } from "@/lib/intelligence/programme-variance";
import type { ProgressRollup } from "@/lib/intelligence/progress-rollup";

/**
 * DELAY RISK — per-job independent factors, NO composite grade.
 *
 * Pins: factors attributed from the composed authorities with the right
 * severity thresholds, jobs sorted worst-first by a COUNT of high factors (not a
 * blended score), the empty board (no signals → nothing, never a false "green"),
 * and that the result carries no single delay grade.
 */

function programme(over: Partial<ProgrammeVarianceRollup>): ProgrammeVarianceRollup {
  return {
    jobsConsidered: 0,
    jobsWithBaseline: 0,
    jobsWithoutBaseline: 0,
    behindBaseline: [],
    overdueMilestoneCount: 0,
    jobsWithOverdueMilestones: 0,
    openEotWorkingDaysLost: 0,
    openEotEventCount: 0,
    openEotUnquantifiedCount: 0,
    recordedDelayEventCount: 0,
    withdrawnDelayEventCount: 0,
    draftDelayEventCount: 0,
    ...over,
  } as ProgrammeVarianceRollup;
}

function progress(over: Partial<ProgressRollup>): ProgressRollup {
  return {
    activeJobs: 0,
    assessedJobs: 0,
    neverAssessed: 0,
    stalled: [],
    regressing: [],
    ...over,
  } as ProgressRollup;
}

describe("computeDelayRiskBoard — factor attribution and severity", () => {
  const board = computeDelayRiskBoard({
    programme: programme({
      jobsConsidered: 3,
      overdueMilestoneCount: 2,
      openEotWorkingDaysLost: 5,
      behindBaseline: [
        { jobId: "j1", label: "Job 1", href: "/jobs/j1", revision: 1, plannedStart: "", plannedEnd: "", daysOverdue: 20 },
        { jobId: "j3", label: "Job 3", href: "/jobs/j3", revision: 1, plannedStart: "", plannedEnd: "", daysOverdue: 3 },
      ],
    }),
    progress: progress({
      activeJobs: 3,
      stalled: [{ jobId: "j2", label: "Job 2", href: "/jobs/j2", lastDay: "", daysSince: 25, lastPercent: 40 }],
      regressing: [
        { jobId: "j1", label: "Job 1", href: "/jobs/j1", fromDay: "", fromPercent: 60, latestDay: "", latestPercent: 45, drop: 15 },
      ],
    }),
  });

  it("bands behind-baseline high past the threshold, watch below it", () => {
    const j1 = board.jobs.find((j) => j.jobId === "j1")!;
    const behind = j1.factors.find((f) => f.key === "behind_baseline")!;
    expect(behind.severity).toBe("high"); // 20 ≥ 14
    const j3 = board.jobs.find((j) => j.jobId === "j3")!;
    expect(j3.factors.find((f) => f.key === "behind_baseline")!.severity).toBe("watch"); // 3 < 14
  });

  it("merges factors from both authorities onto the same job", () => {
    const j1 = board.jobs.find((j) => j.jobId === "j1")!;
    expect(j1.factors.map((f) => f.key).sort()).toEqual(["behind_baseline", "regressing"]);
    expect(j1.highFactorCount).toBe(2); // both high
  });

  it("sorts worst-first by the COUNT of high factors (a tally, not a weighted score)", () => {
    expect(board.jobs[0]!.jobId).toBe("j1"); // 2 high beats j2's 1 high
    expect(board.jobsAtRisk).toBe(2); // j1, j2
    expect(board.jobsWatch).toBe(1); // j3 (watch only)
    expect(board.factorCounts.behind_baseline).toBe(2);
    expect(board.factorCounts.stalled).toBe(1);
    expect(board.factorCounts.regressing).toBe(1);
  });

  it("carries programme-wide context and a heuristic metric", () => {
    expect(board.overdueMilestoneCount).toBe(2);
    expect(board.openEotWorkingDaysLost).toBe(5);
    const m = delayRiskMetric(board);
    expect(m.provenance.kind).toBe("heuristic");
    expect(m.provenance.basis).toMatch(/no combined delay score/i);
  });

  it("never emits a single blended delay grade", () => {
    expect(board).not.toHaveProperty("overallScore");
    expect(board).not.toHaveProperty("score");
    for (const j of board.jobs) {
      expect(j).not.toHaveProperty("score");
      expect(typeof j.highFactorCount).toBe("number"); // a count, not a grade
    }
  });
});

describe("computeDelayRiskBoard — thresholds are the exported config", () => {
  it("uses DEFAULT_DELAY_THRESHOLDS so the printed rule can't drift", () => {
    expect(DEFAULT_DELAY_THRESHOLDS.behindHighDays).toBeGreaterThan(0);
    const board = computeDelayRiskBoard({
      programme: programme({
        behindBaseline: [
          { jobId: "x", label: null, href: "/jobs/x", revision: 1, plannedStart: "", plannedEnd: "", daysOverdue: DEFAULT_DELAY_THRESHOLDS.behindHighDays },
        ],
      }),
      progress: progress({}),
    });
    expect(board.jobs[0]!.factors[0]!.severity).toBe("high"); // exactly at threshold = high
  });
});

describe("computeDelayRiskBoard — empty board (honesty path)", () => {
  it("returns no jobs when no signal fired — never a false all-clear over unmeasured jobs", () => {
    const board = computeDelayRiskBoard({
      programme: programme({ jobsConsidered: 5 }),
      progress: progress({ activeJobs: 5 }),
    });
    expect(board.jobs).toHaveLength(0);
    expect(board.jobsAtRisk).toBe(0);
    expect(board.jobsConsidered).toBe(5);
  });
});
