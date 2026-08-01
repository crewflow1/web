import { describe, it, expect } from "vitest";
import {
  PRACTICAL_COMPLETION_STATUS,
  behindBaselineMetric,
  computeProgrammeVariance,
  eotExposureMetric,
  hasAgreedResolution,
  noBaselineGapMetric,
  overdueMilestonesMetric,
  type ProgrammeDelayInput,
  type ProgrammeVarianceJobInput,
} from "@/lib/intelligence/programme-variance";

/**
 * Programme variance rollup — composes the planned-baseline shapes
 * (lib/job-programme/planned.ts) and the delay lifecycle (lib/eot/lifecycle.ts)
 * into the org-wide planned-vs-actual + delay-exposure counterpart to the
 * actual-only progress rollup. Every fixture pins the London day explicitly
 * (never a clock) so the BST month-end boundary is proven, not assumed.
 */

// UTC still 31 July, London already 1 August — the split a UTC-keyed day gets
// wrong. The compute takes `todayKey` injected; it never reads a clock.
const TODAY = "2026-08-01";

function job(
  jobId: string,
  overrides: Partial<ProgrammeVarianceJobInput> = {},
): ProgrammeVarianceJobInput {
  return {
    jobId,
    label: `Site ${jobId}`,
    href: `/jobs/${jobId}#programme`,
    status: "in-progress",
    baseline: null,
    milestones: [],
    ...overrides,
  };
}

function baseline(plannedEnd: string, plannedStart = "2026-01-01", revision = 2) {
  return { revision, planned_start: plannedStart, planned_end: plannedEnd };
}

function delay(overrides: Partial<ProgrammeDelayInput> = {}): ProgrammeDelayInput {
  return {
    eventId: "de-1",
    jobId: "job-1",
    status: "recorded",
    workingDaysLost: null,
    variationEotAgreedAt: null,
    variationEotAgreedCompletionDate: null,
    ...overrides,
  };
}

describe("behind baseline — the London-day boundary", () => {
  it("a plan ending yesterday is behind; ending TODAY is not; ending tomorrow is not", () => {
    const r = computeProgrammeVariance({
      jobs: [
        job("past", { baseline: baseline("2026-07-31") }), // yesterday → behind
        job("today", { baseline: baseline("2026-08-01") }), // due today → NOT behind
        job("future", { baseline: baseline("2026-08-02") }), // tomorrow → not
      ],
      delayEvents: [],
      todayKey: TODAY,
    });
    expect(r.behindBaseline.map((j) => j.jobId)).toEqual(["past"]);
    expect(r.behindBaseline[0]!.daysOverdue).toBe(1);
    expect(r.behindBaseline[0]!.revision).toBe(2);
    expect(r.jobsWithBaseline).toBe(3);
  });

  it("the boundary is the LONDON day: a 31 July plan is behind on the London 1 August", () => {
    // If a UTC day (still 31 July at 23:30Z) were used, this plan would read as
    // 'due today, not overdue'. Feeding the London day key is what catches it.
    const r = computeProgrammeVariance({
      jobs: [job("bst", { baseline: baseline("2026-07-31") })],
      delayEvents: [],
      todayKey: TODAY,
    });
    expect(r.behindBaseline).toHaveLength(1);
  });

  it("a practically-complete job is never behind, even past its planned end", () => {
    const r = computeProgrammeVariance({
      jobs: [
        job("done", {
          status: PRACTICAL_COMPLETION_STATUS,
          baseline: baseline("2026-07-01"),
        }),
      ],
      delayEvents: [],
      todayKey: TODAY,
    });
    expect(r.behindBaseline).toEqual([]);
    expect(r.jobsConsidered).toBe(0); // completed jobs are not the live population
    expect(r.jobsWithBaseline).toBe(0);
  });

  it("sorts worst (most overdue) first, then by id", () => {
    const r = computeProgrammeVariance({
      jobs: [
        job("a", { baseline: baseline("2026-07-20") }), // 12 days
        job("b", { baseline: baseline("2026-07-10") }), // 22 days
        job("c", { baseline: baseline("2026-07-20") }), // 12 days, id tiebreak
      ],
      delayEvents: [],
      todayKey: TODAY,
    });
    expect(r.behindBaseline.map((j) => j.jobId)).toEqual(["b", "a", "c"]);
  });
});

describe("overdue milestones — exact date comparison, no visibility logic", () => {
  it("counts milestones past their planned end across live baselines", () => {
    const r = computeProgrammeVariance({
      jobs: [
        job("j1", {
          baseline: baseline("2026-12-01"),
          milestones: [
            { planned_end: "2026-07-15" }, // past
            { planned_end: "2026-07-31" }, // past
            { planned_end: "2026-08-01" }, // today → not overdue
            { planned_end: "2026-09-01" }, // future
          ],
        }),
        job("j2", {
          baseline: baseline("2026-12-01"),
          milestones: [{ planned_end: "2026-06-01" }], // past
        }),
      ],
      delayEvents: [],
      todayKey: TODAY,
    });
    expect(r.overdueMilestoneCount).toBe(3);
    expect(r.jobsWithOverdueMilestones).toBe(2);
  });
});

describe("open EoT exposure — human-claimed days, resolved & non-recorded excluded", () => {
  it("sums claimed working days on recorded events with no agreed resolution", () => {
    const r = computeProgrammeVariance({
      jobs: [],
      delayEvents: [
        delay({ eventId: "open-1", workingDaysLost: 3 }),
        delay({ eventId: "open-2", workingDaysLost: 5 }),
      ],
      todayKey: TODAY,
    });
    expect(r.openEotWorkingDaysLost).toBe(8);
    expect(r.openEotEventCount).toBe(2);
    expect(r.recordedDelayEventCount).toBe(2);
  });

  it("EXCLUDES draft and withdrawn events from exposure, and discloses their counts", () => {
    const r = computeProgrammeVariance({
      jobs: [],
      delayEvents: [
        delay({ eventId: "d", status: "draft", workingDaysLost: 99 }),
        delay({ eventId: "w", status: "withdrawn", workingDaysLost: 99 }),
        delay({ eventId: "r", status: "recorded", workingDaysLost: 4 }),
      ],
      todayKey: TODAY,
    });
    expect(r.openEotWorkingDaysLost).toBe(4); // the 99s never enter
    expect(r.draftDelayEventCount).toBe(1);
    expect(r.withdrawnDelayEventCount).toBe(1);
    expect(r.recordedDelayEventCount).toBe(1);
  });

  it("a recorded event whose variation carries an agreed EoT is resolved, not exposure", () => {
    const r = computeProgrammeVariance({
      jobs: [],
      delayEvents: [
        delay({ eventId: "agreed-date", workingDaysLost: 6, variationEotAgreedCompletionDate: "2026-09-01" }),
        delay({ eventId: "agreed-at", workingDaysLost: 7, variationEotAgreedAt: "2026-07-01T00:00:00Z" }),
        delay({ eventId: "open", workingDaysLost: 2 }),
      ],
      todayKey: TODAY,
    });
    expect(r.recordedDelayEventCount).toBe(3);
    expect(r.openEotEventCount).toBe(1); // only the unresolved one
    expect(r.openEotWorkingDaysLost).toBe(2);
  });

  it("unquantified claims (null days) are counted, never invented into the sum", () => {
    const r = computeProgrammeVariance({
      jobs: [],
      delayEvents: [
        delay({ eventId: "q", workingDaysLost: 3 }),
        delay({ eventId: "u1", workingDaysLost: null }),
        delay({ eventId: "u2", workingDaysLost: null }),
      ],
      todayKey: TODAY,
    });
    expect(r.openEotWorkingDaysLost).toBe(3);
    expect(r.openEotEventCount).toBe(3);
    expect(r.openEotUnquantifiedCount).toBe(2);
  });

  it("hasAgreedResolution: agreed by either column, open when neither is set", () => {
    expect(hasAgreedResolution(delay())).toBe(false);
    expect(hasAgreedResolution(delay({ variationEotAgreedAt: "x" }))).toBe(true);
    expect(hasAgreedResolution(delay({ variationEotAgreedCompletionDate: "y" }))).toBe(true);
  });
});

describe("no-baseline gap — surfaced honestly, never a fake zero", () => {
  it("counts live jobs with no current baseline", () => {
    const r = computeProgrammeVariance({
      jobs: [
        job("planned", { baseline: baseline("2026-12-01") }),
        job("no-plan-1"),
        job("no-plan-2"),
        job("done", { status: PRACTICAL_COMPLETION_STATUS }), // not live, not a gap
      ],
      delayEvents: [],
      todayKey: TODAY,
    });
    expect(r.jobsConsidered).toBe(3); // the completed one is excluded
    expect(r.jobsWithBaseline).toBe(1);
    expect(r.jobsWithoutBaseline).toBe(2);
  });
});

describe("permutation independence & totals", () => {
  it("the same inputs in any row order produce the same rollup", () => {
    const jobs = [
      job("a", { baseline: baseline("2026-07-10") }),
      job("b", { baseline: baseline("2026-07-20"), milestones: [{ planned_end: "2026-07-01" }] }),
      job("c"),
    ];
    const events = [
      delay({ eventId: "1", workingDaysLost: 2 }),
      delay({ eventId: "2", status: "withdrawn", workingDaysLost: 9 }),
    ];
    const a = computeProgrammeVariance({ jobs, delayEvents: events, todayKey: TODAY });
    const b = computeProgrammeVariance({
      jobs: [...jobs].reverse(),
      delayEvents: [...events].reverse(),
      todayKey: TODAY,
    });
    expect(a).toEqual(b);
  });
});

describe("provenance — four self-labelling metrics, no composite score", () => {
  const rollup = computeProgrammeVariance({ jobs: [], delayEvents: [], todayKey: TODAY });

  it("behind baseline & overdue milestones are DERIVED", () => {
    expect(behindBaselineMetric(rollup).provenance.kind).toBe("derived");
    expect(overdueMilestonesMetric(rollup).provenance.kind).toBe("derived");
  });

  it("open EoT exposure is DERIVED, quantities-only, and says the days are human-claimed", () => {
    const m = eotExposureMetric(rollup);
    expect(m.provenance.kind).toBe("derived");
    expect(m.provenance.basis.toLowerCase()).toContain("claim");
    // Quantities only — no currency value appears (the basis may SAY "not money").
    expect(m.provenance.basis).not.toMatch(/£|\$|\d+\s*(gbp|usd)/i);
  });

  it("the no-baseline gap is a HEURISTIC and states its chosen rule", () => {
    const m = noBaselineGapMetric(rollup);
    expect(m.provenance.kind).toBe("heuristic");
    expect(m.provenance.basis.toLowerCase()).toContain("gap");
  });

  it("every metric names non-empty evidence to drill into", () => {
    for (const m of [
      behindBaselineMetric(rollup),
      overdueMilestonesMetric(rollup),
      eotExposureMetric(rollup),
      noBaselineGapMetric(rollup),
    ]) {
      expect(m.provenance.basis.trim().length).toBeGreaterThan(20);
      expect(m.provenance.computedFrom.length).toBeGreaterThan(0);
      expect(m.provenance.computedFrom.every((c) => c.href.startsWith("/"))).toBe(true);
    }
  });
});
