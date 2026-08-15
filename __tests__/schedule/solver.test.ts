import { describe, expect, it } from "vitest";
import {
  assertScoreIsSumOfFactors,
  generateRota,
  SOLVER_SCORE,
  type RotaPlanInput,
} from "@/lib/schedule/solver";
import { buildScheduleWindow } from "@/lib/schedule/window";
import type { LeaveRow, RotaShiftRow, ScheduledJobRow } from "@/lib/schedule/conflicts";

/**
 * The deterministic optimising rota generator (lib/schedule/solver.ts).
 *
 * Every test is a PURE call — jobs + staff in, a plan out — because the whole
 * point of the module is that it owns no clock, no client and no randomness. The
 * numbers asserted here are the exact numbers a manager sees on the generate
 * surface, and `assertScoreIsSumOfFactors` proves no hidden term moved a choice.
 */

const NOW = new Date("2026-08-10T09:00:00Z");
const WINDOW = buildScheduleWindow(NOW); // 2026-08-10 .. 2026-08-23

function job(over: Partial<ScheduledJobRow> & { id: string }): ScheduledJobRow {
  return {
    id: over.id,
    assigned_to: over.assigned_to ?? null,
    scheduled_date: over.scheduled_date ?? "2026-08-12",
    status: over.status ?? "new",
    customer_name: over.customer_name ?? "Acme",
  };
}

function shift(over: Partial<RotaShiftRow> & { id: string; user_id: string }): RotaShiftRow {
  return {
    id: over.id,
    user_id: over.user_id,
    job_id: over.job_id ?? null,
    starts_at: over.starts_at ?? "2026-08-12T08:00:00Z",
    ends_at: over.ends_at ?? "2026-08-12T17:00:00Z",
  };
}

const roster2 = [
  { userId: "u-1", name: "Alice", role: "staff" },
  { userId: "u-2", name: "Bob", role: "staff" },
];

function base(over: Partial<RotaPlanInput>): RotaPlanInput {
  return {
    window: WINDOW,
    rota: [],
    jobs: [],
    leave: [],
    custody: [],
    roster: roster2,
    ...over,
  };
}

// ── determinism ──────────────────────────────────────────────────────────────

describe("generateRota is deterministic", () => {
  it("returns byte-identical plans for the same facts, and for shuffled rows", () => {
    const jobs = [job({ id: "j-a" }), job({ id: "j-b", scheduled_date: "2026-08-13" })];
    const input = base({ jobs });
    const a = generateRota(input);
    const b = generateRota({ ...input, jobs: [...jobs].reverse() });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    expect(a.assignments.length).toBe(2);
  });

  it("every assignment's score is exactly the sum of its shown factors", () => {
    const input = base({ jobs: [job({ id: "j-a" }), job({ id: "j-b", scheduled_date: "2026-08-14" })] });
    const plan = generateRota(input);
    expect(plan.assignments.length).toBeGreaterThan(0);
    for (const a of plan.assignments) {
      expect(assertScoreIsSumOfFactors(a), a.explanation).toBe(true);
    }
  });
});

// ── availability is a hard gate, never scored away ───────────────────────────

describe("availability is respected", () => {
  it("does not choose a person already on an overlapping shift when someone is free", () => {
    const input = base({
      jobs: [job({ id: "j-a" })],
      // Alice is booked 08:00–17:00 that day; Bob is free.
      rota: [shift({ id: "s-1", user_id: "u-1" })],
    });
    const plan = generateRota(input);
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]!.userId).toBe("u-2");
  });

  it("leaves a job unfilled when the only staffer is on approved leave, and says why", () => {
    const leave: LeaveRow[] = [
      {
        id: "l-1",
        user_id: "u-1",
        type: "holiday",
        status: "approved",
        starts_at: "2026-08-11",
        ends_at: "2026-08-13",
      },
    ];
    const input = base({
      jobs: [job({ id: "j-a" })],
      leave,
      roster: [{ userId: "u-1", name: "Alice", role: "staff" }],
    });
    const plan = generateRota(input);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0]!.causes.on_approved_leave).toBe(1);
    expect(plan.unfilled[0]!.reason).toContain("on approved leave");
  });

  it("only counts approved leave — a pending request never blocks", () => {
    const leave: LeaveRow[] = [
      {
        id: "l-1",
        user_id: "u-1",
        type: "holiday",
        status: "pending",
        starts_at: "2026-08-11",
        ends_at: "2026-08-13",
      },
    ];
    const input = base({
      jobs: [job({ id: "j-a" })],
      leave,
      roster: [{ userId: "u-1", name: "Alice", role: "staff" }],
    });
    const plan = generateRota(input);
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]!.userId).toBe("u-1");
  });
});

// ── the plan never double-books, and spreads the work ────────────────────────

describe("one plan is internally consistent", () => {
  it("never places one person on two overlapping jobs — the second is unfilled", () => {
    const input = base({
      // Two jobs, same day, both default 08:00–17:00 → overlapping slots.
      jobs: [job({ id: "j-a" }), job({ id: "j-b" })],
      roster: [{ userId: "u-1", name: "Alice", role: "staff" }],
    });
    const plan = generateRota(input);
    expect(plan.assignments).toHaveLength(1);
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.unfilled[0]!.causes.placed_elsewhere_this_plan).toBe(1);
  });

  it("spreads two same-day jobs across two free people rather than piling up", () => {
    const input = base({ jobs: [job({ id: "j-a" }), job({ id: "j-b" })] });
    const plan = generateRota(input);
    expect(plan.assignments).toHaveLength(2);
    expect(new Set(plan.assignments.map((a) => a.userId)).size).toBe(2);
    expect(plan.summary.peopleUsed).toBe(2);
  });
});

// ── soft signals: named assignee and location ────────────────────────────────

describe("scoring prefers the intended and the nearest", () => {
  it("restores the job's named assignee (assignment_off_rota) with a named-assignee bonus", () => {
    // Bob is named on the job but holds no shift that day → assignment_off_rota.
    const input = base({ jobs: [job({ id: "j-a", assigned_to: "u-2" })] });
    const plan = generateRota(input);
    expect(plan.assignments).toHaveLength(1);
    const chosen = plan.assignments[0]!;
    expect(chosen.userId).toBe("u-2");
    expect(chosen.need.reason).toBe("assignment_off_rota");
    const named = chosen.factors.find((f) => f.code === "named_assignee");
    expect(named?.delta).toBe(SOLVER_SCORE.namedAssignee);
  });

  it("credits 'already near there that day' when a person works the same district that day", () => {
    const input = base({
      jobs: [job({ id: "j-b" })], // the unstaffed job, in SW1
      // Alice already has a NON-overlapping early shift on another SW1 job that day.
      rota: [
        shift({
          id: "s-early",
          user_id: "u-1",
          job_id: "j-a",
          starts_at: "2026-08-12T06:00:00Z",
          ends_at: "2026-08-12T07:30:00Z",
        }),
        // Bob is booked over the whole slot that day, so Alice is the only option.
        shift({ id: "s-bob", user_id: "u-2" }),
      ],
      jobDistricts: new Map([
        ["j-a", "SW1"],
        ["j-b", "SW1"],
      ]),
    });
    const plan = generateRota(input);
    expect(plan.assignments).toHaveLength(1);
    const chosen = plan.assignments[0]!;
    expect(chosen.userId).toBe("u-1");
    const area = chosen.factors.find((f) => f.code === "same_area_that_day");
    expect(area?.delta).toBe(SOLVER_SCORE.sameAreaThatDay);
    expect(area?.evidence).toContain("s-early");
  });
});

// ── insufficient inputs, said plainly ────────────────────────────────────────

describe("insufficient inputs are stated, never invented", () => {
  it("says so when no job needs staffing", () => {
    const plan = generateRota(base({ jobs: [] }));
    expect(plan.assignments).toHaveLength(0);
    expect(plan.insufficient).toBeTruthy();
    expect(plan.insufficient).toContain("nothing to generate");
  });

  it("says so when there are no staff, and marks every job unfilled", () => {
    const plan = generateRota(base({ jobs: [job({ id: "j-a" })], roster: [] }));
    expect(plan.insufficient).toBeTruthy();
    expect(plan.unfilled).toHaveLength(1);
    expect(plan.summary.assigned).toBe(0);
  });

  it("does not target completed jobs — their staffing is history", () => {
    const plan = generateRota(base({ jobs: [job({ id: "j-a", status: "completed" })] }));
    expect(plan.assignments).toHaveLength(0);
    expect(plan.insufficient).toContain("nothing to generate");
  });
});

// ── tenant safety at the pure boundary ───────────────────────────────────────

describe("never proposes anyone outside the roster it was handed", () => {
  it("ignores a rota row for a user absent from the roster", () => {
    const input = base({
      jobs: [job({ id: "j-a" })],
      rota: [
        shift({
          id: "s-x",
          user_id: "u-other-org",
          starts_at: "2026-08-13T08:00:00Z",
          ends_at: "2026-08-13T09:00:00Z",
        }),
      ],
      roster: [{ userId: "u-1", name: "Alice", role: "staff" }],
    });
    const plan = generateRota(input);
    const touched = plan.assignments.map((a) => a.userId);
    expect(touched).not.toContain("u-other-org");
    expect(touched).toEqual(["u-1"]);
  });
});
