import { describe, it, expect } from "vitest";
import { buildProgressSeries, summariseProgress } from "@/lib/job-progress/series";
import {
  REGRESSION_LOOKBACK_DAYS,
  STALLED_AFTER_DAYS,
  computeProgressRollup,
  regressingMetric,
  stalledMetric,
  type ProgressJobInput,
} from "@/lib/intelligence/progress-rollup";

/**
 * Progress rollup — composes the SERIES AUTHORITY's outputs. Fixtures are
 * built through buildProgressSeries/summariseProgress themselves (never
 * hand-rolled points), so this suite also proves the composition contract:
 * whatever the authority emits, the rollup can consume.
 */

const TODAY = "2026-08-01";
const NOW = new Date("2026-07-31T23:30:00Z"); // London 2026-08-01 — BST pin

function jobWith(
  jobId: string,
  readings: Array<{ day: string; percent: number }>,
): ProgressJobInput {
  const points = buildProgressSeries({
    observations: readings.map((r, i) => ({
      id: `obs-${jobId}-${i}`,
      observed_on: r.day,
      percent: r.percent,
      note: null,
      recorded_by: null,
    })),
  });
  return {
    jobId,
    label: `Site ${jobId}`,
    href: `/jobs/${jobId}`,
    points,
    summary: summariseProgress(points, NOW),
  };
}

describe("stalled — the stated 14-day rule", () => {
  it("flags a job silent for MORE than 14 days; 14 exactly is not stalled", () => {
    const rollup = computeProgressRollup(
      [
        jobWith("quiet", [{ day: "2026-07-17", percent: 40 }]), // 15 days → stalled
        jobWith("edge", [{ day: "2026-07-18", percent: 40 }]), // 14 days → not
        jobWith("fresh", [{ day: "2026-07-30", percent: 40 }]),
      ],
      TODAY,
    );
    expect(rollup.stalled.map((j) => j.jobId)).toEqual(["quiet"]);
    expect(rollup.stalled[0]!.daysSince).toBe(15);
    expect(STALLED_AFTER_DAYS).toBe(14); // the rule the basis quotes
  });

  it("a job never assessed is counted separately, NEVER called stalled", () => {
    const rollup = computeProgressRollup([jobWith("empty", [])], TODAY);
    expect(rollup.neverAssessed).toBe(1);
    expect(rollup.assessedJobs).toBe(0);
    expect(rollup.stalled).toEqual([]);
  });
});

describe("regressing — the exact ≥7-day comparison", () => {
  it("flags latest < a reading at least 7 days earlier", () => {
    const rollup = computeProgressRollup(
      [
        jobWith("back", [
          { day: "2026-07-20", percent: 60 },
          { day: "2026-07-27", percent: 55 }, // 7-day gap, lower → regressing
        ]),
      ],
      TODAY,
    );
    expect(rollup.regressing).toHaveLength(1);
    const r = rollup.regressing[0]!;
    expect(r.fromPercent).toBe(60);
    expect(r.latestPercent).toBe(55);
    expect(r.drop).toBe(5);
    expect(REGRESSION_LOOKBACK_DAYS).toBe(7);
  });

  it("a dip against a reading only 6 days earlier is NOT a regression", () => {
    const rollup = computeProgressRollup(
      [
        jobWith("noise", [
          { day: "2026-07-21", percent: 60 },
          { day: "2026-07-27", percent: 55 }, // 6-day gap → same-week noise
        ]),
      ],
      TODAY,
    );
    expect(rollup.regressing).toEqual([]);
  });

  it("measures the fall from the HIGHEST qualifying earlier reading", () => {
    const rollup = computeProgressRollup(
      [
        jobWith("multi", [
          { day: "2026-07-01", percent: 70 },
          { day: "2026-07-10", percent: 50 },
          { day: "2026-07-28", percent: 45 },
        ]),
      ],
      TODAY,
    );
    expect(rollup.regressing[0]!.fromPercent).toBe(70);
    expect(rollup.regressing[0]!.drop).toBe(25);
  });

  it("progress upward is never a regression", () => {
    const rollup = computeProgressRollup(
      [
        jobWith("up", [
          { day: "2026-07-01", percent: 30 },
          { day: "2026-07-28", percent: 60 },
        ]),
      ],
      TODAY,
    );
    expect(rollup.regressing).toEqual([]);
  });
});

describe("provenance", () => {
  const rollup = computeProgressRollup([], TODAY);

  it("stalled is heuristic and quotes its threshold; regressing is derived", () => {
    const s = stalledMetric(rollup);
    expect(s.provenance.kind).toBe("heuristic");
    expect(s.provenance.basis).toContain(`${STALLED_AFTER_DAYS} days`);
    const r = regressingMetric(rollup);
    expect(r.provenance.kind).toBe("derived");
    expect(r.provenance.basis).toContain(`${REGRESSION_LOOKBACK_DAYS} days`);
  });
});
