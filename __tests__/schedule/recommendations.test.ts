import { describe, expect, it } from "vitest";
import {
  detectScheduleConflicts,
  type LeaveRow,
  type RotaShiftRow,
  type ScheduledJobRow,
} from "@/lib/schedule/conflicts";
import { buildScheduleWindow } from "@/lib/schedule/window";
import {
  CANDIDATE_SCORE,
  MAX_COVER_CANDIDATES,
  MAX_DAY_MOVE_CANDIDATES,
  RECOMMENDABLE_KINDS,
  compareCandidates,
  isRecommendable,
  recommendForConflicts,
  summariseRecommendations,
  sumFactors,
  type RecommendationCandidate,
  type RecommendationInput,
  type RosterMember,
  type ScheduleRecommendation,
} from "@/lib/schedule/recommendations";

/**
 * Schedule Recommendations — the resolution engine, unit-tested against the
 * REAL detector.
 *
 * Conflicts here are never hand-written: every fixture is fed through
 * `detectScheduleConflicts` and the recommendations are computed from the
 * findings it emits. That is deliberate — the two halves join on
 * `ScheduleConflict.key` and recover their subject rows from `sourceIds`, so a
 * hand-built conflict would test a contract the product never uses and would
 * hide a drift between what is DETECTED and what is RECOMMENDED.
 *
 * The load-bearing invariant, asserted for every candidate in every scenario:
 * `score === sum(factors[].delta)`. It is what makes "the reasoning is shown"
 * a structural fact rather than a promise — a term that moves the ranking
 * without appearing on screen cannot exist.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Pinned clock → a fixed fortnight: 10–23 August 2026, all of it BST. */
const NOW = new Date("2026-08-10T09:00:00Z");
const WINDOW = buildScheduleWindow(NOW);
const DAY = "2026-08-12";

const DAVE: RosterMember = { userId: "u-dave", name: "Dave Baker", role: "staff" };
const ERIN: RosterMember = { userId: "u-erin", name: "Erin Cole", role: "staff" };
const FRANK: RosterMember = { userId: "u-frank", name: "Frank Doyle", role: "admin" };
const GRACE: RosterMember = { userId: "u-grace", name: "Grace Ellis", role: "staff" };

function shift(
  id: string,
  userId: string,
  day: string,
  fromHourUtc: number,
  toHourUtc: number,
  jobId: string | null = null,
): RotaShiftRow {
  const h = (n: number) => String(n).padStart(2, "0");
  return {
    id,
    user_id: userId,
    job_id: jobId,
    starts_at: `${day}T${h(fromHourUtc)}:00:00Z`,
    ends_at: `${day}T${h(toHourUtc)}:00:00Z`,
  };
}

function job(
  id: string,
  day: string | null,
  assignedTo: string | null = null,
  status = "new",
): ScheduledJobRow {
  return {
    id,
    assigned_to: assignedTo,
    scheduled_date: day,
    status,
    customer_name: "Harborne Build Co",
  };
}

function leave(
  id: string,
  userId: string,
  from: string,
  to: string,
  status = "approved",
): LeaveRow {
  return { id, user_id: userId, type: "holiday", status, starts_at: from, ends_at: to };
}

function facts(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return { window: WINDOW, rota: [], jobs: [], leave: [], custody: [], roster: [], ...over };
}

/** The real path: detect, then recommend over the same facts. */
function run(input: RecommendationInput): Map<string, ScheduleRecommendation> {
  return recommendForConflicts(detectScheduleConflicts(input), input);
}

function only(input: RecommendationInput): ScheduleRecommendation {
  const recs = [...run(input).values()];
  expect(recs).toHaveLength(1);
  return recs[0]!;
}

function names(candidates: readonly RecommendationCandidate[]): string[] {
  return candidates.map((c) => c.userName);
}

/**
 * The two candidate kinds answer different questions and are asserted apart.
 *
 * A `cover` is "somebody ELSE takes this slot"; a `move_day` is "the SAME
 * person, later". The conflicted person is therefore correctly absent from
 * covers and correctly present in moves — moving your own clashing shift is the
 * most natural fix there is, and excluding them from it would be a bug.
 */
const covers = (rec: ScheduleRecommendation): RecommendationCandidate[] =>
  rec.candidates.filter((c) => c.kind === "cover");
const moves = (rec: ScheduleRecommendation): RecommendationCandidate[] =>
  rec.candidates.filter((c) => c.kind === "move_day");

function factorCodes(candidate: RecommendationCandidate): string[] {
  return candidate.factors.map((f) => f.code);
}

/** Every candidate a scenario produced, for the blanket invariants below. */
function allCandidates(
  recs: ReadonlyMap<string, ScheduleRecommendation>,
): RecommendationCandidate[] {
  return [...recs.values()].flatMap((r) => r.candidates);
}

// ── THE invariant · nothing hidden moves the ranking ─────────────────────────

describe("the score is exactly the reasoning that is shown", () => {
  const scenarios: Array<[string, RecommendationInput]> = [
    [
      "a double-booking with free colleagues",
      facts({
        rota: [shift("s-1", DAVE.userId, DAY, 8, 17), shift("s-2", DAVE.userId, DAY, 9, 12)],
        roster: [DAVE, ERIN, FRANK],
      }),
    ],
    [
      "a job nobody is on",
      facts({ jobs: [job("j-1", DAY)], roster: [DAVE, ERIN] }),
    ],
    [
      "an assignee who dropped off the rota",
      facts({ jobs: [job("j-1", DAY, DAVE.userId)], roster: [DAVE, ERIN] }),
    ],
    [
      "a leave clash",
      facts({
        rota: [shift("s-1", DAVE.userId, DAY, 8, 17)],
        leave: [leave("l-1", DAVE.userId, DAY, DAY)],
        roster: [DAVE, ERIN],
      }),
    ],
    [
      "a busy fortnight with load penalties",
      facts({
        rota: [
          shift("s-1", DAVE.userId, DAY, 8, 17),
          shift("s-2", DAVE.userId, DAY, 9, 12),
          shift("s-3", ERIN.userId, DAY, 4, 6),
          shift("s-4", ERIN.userId, DAY, 19, 22),
        ],
        roster: [DAVE, ERIN, FRANK],
      }),
    ],
  ];

  for (const [label, input] of scenarios) {
    it(`holds for ${label}`, () => {
      const candidates = allCandidates(run(input));
      expect(candidates.length).toBeGreaterThan(0);
      for (const c of candidates) {
        expect(c.score, `${c.userName} (${c.kind})`).toBe(sumFactors(c.factors));
        // …and the sentence a manager reads carries every one of those clauses.
        for (const f of c.factors) expect(c.explanation).toContain(f.text);
      }
    });
  }
});

// ── Rule 1 · the double-booking ──────────────────────────────────────────────

describe("a double-booking · who can take the second shift", () => {
  const input = facts({
    rota: [shift("s-early", DAVE.userId, DAY, 8, 17), shift("s-late", DAVE.userId, DAY, 9, 12)],
    roster: [DAVE, ERIN, FRANK],
  });

  it("needs cover for the LATER-starting shift, not the earlier commitment", () => {
    const rec = only(input);
    expect(rec.kind).toBe("staff_double_booked");
    expect(rec.need.replacesShiftIds).toEqual(["s-late"]);
    // BST: 09:00Z–12:00Z reads 10:00–13:00 to a UK manager.
    expect(rec.need.summary).toContain("10:00–13:00");
    expect(rec.need.day).toBe(DAY);
  });

  it("never proposes the double-booked person as their own cover", () => {
    const rec = only(input);
    expect(names(covers(rec))).not.toContain(DAVE.name);
    const self = rec.ruledOut.find((r) => r.userId === DAVE.userId);
    expect(self?.code).toBe("is_the_conflicted_person");
    expect(self?.evidence).toEqual(["s-late"]);
    // He is still offered the OTHER resolution — moving his own clashing shift.
    expect(names(moves(rec))).toEqual([DAVE.name, DAVE.name]);
  });

  it("offers the free colleagues, each with a checkable sentence", () => {
    const rec = only(input);
    expect(names(covers(rec))).toEqual([ERIN.name, FRANK.name]);
    const erin = covers(rec)[0]!;
    expect(erin.explanation).toBe(
      "Erin Cole — covers the slot without changing the date; free 10:00–13:00 on Wed 12 Aug — no shift of theirs overlaps it; no approved leave covering that window; nothing else on their rota that day.",
    );
    expect(erin.score).toBe(CANDIDATE_SCORE.cover + CANDIDATE_SCORE.clearAllDay);
    expect(erin.kind).toBe("cover");
  });

  it("breaks the tie on load, then name — a total, reproducible order", () => {
    const busierErin = facts({
      rota: [
        shift("s-early", DAVE.userId, DAY, 8, 17),
        shift("s-late", DAVE.userId, DAY, 9, 12),
        // Erin holds an unrelated shift on ANOTHER day: same score, heavier fortnight.
        shift("s-erin", ERIN.userId, "2026-08-14", 8, 17),
      ],
      roster: [DAVE, ERIN, FRANK],
    });
    const rec = only(busierErin);
    expect(names(covers(rec))).toEqual([FRANK.name, ERIN.name]);
    expect(covers(rec)[0]!.score).toBe(covers(rec)[1]!.score);
    expect(covers(rec)[0]!.shiftsInWindow).toBeLessThan(covers(rec)[1]!.shiftsInWindow);
  });
});

// ── Rule 2 · availability comes only from records ────────────────────────────

describe("availability is read off records, and rejections cite them", () => {
  it("rules out an already-booked colleague, citing the clashing shift", () => {
    const rec = only(
      facts({
        rota: [
          shift("s-1", DAVE.userId, DAY, 8, 17),
          shift("s-2", DAVE.userId, DAY, 9, 12),
          shift("s-erin", ERIN.userId, DAY, 10, 14),
        ],
        roster: [DAVE, ERIN, FRANK],
      }),
    );
    expect(names(covers(rec))).toEqual([FRANK.name]);
    const erin = rec.ruledOut.find((r) => r.userId === ERIN.userId)!;
    expect(erin.code).toBe("already_on_a_shift");
    expect(erin.evidence).toEqual(["s-erin"]);
    expect(erin.text).toContain("11:00–15:00");
  });

  it("rules out APPROVED leave citing the request, and ignores a PENDING one", () => {
    const rec = only(
      facts({
        rota: [shift("s-1", DAVE.userId, DAY, 8, 17), shift("s-2", DAVE.userId, DAY, 9, 12)],
        leave: [
          leave("l-erin", ERIN.userId, "2026-08-11", "2026-08-13"),
          leave("l-frank", FRANK.userId, "2026-08-11", "2026-08-13", "pending"),
        ],
        roster: [DAVE, ERIN, FRANK],
      }),
    );
    // Frank's leave is only requested, so he is still a real option.
    expect(names(covers(rec))).toEqual([FRANK.name]);
    const erin = rec.ruledOut.find((r) => r.userId === ERIN.userId)!;
    expect(erin.code).toBe("on_approved_leave");
    expect(erin.evidence).toEqual(["l-erin"]);
    expect(erin.text).toContain("holiday");
  });

  it("treats a touching shift as a handover, not a clash", () => {
    // Erin finishes at exactly 09:00Z, when the slot needing cover begins.
    const rec = only(
      facts({
        rota: [
          shift("s-1", DAVE.userId, DAY, 8, 17),
          shift("s-2", DAVE.userId, DAY, 9, 12),
          shift("s-erin", ERIN.userId, DAY, 6, 9),
        ],
        roster: [DAVE, ERIN],
      }),
    );
    expect(names(covers(rec))).toEqual([ERIN.name]);
    // …but she is not "clear all day" — the earlier shift is real and counted.
    expect(factorCodes(covers(rec)[0]!)).toContain("existing_load");
    expect(covers(rec)[0]!.otherShiftsThatDay).toBe(1);
  });

  it("penalises a busy day, floored so a busy person still beats nobody", () => {
    const rec = only(
      facts({
        rota: [
          shift("s-1", DAVE.userId, DAY, 8, 17),
          shift("s-2", DAVE.userId, DAY, 9, 12),
          // Four non-overlapping shifts for Erin on the same day: penalty floors.
          shift("s-e1", ERIN.userId, DAY, 0, 2),
          shift("s-e2", ERIN.userId, DAY, 2, 4),
          shift("s-e3", ERIN.userId, DAY, 4, 6),
          shift("s-e4", ERIN.userId, DAY, 19, 21),
        ],
        roster: [DAVE, ERIN],
      }),
    );
    const erin = covers(rec)[0]!;
    const load = erin.factors.find((f) => f.code === "existing_load")!;
    expect(erin.otherShiftsThatDay).toBe(4);
    expect(load.delta).toBe(CANDIDATE_SCORE.otherShiftPenaltyFloor);
    expect(load.evidence).toEqual(["s-e1", "s-e2", "s-e3", "s-e4"]);
    expect(erin.score).toBe(CANDIDATE_SCORE.cover + CANDIDATE_SCORE.otherShiftPenaltyFloor);
  });
});

// ── Rule 3 · the job-day gaps ────────────────────────────────────────────────

describe("a job whose assignee is off the rota", () => {
  const input = facts({
    jobs: [job("j-1", DAY, DAVE.userId)],
    roster: [DAVE, ERIN],
  });

  it("proposes the named assignee first, worth exactly the named-assignee bonus", () => {
    const rec = only(input);
    expect(rec.kind).toBe("assignment_off_rota");
    expect(names(rec.candidates)).toEqual([DAVE.name, ERIN.name]);
    const dave = rec.candidates[0]!;
    expect(factorCodes(dave)).toContain("named_assignee");
    expect(dave.factors.find((f) => f.code === "named_assignee")!.evidence).toEqual(["j-1"]);
    expect(dave.score - rec.candidates[1]!.score).toBe(CANDIDATE_SCORE.namedAssignee);
  });

  it("proposes the database's OWN default hours, not invented ones", () => {
    const rec = only(input);
    // `_tg_jobs_rota_sync` writes 08:00–17:00 UTC; in BST that reads 09:00–18:00.
    expect(rec.need.startIso).toBe(`${DAY}T08:00:00.000Z`);
    expect(rec.need.endIso).toBe(`${DAY}T17:00:00.000Z`);
    expect(rec.candidates[0]!.explanation).toContain("09:00–18:00");
  });

  it("drops the assignee to a rejection when they are on approved leave", () => {
    const rec = only(
      facts({
        jobs: [job("j-1", DAY, DAVE.userId)],
        leave: [leave("l-dave", DAVE.userId, DAY, DAY)],
        roster: [DAVE, ERIN],
      }),
    );
    expect(names(rec.candidates)).toEqual([ERIN.name]);
    expect(rec.ruledOut.find((r) => r.userId === DAVE.userId)?.code).toBe("on_approved_leave");
  });
});

describe("a job with nobody on it", () => {
  it("considers the whole roster — nobody is excluded", () => {
    const rec = only(facts({ jobs: [job("j-1", DAY)], roster: [DAVE, ERIN, FRANK, GRACE] }));
    expect(rec.kind).toBe("job_unassigned");
    expect(rec.need.excludedUserIds).toEqual([]);
    expect(rec.considered).toBe(4);
    expect(rec.ruledOut).toEqual([]);
  });

  it("caps the offered covers while keeping the total honest", () => {
    const rec = only(facts({ jobs: [job("j-1", DAY)], roster: [DAVE, ERIN, FRANK, GRACE] }));
    expect(rec.candidates.length).toBeLessThanOrEqual(MAX_COVER_CANDIDATES);
    expect(rec.candidateTotal).toBe(4);
  });

  it("credits someone already on the job elsewhere in the fortnight", () => {
    const rec = only(
      facts({
        jobs: [job("j-1", DAY)],
        // Erin works this same job on a different day — a real, cited fact.
        rota: [shift("s-erin", ERIN.userId, "2026-08-17", 8, 17, "j-1")],
        roster: [DAVE, ERIN],
      }),
    );
    expect(names(rec.candidates)).toEqual([ERIN.name, DAVE.name]);
    const knows = rec.candidates[0]!.factors.find((f) => f.code === "knows_the_job")!;
    expect(knows.delta).toBe(CANDIDATE_SCORE.knowsTheJob);
    expect(knows.evidence).toEqual(["s-erin"]);
    expect(knows.text).toContain("Mon 17 Aug");
  });

  it("rules out someone ALREADY on the job for that very slot — it would change nothing", () => {
    // Reachable through the OFF-ROTA class, not this one: a job whose rostered
    // crew is somebody other than its named assignee. (A job_unassigned is
    // never raised while anyone is rostered on it, so this rejection cannot
    // arise there — the detector has already excused the job.)
    const rec = only(
      facts({
        jobs: [job("j-1", DAY, DAVE.userId)],
        rota: [shift("s-erin", ERIN.userId, DAY, 8, 17, "j-1")],
        roster: [DAVE, ERIN],
      }),
    );
    expect(rec.kind).toBe("assignment_off_rota");
    const erin = rec.ruledOut.find((r) => r.userId === ERIN.userId)!;
    expect(erin.code).toBe("already_on_this_job");
    expect(erin.evidence).toEqual(["s-erin"]);
    expect(names(covers(rec))).toEqual([DAVE.name]);
  });
});

// ── Rule 4 · alternative slots ───────────────────────────────────────────────

describe("alternative days for the same person", () => {
  it("offers the nearest free later days for an UNBOUND shift, ranked below any cover", () => {
    const rec = only(
      facts({
        rota: [
          shift("s-1", DAVE.userId, DAY, 8, 17),
          shift("s-2", DAVE.userId, DAY, 9, 12),
          // Dave is busy the next day, so the first free day is +2.
          shift("s-3", DAVE.userId, "2026-08-13", 8, 17),
        ],
        roster: [DAVE, ERIN],
      }),
    );
    const moves = rec.candidates.filter((c) => c.kind === "move_day");
    expect(moves).toHaveLength(MAX_DAY_MOVE_CANDIDATES);
    expect(moves.map((m) => m.day)).toEqual(["2026-08-14", "2026-08-15"]);
    expect(moves.every((m) => m.userId === DAVE.userId)).toBe(true);
    // The clock times are preserved exactly.
    expect(moves[0]!.startIso).toBe("2026-08-14T09:00:00.000Z");
    expect(moves[0]!.endIso).toBe("2026-08-14T12:00:00.000Z");
    // A cover always outranks a move: the promised date holds.
    expect(rec.candidates[0]!.kind).toBe("cover");
    expect(moves[0]!.score).toBeLessThan(rec.candidates[0]!.score);
    // Nearer beats further.
    expect(moves[0]!.score).toBeGreaterThan(moves[1]!.score);
  });

  it("refuses to move a JOB-BOUND shift, and says why", () => {
    const rec = only(
      facts({
        rota: [
          shift("s-1", DAVE.userId, DAY, 8, 17, "j-1"),
          shift("s-2", DAVE.userId, DAY, 9, 12, "j-2"),
        ],
        jobs: [job("j-1", DAY, DAVE.userId), job("j-2", DAY, DAVE.userId)],
        roster: [DAVE, ERIN],
      }),
    );
    expect(rec.candidates.every((c) => c.kind === "cover")).toBe(true);
    expect(rec.notes.join(" ")).toContain("tied to a job scheduled for");
  });

  it("says so when no later day in the fortnight is free", () => {
    const busyEveryDay: RotaShiftRow[] = [];
    for (let d = 13; d <= 23; d++) {
      busyEveryDay.push(shift(`s-fill-${d}`, DAVE.userId, `2026-08-${d}`, 8, 17));
    }
    const rec = only(
      facts({
        rota: [
          shift("s-1", DAVE.userId, DAY, 8, 17),
          shift("s-2", DAVE.userId, DAY, 9, 12),
          ...busyEveryDay,
        ],
        roster: [DAVE, ERIN],
      }),
    );
    expect(rec.candidates.some((c) => c.kind === "move_day")).toBe(false);
    expect(rec.notes.join(" ")).toContain("No later day inside this fortnight is free");
  });
});

// ── Rule 5 · the honest empty case ───────────────────────────────────────────

describe("when there is genuinely nobody", () => {
  it("returns an EMPTY list and explains it with the counts — never a padded name", () => {
    const rec = only(
      facts({
        rota: [
          shift("s-1", DAVE.userId, DAY, 8, 17, "j-1"),
          shift("s-2", DAVE.userId, DAY, 9, 12, "j-2"),
          shift("s-erin", ERIN.userId, DAY, 9, 12),
          shift("s-frank", FRANK.userId, DAY, 8, 18),
        ],
        jobs: [job("j-1", DAY, DAVE.userId), job("j-2", DAY, DAVE.userId)],
        leave: [leave("l-grace", GRACE.userId, "2026-08-11", "2026-08-13")],
        roster: [DAVE, ERIN, FRANK, GRACE],
      }),
    );
    expect(rec.candidates).toEqual([]);
    expect(rec.candidateTotal).toBe(0);
    expect(rec.impossible).toBe(
      "Nobody is free for 10:00–13:00 on Wed 12 Aug. Of the 3 people who could have taken it, 2 already on a shift that overlaps it and 1 on approved leave. This needs a decision you cannot make from the rota alone — extra hours, a subcontractor, or moving the work.",
    );
  });

  it("says plainly when the team is one person", () => {
    // Job-BOUND shifts, so the day-move escape hatch is closed too and this is
    // genuinely a dead end. (With unbound shifts the same person moving their
    // own clash IS the answer — see the alternative-days suite.)
    const rec = only(
      facts({
        rota: [
          shift("s-1", DAVE.userId, DAY, 8, 17, "j-1"),
          shift("s-2", DAVE.userId, DAY, 9, 12, "j-2"),
        ],
        jobs: [job("j-1", DAY, DAVE.userId), job("j-2", DAY, DAVE.userId)],
        roster: [DAVE],
      }),
    );
    expect(rec.candidates).toEqual([]);
    expect(rec.impossible).toContain("nobody else on the team");
  });

  it("says plainly when no roster was resolved at all", () => {
    const rec = only(
      facts({
        rota: [
          shift("s-1", DAVE.userId, DAY, 8, 17, "j-1"),
          shift("s-2", DAVE.userId, DAY, 9, 12, "j-2"),
        ],
        jobs: [job("j-1", DAY, DAVE.userId), job("j-2", DAY, DAVE.userId)],
        roster: [],
      }),
    );
    expect(rec.candidates).toEqual([]);
    expect(rec.considered).toBe(0);
    expect(rec.impossible).toContain("No team members");
  });

  it("sets `impossible` if and only if the candidate list is empty", () => {
    const recs = run(
      facts({
        rota: [shift("s-1", DAVE.userId, DAY, 8, 17), shift("s-2", DAVE.userId, DAY, 9, 12)],
        jobs: [job("j-lonely", "2026-08-19")],
        roster: [DAVE, ERIN],
      }),
    );
    expect(recs.size).toBe(2);
    for (const rec of recs.values()) {
      expect(rec.impossible == null).toBe(rec.candidates.length > 0);
    }
  });
});

// ── Scope · what carries no staffing question at all ─────────────────────────

describe("scope", () => {
  it("recommends for the four staffing classes and no others", () => {
    expect([...RECOMMENDABLE_KINDS]).toEqual([
      "staff_double_booked",
      "leave_clash",
      "assignment_off_rota",
      "job_unassigned",
    ]);
    expect(isRecommendable("asset_double_booked")).toBe(false);
  });

  it("omits a plant clash entirely rather than offering nobody for it", () => {
    const input = facts({
      custody: [
        { id: "a-1", asset_id: "asset-1", status: "closed", assigned_at: `${DAY}T07:00:00Z`, actual_return_at: "2026-08-15T16:00:00Z" },
        { id: "a-2", asset_id: "asset-1", status: "closed", assigned_at: `${DAY}T09:00:00Z`, actual_return_at: "2026-08-14T16:00:00Z" },
      ],
      roster: [DAVE, ERIN],
    });
    const conflicts = detectScheduleConflicts(input);
    expect(conflicts.map((c) => c.kind)).toEqual(["asset_double_booked"]);
    // ABSENT, not present-and-empty: "no question here" ≠ "we found nobody".
    expect(run(input).size).toBe(0);
  });

  it("summarises how many findings actually have an option", () => {
    const recs = run(
      facts({
        rota: [
          shift("s-1", DAVE.userId, DAY, 8, 17, "j-1"),
          shift("s-2", DAVE.userId, DAY, 9, 12, "j-2"),
        ],
        jobs: [job("j-1", DAY, DAVE.userId), job("j-2", DAY, DAVE.userId), job("j-lonely", "2026-08-19")],
        roster: [DAVE],
      }),
    );
    // Dave alone: his job-bound double-booking is a dead end, but he is free
    // for the unstaffed job a week later.
    expect(summariseRecommendations(recs)).toEqual({
      withRecommendations: 2,
      withCandidates: 1,
      withNobodyFree: 1,
    });
  });
});

// ── Applying is a human action ───────────────────────────────────────────────

describe("applying is a link a human presses, never something that happens", () => {
  it("points at the EXISTING assign-shift form with the fields filled in", () => {
    const rec = only(facts({ jobs: [job("j-1", DAY, DAVE.userId)], roster: [DAVE] }));
    const href = rec.candidates[0]!.applyHref;
    expect(href.startsWith("/staff/rota?")).toBe(true);
    const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(params.get("assign_user")).toBe(DAVE.userId);
    expect(params.get("assign_job")).toBe("j-1");
    expect(params.get("week")).toBe(DAY);
    // UTC wall clock — what `createRotaEntry` stores and what the rota grid
    // renders. London digits here would move every proposal an hour in BST.
    expect(params.get("assign_start")).toBe(`${DAY}T08:00`);
    expect(params.get("assign_end")).toBe(`${DAY}T17:00`);
  });

  it("omits the job parameter when the slot has no job", () => {
    const rec = only(
      facts({
        rota: [shift("s-1", DAVE.userId, DAY, 8, 17), shift("s-2", DAVE.userId, DAY, 9, 12)],
        roster: [DAVE, ERIN],
      }),
    );
    expect(rec.candidates[0]!.applyHref).not.toContain("assign_job");
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe("determinism", () => {
  const rows: RotaShiftRow[] = [
    shift("s-1", DAVE.userId, DAY, 8, 17),
    shift("s-2", DAVE.userId, DAY, 9, 12),
    shift("s-3", ERIN.userId, "2026-08-14", 8, 17),
    shift("s-4", FRANK.userId, "2026-08-15", 8, 17),
  ];

  it("gives byte-identical output for any permutation of the input rows", () => {
    const forwards = run(facts({ rota: rows, roster: [DAVE, ERIN, FRANK] }));
    const backwards = run(facts({ rota: [...rows].reverse(), roster: [FRANK, ERIN, DAVE] }));
    expect(JSON.stringify([...backwards])).toBe(JSON.stringify([...forwards]));
  });

  it("gives the same output twice for the same input", () => {
    const input = facts({ rota: rows, roster: [DAVE, ERIN, FRANK] });
    expect(JSON.stringify([...run(input)])).toBe(JSON.stringify([...run(input)]));
  });

  it("orders candidates totally — equal only when identical", () => {
    const candidates = allCandidates(run(facts({ rota: rows, roster: [DAVE, ERIN, FRANK] })));
    expect(candidates.length).toBeGreaterThan(1);
    for (const a of candidates) {
      for (const b of candidates) {
        const same = a.kind === b.kind && a.userId === b.userId && a.startIso === b.startIso;
        expect(compareCandidates(a, b) === 0).toBe(same);
      }
    }
  });

  it("does not mutate the facts it was given", () => {
    const rota = [shift("s-1", DAVE.userId, DAY, 8, 17), shift("s-2", DAVE.userId, DAY, 9, 12)];
    const input = facts({ rota, roster: [DAVE, ERIN] });
    const before = JSON.stringify(input);
    run(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(rota).toHaveLength(2);
  });
});

// ── Robustness ───────────────────────────────────────────────────────────────

describe("robustness", () => {
  it("returns nothing rather than guessing when the evidencing rows are missing", () => {
    const input = facts({
      rota: [shift("s-1", DAVE.userId, DAY, 8, 17), shift("s-2", DAVE.userId, DAY, 9, 12)],
      roster: [DAVE, ERIN],
    });
    const conflicts = detectScheduleConflicts(input);
    expect(conflicts).toHaveLength(1);
    // Same finding, but the rows it cites are gone: no need can be derived, so
    // no recommendation is made up from what is left.
    expect(recommendForConflicts(conflicts, facts({ roster: [DAVE, ERIN] })).size).toBe(0);
  });

  it("never proposes anyone outside the roster it was handed", () => {
    const rec = only(
      facts({
        // Grace holds shifts but is NOT a member of this org's roster — the
        // service resolves the roster from THIS org's memberships, so a
        // dual-org colleague can never be suggested here.
        rota: [
          shift("s-1", DAVE.userId, DAY, 8, 17),
          shift("s-2", DAVE.userId, DAY, 9, 12),
          shift("s-grace", GRACE.userId, "2026-08-14", 8, 17),
        ],
        roster: [DAVE, ERIN],
      }),
    );
    const seen = [...names(rec.candidates), ...rec.ruledOut.map((r) => r.userName)];
    expect(seen).not.toContain(GRACE.name);
    expect(rec.considered).toBe(2);
  });

  it("ignores a completed job — its staffing is history", () => {
    expect(run(facts({ jobs: [job("j-done", DAY, null, "completed")], roster: [DAVE] })).size).toBe(0);
  });
});
