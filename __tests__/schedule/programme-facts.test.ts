import { describe, expect, it } from "vitest";
import {
  detectScheduleConflicts,
  summariseScheduleConflicts,
  type JobProgrammeRow,
  type ScheduleConflictInput,
  type ScheduledJobRow,
} from "@/lib/schedule/conflicts";
import { buildScheduleWindow } from "@/lib/schedule/window";

/**
 * The two additive programme facts (Train 10). Same fixture conventions as
 * conflicts.test.ts: BST dates, injected window, no database. This file is NEW
 * so the existing suite stays green untouched.
 */

const NOW = new Date("2026-07-20T09:00:00Z"); // Monday 20 July 2026, BST
const WINDOW = buildScheduleWindow(NOW);

function input(over: Partial<ScheduleConflictInput> = {}): ScheduleConflictInput {
  return { window: WINDOW, ...over };
}

function programme(id: string, jobId: string, over: Partial<JobProgrammeRow> = {}): JobProgrammeRow {
  return { id, job_id: jobId, planned_start: "2026-07-01", planned_end: "2026-08-14", ...over };
}

function pJob(id: string, over: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    id,
    assigned_to: null,
    scheduled_date: "2026-07-22",
    status: "in-progress",
    customer_name: "Harborne Build Co",
    ...over,
  };
}

describe("job_outside_programme — the booking disagrees with the plan", () => {
  it("flags a scheduled date before the window and after it, inside the horizon", () => {
    const conflicts = detectScheduleConflicts(
      input({
        programmes: [programme("p1", "j1", { planned_start: "2026-07-25" })],
        programmeJobs: [pJob("j1", { scheduled_date: "2026-07-22" })],
      }),
    );
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    expect(c.kind).toBe("job_outside_programme");
    expect(c.day).toBe("2026-07-22");
    expect(c.sourceIds).toEqual(["j1", "p1"]);
    expect(c.href).toBe("/jobs/j1");
    expect(c.detail).toContain("move the booking or re-baseline");
  });

  it("says NOTHING when the booking sits inside the window", () => {
    const conflicts = detectScheduleConflicts(
      input({
        programmes: [programme("p1", "j1")],
        programmeJobs: [pJob("j1", { scheduled_date: "2026-07-22" })],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("only reports a mismatch whose scheduled day is inside the detection horizon", () => {
    // Booked 40 days out AND outside the programme: real, but flagged when the
    // rolling window reaches it — the existing horizon rule.
    const conflicts = detectScheduleConflicts(
      input({
        programmes: [programme("p1", "j1", { planned_end: "2026-08-01" })],
        programmeJobs: [pJob("j1", { scheduled_date: "2026-08-29" })],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("is CAPPED at medium — paperwork never outranks a real double-booking", () => {
    // Booked TOMORROW outside the window: proximity alone would say "high".
    const conflicts = detectScheduleConflicts(
      input({
        programmes: [programme("p1", "j1", { planned_start: "2026-07-25" })],
        programmeJobs: [pJob("j1", { scheduled_date: "2026-07-21" })],
      }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.severity).toBe("medium");
  });
});

describe("programme_overrun — the plan's completion has passed, the job has not", () => {
  it("flags a live job past its baselined completion, TODAY, at medium", () => {
    const conflicts = detectScheduleConflicts(
      input({
        programmes: [programme("p1", "j1", { planned_start: "2026-05-01", planned_end: "2026-07-10" })],
        programmeJobs: [pJob("j1", { scheduled_date: null })],
      }),
    );
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    expect(c.kind).toBe("programme_overrun");
    expect(c.day).toBe("2026-07-20");
    expect(c.daysAway).toBe(0);
    expect(c.severity).toBe("medium");
    expect(c.detail).toContain("re-baseline the programme with a note, or complete the job");
  });

  it("says NOTHING for a completed job — its programme is history", () => {
    const conflicts = detectScheduleConflicts(
      input({
        programmes: [programme("p1", "j1", { planned_end: "2026-07-10" })],
        programmeJobs: [pJob("j1", { status: "completed" })],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("says NOTHING while the completion date is still ahead (or today)", () => {
    const conflicts = detectScheduleConflicts(
      input({
        programmes: [
          programme("p1", "j1", { planned_start: "2026-05-01", planned_end: "2026-07-20" }),
        ],
        programmeJobs: [pJob("j1", { scheduled_date: null })],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("an overrunning job booked outside its window raises BOTH facts, deduped keys", () => {
    const conflicts = detectScheduleConflicts(
      input({
        programmes: [programme("p1", "j1", { planned_start: "2026-05-01", planned_end: "2026-07-10" })],
        programmeJobs: [pJob("j1", { scheduled_date: "2026-07-22" })],
      }),
    );
    expect(conflicts.map((c) => c.kind).sort()).toEqual([
      "job_outside_programme",
      "programme_overrun",
    ]);
    expect(new Set(conflicts.map((c) => c.key)).size).toBe(2);
  });
});

describe("degenerate programme input asserts nothing", () => {
  it("missing job row, malformed window, no programmes — all silent", () => {
    expect(
      detectScheduleConflicts(
        input({ programmes: [programme("p1", "j-unknown", { planned_end: "2026-07-01" })] }),
      ),
    ).toEqual([]);
    expect(
      detectScheduleConflicts(
        input({
          programmes: [programme("p1", "j1", { planned_start: "not-a-date" })],
          programmeJobs: [pJob("j1")],
        }),
      ),
    ).toEqual([]);
    expect(detectScheduleConflicts(input({ programmes: [], programmeJobs: [] }))).toEqual([]);
  });

  it("the rollup carries the two new kinds without disturbing the old ones", () => {
    const s = summariseScheduleConflicts([]);
    expect(s.byKind.job_outside_programme).toEqual({ count: 0, soonestDays: null });
    expect(s.byKind.programme_overrun).toEqual({ count: 0, soonestDays: null });
    expect(s.byKind.staff_double_booked).toEqual({ count: 0, soonestDays: null });
  });
});
