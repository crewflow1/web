import { describe, it, expect } from "vitest";
import {
  detectScheduleConflicts,
  groupConflictsByDay,
  rollupKind,
  summariseScheduleConflicts,
  SCHEDULE_CONFLICT_KINDS,
  type AssetCustodyRow,
  type LeaveRow,
  type RotaShiftRow,
  type ScheduleConflictInput,
  type ScheduledJobRow,
} from "@/lib/schedule/conflicts";
import { buildScheduleWindow } from "@/lib/schedule/window";

/**
 * The detector's rules, with no database in sight. Every fixture uses BST dates
 * (July 2026) unless it is specifically probing a transition, because BST is
 * where a UTC-day assumption silently gives the wrong answer.
 */

const NOW = new Date("2026-07-20T09:00:00Z"); // Monday 20 July 2026, BST
const WINDOW = buildScheduleWindow(NOW);

const PEOPLE = new Map([
  ["u-dave", "Dave Baker"],
  ["u-sam", "Sam Okafor"],
]);
const ASSETS = new Map([["a-tele", "Telehandler 3"]]);

function input(over: Partial<ScheduleConflictInput> = {}): ScheduleConflictInput {
  return { window: WINDOW, people: PEOPLE, assets: ASSETS, ...over };
}

function shift(id: string, user: string, startIso: string, endIso: string, jobId: string | null = null): RotaShiftRow {
  return { id, user_id: user, job_id: jobId, starts_at: startIso, ends_at: endIso };
}

function job(id: string, over: Partial<ScheduledJobRow> = {}): ScheduledJobRow {
  return {
    id,
    assigned_to: null,
    scheduled_date: "2026-07-22",
    status: "new",
    customer_name: "Harborne Build Co",
    ...over,
  };
}

function leave(id: string, user: string, from: string, to: string, over: Partial<LeaveRow> = {}): LeaveRow {
  return { id, user_id: user, type: "holiday", status: "approved", starts_at: from, ends_at: to, ...over };
}

function custody(id: string, over: Partial<AssetCustodyRow> = {}): AssetCustodyRow {
  return {
    id,
    asset_id: "a-tele",
    status: "closed",
    assigned_at: "2026-07-20T08:00:00Z",
    actual_return_at: "2026-07-20T17:00:00Z",
    ...over,
  };
}

// ── Empty + degenerate input ─────────────────────────────────────────────────

describe("detectScheduleConflicts — nothing to report", () => {
  it("returns an empty list for empty data", () => {
    expect(detectScheduleConflicts(input())).toEqual([]);
    expect(detectScheduleConflicts(input({ rota: [], jobs: [], leave: [], custody: [] }))).toEqual([]);
  });

  it("summarises empty data as a clean schedule, with every class present at zero", () => {
    const s = summariseScheduleConflicts([]);
    expect(s.total).toBe(0);
    expect(s.worstSeverity).toBeNull();
    for (const k of SCHEDULE_CONFLICT_KINDS) {
      expect(s.byKind[k]).toEqual({ count: 0, soonestDays: null });
    }
  });

  it("ignores rows whose timestamps do not parse rather than crashing", () => {
    const conflicts = detectScheduleConflicts(
      input({
        rota: [
          shift("r1", "u-dave", "not-a-time", "also-not"),
          shift("r2", "u-dave", "2026-07-20T08:00:00Z", "2026-07-20T17:00:00Z"),
        ],
      }),
    );
    expect(conflicts).toEqual([]);
  });
});

// ── Rule 1 · double-booked staff ─────────────────────────────────────────────

describe("staff double-booking", () => {
  it("flags two overlapping shifts for the same person, citing both times", () => {
    const conflicts = detectScheduleConflicts(
      input({
        rota: [
          shift("r1", "u-dave", "2026-07-20T08:00:00Z", "2026-07-20T16:00:00Z"),
          shift("r2", "u-dave", "2026-07-20T14:00:00Z", "2026-07-20T18:00:00Z"),
        ],
      }),
    );
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    expect(c.kind).toBe("staff_double_booked");
    expect(c.subjectName).toBe("Dave Baker");
    expect(c.sourceIds).toEqual(["r1", "r2"]);
    expect(c.day).toBe("2026-07-20");
    expect(c.daysAway).toBe(0);
    expect(c.severity).toBe("high");
    // Times render in Europe/London (BST = UTC+1), not UTC.
    expect(c.detail).toContain("09:00–17:00");
    expect(c.detail).toContain("15:00–19:00");
  });

  it("does NOT flag a handover — one shift ending exactly as the next begins", () => {
    const conflicts = detectScheduleConflicts(
      input({
        rota: [
          shift("r1", "u-dave", "2026-07-20T08:00:00Z", "2026-07-20T12:00:00Z"),
          shift("r2", "u-dave", "2026-07-20T12:00:00Z", "2026-07-20T17:00:00Z"),
        ],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("flags the identical 08:00–17:00 pair the job-assignment trigger creates", () => {
    // Assigning one person to two jobs on one date writes two default shifts via
    // a DB trigger that never runs the rota form's own overlap guard.
    const conflicts = detectScheduleConflicts(
      input({
        rota: [
          shift("r1", "u-dave", "2026-07-22T08:00:00Z", "2026-07-22T17:00:00Z", "j1"),
          shift("r2", "u-dave", "2026-07-22T08:00:00Z", "2026-07-22T17:00:00Z", "j2"),
        ],
      }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("staff_double_booked");
    expect(conflicts[0]!.daysAway).toBe(2);
    expect(conflicts[0]!.severity).toBe("medium");
  });

  it("never flags two DIFFERENT people working the same hours", () => {
    const conflicts = detectScheduleConflicts(
      input({
        rota: [
          shift("r1", "u-dave", "2026-07-20T08:00:00Z", "2026-07-20T17:00:00Z"),
          shift("r2", "u-sam", "2026-07-20T08:00:00Z", "2026-07-20T17:00:00Z"),
        ],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("catches a CROSS-MIDNIGHT night shift overlapping the next morning's start", () => {
    const conflicts = detectScheduleConflicts(
      input({
        rota: [
          // 21:00 Mon → 06:00 Tue (London), i.e. 20:00Z → 05:00Z in BST.
          shift("r1", "u-dave", "2026-07-20T20:00:00Z", "2026-07-21T05:00:00Z"),
          shift("r2", "u-dave", "2026-07-21T04:00:00Z", "2026-07-21T12:00:00Z"),
        ],
      }),
    );
    expect(conflicts).toHaveLength(1);
    // The clash BEGINS on the 21st (London), so that is the day it is filed under.
    expect(conflicts[0]!.day).toBe("2026-07-21");
    expect(conflicts[0]!.daysAway).toBe(1);
  });

  it("reports every clashing PAIR when one person has three overlapping shifts", () => {
    const conflicts = detectScheduleConflicts(
      input({
        rota: [
          shift("r1", "u-dave", "2026-07-20T08:00:00Z", "2026-07-20T18:00:00Z"),
          shift("r2", "u-dave", "2026-07-20T09:00:00Z", "2026-07-20T11:00:00Z"),
          shift("r3", "u-dave", "2026-07-20T10:00:00Z", "2026-07-20T12:00:00Z"),
        ],
      }),
    );
    expect(conflicts).toHaveLength(3);
    expect(new Set(conflicts.map((c) => c.key)).size).toBe(3);
    expect(conflicts.every((c) => c.kind === "staff_double_booked")).toBe(true);
  });

  it("is order-independent: shuffling the input rows changes nothing", () => {
    const rows = [
      shift("r3", "u-dave", "2026-07-24T10:00:00Z", "2026-07-24T12:00:00Z"),
      shift("r1", "u-dave", "2026-07-24T08:00:00Z", "2026-07-24T18:00:00Z"),
      shift("r2", "u-sam", "2026-07-21T08:00:00Z", "2026-07-21T17:00:00Z"),
    ];
    const a = detectScheduleConflicts(input({ rota: rows }));
    const b = detectScheduleConflicts(input({ rota: [...rows].reverse() }));
    expect(a.map((c) => c.key)).toEqual(b.map((c) => c.key));
    expect(a).toEqual(b);
  });

  it("ignores a clash that falls entirely BEFORE the window (the read pad)", () => {
    const conflicts = detectScheduleConflicts(
      input({
        rota: [
          shift("r1", "u-dave", "2026-07-18T08:00:00Z", "2026-07-18T17:00:00Z"),
          shift("r2", "u-dave", "2026-07-18T09:00:00Z", "2026-07-18T12:00:00Z"),
        ],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("KEEPS a clash that starts before the window but runs into it", () => {
    const conflicts = detectScheduleConflicts(
      input({
        rota: [
          shift("r1", "u-dave", "2026-07-19T20:00:00Z", "2026-07-20T06:00:00Z"),
          shift("r2", "u-dave", "2026-07-19T21:00:00Z", "2026-07-20T04:00:00Z"),
        ],
      }),
    );
    expect(conflicts).toHaveLength(1);
    // Clipped to the window: the reported clash starts when the window opens.
    expect(conflicts[0]!.at).toBe("2026-07-19T23:00:00.000Z");
    expect(conflicts[0]!.day).toBe("2026-07-20");
  });

  it("falls back to a neutral name when the person is not in the org's member map", () => {
    const conflicts = detectScheduleConflicts(
      input({
        people: new Map(),
        rota: [
          shift("r1", "u-ghost", "2026-07-20T08:00:00Z", "2026-07-20T17:00:00Z"),
          shift("r2", "u-ghost", "2026-07-20T09:00:00Z", "2026-07-20T11:00:00Z"),
        ],
      }),
    );
    expect(conflicts[0]!.subjectName).toBe("A team member");
    expect(conflicts[0]!.title).toContain("A team member");
  });
});

// ── Rule 2 · approved leave ──────────────────────────────────────────────────

describe("approved leave clashes", () => {
  it("flags a shift inside approved leave, treating the leave dates as INCLUSIVE", () => {
    const conflicts = detectScheduleConflicts(
      input({
        rota: [shift("r1", "u-sam", "2026-07-24T08:00:00Z", "2026-07-24T17:00:00Z")],
        leave: [leave("l1", "u-sam", "2026-07-22", "2026-07-24")],
      }),
    );
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    expect(c.kind).toBe("leave_clash");
    expect(c.subjectName).toBe("Sam Okafor");
    expect(c.sourceIds).toEqual(["l1", "r1"]);
    expect(c.detail).toContain("holiday");
  });

  it("covers the LAST day of leave — a shift on the end date still clashes", () => {
    const onLastDay = detectScheduleConflicts(
      input({
        rota: [shift("r1", "u-sam", "2026-07-24T15:00:00Z", "2026-07-24T20:00:00Z")],
        leave: [leave("l1", "u-sam", "2026-07-24", "2026-07-24")],
      }),
    );
    expect(onLastDay).toHaveLength(1);

    // …and the day AFTER does not.
    const dayAfter = detectScheduleConflicts(
      input({
        rota: [shift("r1", "u-sam", "2026-07-25T08:00:00Z", "2026-07-25T17:00:00Z")],
        leave: [leave("l1", "u-sam", "2026-07-23", "2026-07-24")],
      }),
    );
    expect(dayAfter).toEqual([]);
  });

  it("counts a BST late-evening shift against the leave day it reads as locally", () => {
    // 23:30Z on the 23rd is 00:30 on the 24th in London — inside leave that
    // starts on the 24th. A UTC-day comparison would miss this entirely.
    const conflicts = detectScheduleConflicts(
      input({
        rota: [shift("r1", "u-sam", "2026-07-23T23:30:00Z", "2026-07-24T04:00:00Z")],
        leave: [leave("l1", "u-sam", "2026-07-24", "2026-07-25")],
      }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("leave_clash");
  });

  it("ignores pending, rejected and cancelled leave — only APPROVED counts", () => {
    for (const status of ["pending", "rejected", "cancelled", null]) {
      const conflicts = detectScheduleConflicts(
        input({
          rota: [shift("r1", "u-sam", "2026-07-24T08:00:00Z", "2026-07-24T17:00:00Z")],
          leave: [leave("l1", "u-sam", "2026-07-22", "2026-07-26", { status })],
        }),
      );
      expect(conflicts, `status=${status}`).toEqual([]);
    }
  });

  it("never attributes one person's leave to another person's shift", () => {
    const conflicts = detectScheduleConflicts(
      input({
        rota: [shift("r1", "u-dave", "2026-07-24T08:00:00Z", "2026-07-24T17:00:00Z")],
        leave: [leave("l1", "u-sam", "2026-07-22", "2026-07-26")],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("names the leave TYPE in plain English", () => {
    const conflicts = detectScheduleConflicts(
      input({
        rota: [shift("r1", "u-sam", "2026-07-24T08:00:00Z", "2026-07-24T17:00:00Z")],
        leave: [leave("l1", "u-sam", "2026-07-24", "2026-07-24", { type: "sick" })],
      }),
    );
    expect(conflicts[0]!.detail).toContain("sick leave");
  });
});

// ── Rules 3 & 4 · job assignment vs the rota ─────────────────────────────────

describe("job assignment gaps", () => {
  it("flags an assignee with no shift at all on the job's scheduled day", () => {
    const conflicts = detectScheduleConflicts(
      input({ jobs: [job("j1", { assigned_to: "u-dave", scheduled_date: "2026-07-23" })] }),
    );
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    expect(c.kind).toBe("assignment_off_rota");
    expect(c.sourceIds).toEqual(["j1"]);
    expect(c.href).toBe("/jobs/j1");
    expect(c.title).toContain("Dave Baker");
    expect(c.title).toContain("Harborne Build Co");
  });

  it("stays quiet when the assignee IS working that day, even on another job", () => {
    // `jobs.assigned_to` is only the PRIMARY pointer; a crew covers several jobs
    // a day, so "is he working?" is the question, not "is he on this one?".
    const conflicts = detectScheduleConflicts(
      input({
        jobs: [job("j1", { assigned_to: "u-dave", scheduled_date: "2026-07-23" })],
        rota: [shift("r1", "u-dave", "2026-07-23T08:00:00Z", "2026-07-23T17:00:00Z", "j9")],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("flags an imminent job with NO assignee and nobody rostered on it", () => {
    const conflicts = detectScheduleConflicts(input({ jobs: [job("j1")] }));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("job_unassigned");
    expect(conflicts[0]!.subjectId).toBeNull();
    expect(conflicts[0]!.title).toContain("Harborne Build Co");
  });

  it("does NOT flag an unassigned job that has a crew on the rota", () => {
    // Strictly better-informed than a bare `assigned_to is null` check.
    const conflicts = detectScheduleConflicts(
      input({
        jobs: [job("j1", { scheduled_date: "2026-07-22" })],
        rota: [shift("r1", "u-sam", "2026-07-22T08:00:00Z", "2026-07-22T17:00:00Z", "j1")],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("ignores completed jobs and jobs with no scheduled date", () => {
    const conflicts = detectScheduleConflicts(
      input({
        jobs: [
          job("j1", { status: "completed" }),
          job("j2", { scheduled_date: null }),
          job("j3", { status: "archived-or-unknown" }),
        ],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("ignores a job scheduled OUTSIDE the fortnight window", () => {
    const conflicts = detectScheduleConflicts(
      input({ jobs: [job("j1", { scheduled_date: "2026-09-01" }), job("j2", { scheduled_date: "2026-07-01" })] }),
    );
    expect(conflicts).toEqual([]);
  });

  it("still flags a job on the LAST day of the window", () => {
    const conflicts = detectScheduleConflicts(input({ jobs: [job("j1", { scheduled_date: "2026-08-02" })] }));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.daysAway).toBe(13);
    expect(conflicts[0]!.severity).toBe("low");
  });

  it("describes a job with no customer without inventing a name", () => {
    const conflicts = detectScheduleConflicts(input({ jobs: [job("j1", { customer_name: null })] }));
    expect(conflicts[0]!.title).toContain("an unnamed job");
  });
});

// ── Rule 5 · asset custody ───────────────────────────────────────────────────

describe("asset custody clashes", () => {
  it("flags two custody records covering the same period for one asset", () => {
    const conflicts = detectScheduleConflicts(
      input({
        custody: [
          custody("c1", { assigned_at: "2026-07-20T08:00:00Z", actual_return_at: "2026-07-22T17:00:00Z" }),
          custody("c2", { assigned_at: "2026-07-21T08:00:00Z", actual_return_at: "2026-07-23T17:00:00Z" }),
        ],
      }),
    );
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    expect(c.kind).toBe("asset_double_booked");
    expect(c.subjectName).toBe("Telehandler 3");
    expect(c.href).toBe("/assets/a-tele");
    expect(c.sourceIds).toEqual(["c1", "c2"]);
  });

  it("treats a transfer (close and reopen at the same instant) as a handover", () => {
    // This is what transfer_asset_assignment() actually produces — both stamps
    // are the same transaction's now() — so it must never be reported.
    const conflicts = detectScheduleConflicts(
      input({
        custody: [
          custody("c1", { assigned_at: "2026-07-20T08:00:00Z", actual_return_at: "2026-07-21T09:00:00Z" }),
          custody("c2", { status: "open", assigned_at: "2026-07-21T09:00:00Z", actual_return_at: null }),
        ],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("treats an OPEN record as running to the end of time and catches a late close over it", () => {
    const conflicts = detectScheduleConflicts(
      input({
        custody: [
          custody("c1", { status: "open", assigned_at: "2026-07-20T08:00:00Z", actual_return_at: null }),
          custody("c2", { assigned_at: "2026-07-21T08:00:00Z", actual_return_at: "2026-07-22T08:00:00Z" }),
        ],
      }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("asset_double_booked");
  });

  it("ignores cancelled custody, and a closed record with an unknown return", () => {
    const conflicts = detectScheduleConflicts(
      input({
        custody: [
          custody("c1", { assigned_at: "2026-07-20T08:00:00Z", actual_return_at: "2026-07-25T17:00:00Z" }),
          custody("c2", { status: "cancelled", assigned_at: "2026-07-21T08:00:00Z", actual_return_at: null }),
          custody("c3", { status: "closed", assigned_at: "2026-07-22T08:00:00Z", actual_return_at: null }),
        ],
      }),
    );
    expect(conflicts).toEqual([]);
  });

  it("never mixes two DIFFERENT assets", () => {
    const conflicts = detectScheduleConflicts(
      input({
        custody: [
          custody("c1", { asset_id: "a-tele", assigned_at: "2026-07-20T08:00:00Z", actual_return_at: "2026-07-25T17:00:00Z" }),
          custody("c2", { asset_id: "a-dumper", assigned_at: "2026-07-21T08:00:00Z", actual_return_at: "2026-07-23T17:00:00Z" }),
        ],
      }),
    );
    expect(conflicts).toEqual([]);
  });
});

// ── Aggregation, severity and ordering ───────────────────────────────────────

describe("severity, ordering and aggregation", () => {
  const multi = (): ScheduleConflictInput =>
    input({
      rota: [
        // Today — a double-booking (high).
        shift("r1", "u-dave", "2026-07-20T08:00:00Z", "2026-07-20T17:00:00Z"),
        shift("r2", "u-dave", "2026-07-20T15:00:00Z", "2026-07-20T19:00:00Z"),
        // Next week — a leave clash (medium at 5 days out).
        shift("r3", "u-sam", "2026-07-25T08:00:00Z", "2026-07-25T17:00:00Z"),
      ],
      leave: [leave("l1", "u-sam", "2026-07-25", "2026-07-27")],
      jobs: [
        job("j1", { scheduled_date: "2026-07-21" }), // tomorrow, nobody (high)
        job("j2", { scheduled_date: "2026-08-01" }), // 12 days out (low)
      ],
    });

  it("ranks today's double-booking above every later finding", () => {
    const conflicts = detectScheduleConflicts(multi());
    expect(conflicts[0]!.kind).toBe("staff_double_booked");
    expect(conflicts[0]!.daysAway).toBe(0);
    // Scores are strictly non-increasing — the list IS the ranking.
    const scores = conflicts.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("uses the honest ladder: <=1 day high, <=7 medium, beyond that low", () => {
    const conflicts = detectScheduleConflicts(multi());
    const byDays = new Map(conflicts.map((c) => [c.daysAway, c.severity]));
    expect(byDays.get(0)).toBe("high");
    expect(byDays.get(1)).toBe("high");
    expect(byDays.get(5)).toBe("medium");
    expect(byDays.get(12)).toBe("low");
  });

  it("NEVER marks a schedule conflict critical — that word is reserved for safety", () => {
    const conflicts = detectScheduleConflicts(multi());
    expect(conflicts.length).toBeGreaterThan(0);
    for (const c of conflicts) expect(c.severity).not.toBe("critical");
    expect(summariseScheduleConflicts(conflicts).worstSeverity).toBe("high");
  });

  it("aggregates per class with the soonest day for each", () => {
    const s = summariseScheduleConflicts(detectScheduleConflicts(multi()));
    expect(s.total).toBe(4);
    expect(s.byKind.staff_double_booked).toEqual({ count: 1, soonestDays: 0 });
    expect(s.byKind.leave_clash).toEqual({ count: 1, soonestDays: 5 });
    expect(s.byKind.job_unassigned).toEqual({ count: 2, soonestDays: 1 });
    expect(s.byKind.assignment_off_rota).toEqual({ count: 0, soonestDays: null });
    expect(s.byKind.asset_double_booked).toEqual({ count: 0, soonestDays: null });
  });

  it("rollupKind can start from day 2, keeping the briefing disjoint from the tomorrow line", () => {
    const conflicts = detectScheduleConflicts(multi());
    expect(rollupKind(conflicts, "job_unassigned")).toEqual({ count: 2, soonestDays: 1 });
    expect(rollupKind(conflicts, "job_unassigned", { fromDaysAway: 2 })).toEqual({
      count: 1,
      soonestDays: 12,
    });
  });

  it("groups by day while preserving rank order inside each day", () => {
    const groups = groupConflictsByDay(detectScheduleConflicts(multi()));
    expect(groups.map((g) => g.day)).toEqual(["2026-07-20", "2026-07-21", "2026-07-25", "2026-08-01"]);
    expect(groups.reduce((n, g) => n + g.conflicts.length, 0)).toBe(4);
  });

  it("gives every finding a unique, stable key and an audit trail of source ids", () => {
    const conflicts = detectScheduleConflicts(multi());
    expect(new Set(conflicts.map((c) => c.key)).size).toBe(conflicts.length);
    for (const c of conflicts) {
      expect(c.sourceIds.length).toBeGreaterThan(0);
      expect(c.key.startsWith(`${c.kind}:`)).toBe(true);
      // Keys are order-independent: sorted ids, so the same clash is one finding.
      expect(c.sourceIds).toEqual([...c.sourceIds].sort());
    }
  });

  it("produces byte-identical output when run twice on the same input", () => {
    expect(detectScheduleConflicts(multi())).toEqual(detectScheduleConflicts(multi()));
  });
});

// ── DST ──────────────────────────────────────────────────────────────────────

describe("British Summer Time transitions", () => {
  it("detects a clash across the spring-forward hour (29 March 2026)", () => {
    const win = buildScheduleWindow(new Date("2026-03-28T09:00:00Z"));
    const conflicts = detectScheduleConflicts({
      window: win,
      people: PEOPLE,
      rota: [
        // 00:30–02:30 UTC spans the 01:00Z jump; locally 00:30 GMT → 03:30 BST.
        shift("r1", "u-dave", "2026-03-29T00:30:00Z", "2026-03-29T02:30:00Z"),
        shift("r2", "u-dave", "2026-03-29T02:00:00Z", "2026-03-29T06:00:00Z"),
      ],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.day).toBe("2026-03-29");
    expect(conflicts[0]!.daysAway).toBe(1);
  });

  it("puts leave on the 25-hour fall-back day in the right bucket (25 October 2026)", () => {
    const win = buildScheduleWindow(new Date("2026-10-24T09:00:00Z"));
    const conflicts = detectScheduleConflicts({
      window: win,
      people: PEOPLE,
      // 23:30Z on the 24th is 00:30 BST on the 25th — inside leave for the 25th.
      rota: [shift("r1", "u-sam", "2026-10-24T23:30:00Z", "2026-10-25T04:00:00Z")],
      leave: [leave("l1", "u-sam", "2026-10-25", "2026-10-25")],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("leave_clash");
    expect(conflicts[0]!.day).toBe("2026-10-25");
  });

  it("counts days across a transition without an off-by-one", () => {
    const win = buildScheduleWindow(new Date("2026-10-24T09:00:00Z"));
    const conflicts = detectScheduleConflicts({
      window: win,
      jobs: [job("j1", { scheduled_date: "2026-10-27" })],
    });
    expect(conflicts[0]!.daysAway).toBe(3);
  });
});
