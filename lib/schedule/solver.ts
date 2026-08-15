import {
  detectScheduleConflicts,
  type LeaveRow,
  type RotaShiftRow,
  type ScheduleConflict,
  type ScheduleConflictInput,
  type ScheduledJobRow,
} from "./conflicts";
import type { RosterMember } from "./recommendations";
import {
  daysBetween,
  overlaps,
  ukDayEndMs,
  ukDayKeyOf,
  ukDayStartMs,
  type Interval,
  type ScheduleWindow,
} from "./window";

/**
 * Deterministic Optimising Rota Generator — PROPOSE (PURE, no I/O, no model).
 *
 * lib/schedule/conflicts.ts OBSERVES ("this job has nobody on it").
 * lib/schedule/recommendations.ts answers ONE conflict at a time ("here is who
 * could cover THIS slot"). Neither turns a fortnight of unstaffed jobs into a
 * whole proposed rota — that is this module. It is the GENERATE step the product
 * did not have: a constraint-based assignment solver that takes every job in the
 * window that currently has nobody effectively working it, plus the org's staff,
 * their existing shifts and their approved leave, and emits one job → person
 * assignment per job with the exact score that chose it.
 *
 * ── SIX RULES IT IS BUILT AROUND ─────────────────────────────────────────────
 *
 * 1. NO MODEL, EVER. This is constraint satisfaction over rows the product
 *    already stores — interval overlap, set membership, integer arithmetic. No
 *    `lib/ai` import, no prompt, no token spend, no governor to bypass. Two runs
 *    on the same rows return byte-identical bytes. `__tests__/security/
 *    schedule-solver-no-ai.test.ts` pins that transitively, from source.
 *
 * 2. PROPOSE, NEVER APPLY. Nothing here writes. Each assignment carries an
 *    `applyHref` — a LINK that opens the EXISTING assign-shift form on
 *    /staff/rota with the fields pre-filled. The shift is written only when a
 *    human presses Assign, by `createRotaEntry`, under its own admin gate and
 *    overlap guard. This file imports nothing that can write; the surface
 *    renders links, never a form that posts on click. A rota that reassigns
 *    people the moment it is generated is a rota nobody trusts.
 *
 * 3. THE SCORE IS THE SHOWN REASONING. Every assignment carries an ordered list
 *    of `factors`, each with the sentence a manager reads, the row ids that
 *    evidence it, and its EXACT contribution to the score. `score` is defined as
 *    the sum of those deltas and asserted to be, so a factor that is not
 *    displayed cannot influence which person was chosen.
 *
 * 4. HARD CONSTRAINTS ARE NEVER SCORED AWAY. Being free for the slot — no
 *    overlapping shift, no approved leave, and not already placed on an
 *    overlapping slot earlier in THIS run — is a gate, not a weight. A very high
 *    soft score can never put a double-booked person on a job. The solver's own
 *    proposals are checked against each other, so one generated plan can never
 *    contain two overlapping shifts for one person.
 *
 * 5. AN UNFILLABLE JOB IS SAID PLAINLY. When every free person is exhausted the
 *    job comes back UNFILLED with the count that proves it (how many were on a
 *    shift, on leave, or already placed by this very plan), never a padded
 *    suggestion so the plan looks complete. A bad assignment costs more than an
 *    honest gap.
 *
 * 6. INSUFFICIENT INPUTS ⇒ SAY SO. No staff on the org, or no job that needs
 *    staffing, returns an empty plan with a stated reason — never an invented
 *    one.
 *
 * ── THERE IS NO SKILLS OR COMPETENCY MODEL IN THIS PRODUCT ───────────────────
 *
 * Checked, not assumed (and identical to the note lib/schedule/recommendations.ts
 * carries): `public.users` describes WHO a person is — name, email, phone, pay,
 * start date — and NOTHING about what they can DO. No skills table, no trade, no
 * certification, and no requirement side on `jobs` to match one against. So skill
 * is NOT scored and no proxy for it is invented; `memberships.role` is an
 * AUTHORISATION role (owner/admin/staff), not a competency, and it too is never
 * scored. This solver answers WHO IS FREE and, among the free, who is the LEAST
 * DISRUPTIVE and NEAREST choice — never "who is best". Guessing competence from
 * job history would produce confident, unfalsifiable nonsense.
 *
 * ── LOCATION IS SCORED ONLY WHERE IT IS A REAL FACT ──────────────────────────
 *
 * Jobs DO carry a site address (`resolveJobAddress` → postcode district). Staff
 * do NOT carry a home base, so staff→job distance cannot honestly be computed.
 * What CAN: whether a person is ALREADY working another job in the same postcode
 * district on the same day — a genuine "already near there" signal read straight
 * off the rota. That is the only location term, and it is present only when the
 * caller supplies districts; absent them, it silently contributes nothing rather
 * than guessing.
 */

// ── The scoring model (every weight, in one place) ───────────────────────────

/**
 * Nothing else may move an assignment's score: `score` is the sum of the deltas
 * of the factors an assignment actually carries, and `assertScoreIsSumOfFactors`
 * (exercised in the unit suite) holds it there.
 *
 * The weights mirror lib/schedule/recommendations.ts's CANDIDATE_SCORE where the
 * concepts overlap, so a manager who has read one panel reads the other without
 * relearning it. The two terms unique to a whole-plan generator are the location
 * signal and the fairness penalty (spread work rather than pile it on the one
 * person who happens to be freest).
 */
export const SOLVER_SCORE = {
  /** Base — an eligible person placed on a job that needed one. */
  assign: 1000,
  /** `jobs.assigned_to` already names them: the generator restores the plan. */
  namedAssignee: 40,
  /** They already hold another shift on THIS job in the window: they know it. */
  knowsTheJob: 30,
  /** Already working a job in the SAME postcode district that day: less travel. */
  sameAreaThatDay: 25,
  /** No other shift at all that UK day: the least disruptive placement. */
  clearAllDay: 20,
  /** Per other shift they already hold that UK day. */
  perOtherShiftThatDay: -10,
  /** Floor on the above, so a busy person still outranks nobody. */
  otherShiftPenaltyFloor: -30,
  /**
   * Per assignment THIS RUN has already given them — the fairness term. It
   * spreads a fortnight of work across the crew instead of loading the single
   * freest person, and it is what makes the generator an OPTIMISER rather than a
   * repeated one-slot picker.
   */
  perPriorAssignmentThisRun: -8,
  /** Floor on the fairness penalty. */
  priorAssignmentPenaltyFloor: -40,
} as const;

export type SolverFactorCode =
  | "eligible_and_free"
  | "no_leave_booked"
  | "named_assignee"
  | "knows_the_job"
  | "same_area_that_day"
  | "clear_all_day"
  | "existing_load"
  | "fair_share";

/**
 * One clause of the shown reasoning. `evidence` holds the row ids backing a
 * POSITIVE claim; it is empty for a claim about an absence ("no approved leave"),
 * which names the window searched instead — the same honest distinction
 * recommendations.ts draws.
 */
export interface SolverFactor {
  code: SolverFactorCode;
  /** The sentence fragment a manager reads. */
  text: string;
  /** Row ids evidencing this exact clause. Empty for an absence claim. */
  evidence: string[];
  /** This factor's EXACT contribution to `score`. */
  delta: number;
}

/**
 * The criteria in the order they are applied — exported so the surface can print
 * them. Criteria a user cannot read are a black box, and this module refuses to
 * be one.
 */
export const SOLVER_CRITERIA: ReadonlyArray<{ label: string; detail: string }> = [
  {
    label: "Free for the whole slot",
    detail:
      "Required, not scored. No shift of theirs overlaps it, no approved leave covers it, and nothing this plan already gave them overlaps it either.",
  },
  {
    label: "The person the job already names",
    detail: `+${SOLVER_SCORE.namedAssignee} when the job's assignee is this person — restoring a plan already made.`,
  },
  {
    label: "Already on this job",
    detail: `+${SOLVER_SCORE.knowsTheJob} when they hold another shift on the same job inside the window.`,
  },
  {
    label: "Already near there that day",
    detail: `+${SOLVER_SCORE.sameAreaThatDay} when they are already working a job in the same postcode area that day, so the plan adds no extra travel.`,
  },
  {
    label: "Clear that day",
    detail: `+${SOLVER_SCORE.clearAllDay} with nothing else on their rota that day; ${SOLVER_SCORE.perOtherShiftThatDay} per other shift they do hold, no worse than ${SOLVER_SCORE.otherShiftPenaltyFloor}.`,
  },
  {
    label: "A fair share of the work",
    detail: `${SOLVER_SCORE.perPriorAssignmentThisRun} per job this plan has already given them, no worse than ${SOLVER_SCORE.priorAssignmentPenaltyFloor}, so the fortnight is spread across the crew rather than piled on the freest person.`,
  },
  {
    label: "Then: lightest fortnight, then name",
    detail:
      "Equal scores break by who holds fewer shifts across the window, then alphabetically — so the order is total and reproducible.",
  },
];

/**
 * Skill is NOT among the criteria; the surface must say so rather than let a
 * manager assume the ranking knows something it does not. Shared verbatim with
 * recommendations.ts's note in intent.
 */
export const SOLVER_NO_SKILLS_NOTE =
  "This generator answers who is free and who is nearest, not who is best: CrewFlow stores no skills, trades or certifications against a person, so competence is not — and cannot honestly be — part of the order.";

// ── Inputs ───────────────────────────────────────────────────────────────────

/**
 * Everything the generator reads, all of it already fetched for detection. It
 * IS a ScheduleConflictInput (so `detectScheduleConflicts` can find the gaps
 * from the identical rows), plus the roster to assign from and an optional
 * per-job postcode district for the location signal.
 */
export interface RotaPlanInput extends ScheduleConflictInput {
  /** Every member of the active org — the only people who can be proposed. */
  roster?: readonly RosterMember[];
  /**
   * job_id → postcode district, resolved by the caller with the established
   * `districtForAddress(resolveJobAddress(...))` idiom. Optional: absent it, the
   * "already near there" term simply never fires. A job with no derivable
   * postcode is absent from the map, never guessed.
   */
  jobDistricts?: ReadonlyMap<string, string | null>;
}

// ── Outputs ──────────────────────────────────────────────────────────────────

/** The gap being filled — a job that currently has nobody effectively on it. */
export interface RotaNeed {
  jobId: string;
  /** Customer name (jobs carry no title), or a fallback. */
  jobLabel: string;
  /** Europe/London day the job is scheduled for. */
  day: string;
  startIso: string;
  endIso: string;
  /** Postcode district of the job's site, when known. */
  district: string | null;
  /** Which detected gap this is, for an honest headline. */
  reason: "job_unassigned" | "assignment_off_rota";
  /** Whole UK days from the window's first day. 0 = today. */
  daysAway: number;
}

export interface RotaAssignment {
  need: RotaNeed;
  userId: string;
  userName: string;
  /** `memberships.role` — context a manager knows. Zero score weight. */
  role: string;
  day: string;
  startIso: string;
  endIso: string;
  jobId: string;
  /** Sum of `factors[].delta`, and nothing else. */
  score: number;
  factors: SolverFactor[];
  /** The factor clauses joined into the line a manager reads. */
  explanation: string;
  /** Opens the EXISTING assign-shift form pre-filled. A link, never a submission. */
  applyHref: string;
  /** How many people were feasible for this job before one was chosen. */
  candidateCount: number;
  /** Shifts they hold across the window (pre-run) — the load tiebreak. */
  shiftsInWindow: number;
}

export type UnfilledCause =
  | "on_a_shift"
  | "on_approved_leave"
  | "placed_elsewhere_this_plan"
  | "no_staff";

export interface UnfilledJob {
  need: RotaNeed;
  /** Plain sentence naming why nobody could take it. Never padding. */
  reason: string;
  /** Per-cause counts behind that sentence. */
  causes: Record<Exclude<UnfilledCause, "no_staff">, number>;
  /** How many roster members were considered. */
  considered: number;
}

export interface RotaPlanSummary {
  /** Jobs found needing staffing. */
  needs: number;
  /** Of those, jobs the plan could staff. */
  assigned: number;
  /** Of those, jobs left honestly unfilled. */
  unfilled: number;
  /** Distinct people the plan would put to work. */
  peopleUsed: number;
}

export interface RotaPlan {
  window: ScheduleWindow;
  assignments: RotaAssignment[];
  unfilled: UnfilledJob[];
  summary: RotaPlanSummary;
  /**
   * Set ONLY when the generator had nothing honest to do — no staff, or no job
   * needing staffing. Never used to soften a real result.
   */
  insufficient: string | null;
  /** Limits of this particular plan, always shown. */
  notes: string[];
}

// ── The default job shift the DATABASE writes ────────────────────────────────

/**
 * 08:00–17:00 UTC — the shift `_tg_jobs_rota_sync` writes when a job gains an
 * assignee and a date (20260523000000_job_rota_unification.sql). A job-day gap
 * has no shift of its own to copy times from, so the product's own default is
 * used rather than an invented one. UTC because that is what the trigger stores
 * and what the rota grid renders with `getUTCHours()`.
 */
const JOB_DEFAULT_START_UTC_HOUR = 8;
const JOB_DEFAULT_END_UTC_HOUR = 17;

/** The gaps this generator staffs — a live job with nobody effectively on it. */
const TARGET_KINDS = new Set<ScheduleConflict["kind"]>([
  "job_unassigned",
  "assignment_off_rota",
]);

// ── Small helpers ────────────────────────────────────────────────────────────

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The instant of `HH:00:00Z` on a `YYYY-MM-DD`, or NaN for a malformed key. */
function utcInstantOnDay(dayKey: string, hour: number): number {
  const m = DAY_KEY.exec(dayKey.trim());
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour);
}

function instant(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function shiftInterval(row: RotaShiftRow): Interval | null {
  const start = instant(row.starts_at);
  const end = instant(row.ends_at);
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

/**
 * Approved leave as an instant range, INCLUSIVE of both dates — the same
 * conversion the detector and the recommender apply, so "on leave" means one
 * thing across the whole feature.
 */
function approvedLeaveInterval(row: LeaveRow): Interval | null {
  const start = ukDayStartMs(row.starts_at);
  const end = ukDayEndMs(row.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/** "09:00–18:00 on Wed 12 Aug" — the phrase every clause is built from. */
const UK_HHMM = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const UK_DAY_LABEL = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
});
function hhmm(ms: number): string {
  return UK_HHMM.format(new Date(ms));
}
function dayLabel(dayKey: string): string {
  const ms = ukDayStartMs(dayKey);
  if (!Number.isFinite(ms)) return dayKey;
  return UK_DAY_LABEL.format(new Date(ms + 43_200_000));
}
function slotPhrase(iv: Interval, day: string): string {
  return `${hhmm(iv.start)}–${hhmm(iv.end)} on ${dayLabel(day)}`;
}

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = keyOf(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function jobLabelOf(job: ScheduledJobRow | undefined): string {
  const n = job?.customer_name?.trim();
  return n && n.length > 0 ? n : "an unnamed job";
}

/** The naive `YYYY-MM-DDTHH:mm` a `datetime-local` input wants. UTC on purpose
 * (see recommendations.ts): `createRotaEntry` inserts it unqualified and the
 * grid renders with `getUTCHours()`, so the rota surface is UTC wall-clock end
 * to end. */
function datetimeLocalUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

/**
 * The pre-fill link. Query parameters only ever populate form fields an admin
 * could type by hand; the write still runs the full `createRotaEntry` gate, so a
 * hand-crafted URL grants nothing. Same shape as recommendations.ts's link.
 */
function buildApplyHref(input: {
  userId: string;
  start: number;
  end: number;
  day: string;
  jobId: string;
}): string {
  const params = new URLSearchParams({
    week: input.day,
    assign_user: input.userId,
    assign_start: datetimeLocalUtc(input.start),
    assign_end: datetimeLocalUtc(input.end),
    assign_job: input.jobId,
  });
  return `/staff/rota?${params.toString()}`;
}

/** `score` is the sum of the shown factors — the invariant, made callable. */
export function sumFactors(factors: readonly SolverFactor[]): number {
  return factors.reduce((total, f) => total + f.delta, 0);
}

// ── Availability, from records only ──────────────────────────────────────────

interface Availability {
  /** Shifts of theirs (existing OR placed this run) that overlap the slot. */
  clashingShifts: RotaShiftRow[];
  /** Approved leave covering the slot. */
  clashingLeave: LeaveRow[];
  /** Whether this plan has already placed them on an overlapping slot. */
  placedClash: boolean;
  /** A shift they already hold on THIS job (any day in the window). */
  knowsJobShift: RotaShiftRow | null;
  /** Their other EXISTING shifts that UK day. */
  otherShiftsThatDay: RotaShiftRow[];
  /** Their EXISTING shifts across the whole window — the load tiebreak. */
  shiftsInWindow: number;
}

/** A slot the plan has tentatively committed to a person during this run. */
interface Placement {
  userId: string;
  interval: Interval;
  day: string;
  district: string | null;
}

/**
 * Everything the ranking may know about one person for one slot: their existing
 * rota + approved leave, PLUS what this run has already committed. Approved
 * leave is the only leave consulted — a pending request is not a commitment,
 * exactly as the detector and recommender treat it.
 */
function availabilityFor(
  member: RosterMember,
  slot: Interval,
  day: string,
  jobId: string,
  index: {
    rotaByUser: Map<string, RotaShiftRow[]>;
    leaveByUser: Map<string, LeaveRow[]>;
    leaveIntervals: Map<string, Interval>;
    placementsByUser: Map<string, Placement[]>;
  },
): Availability {
  const clashingShifts: RotaShiftRow[] = [];
  const otherShiftsThatDay: RotaShiftRow[] = [];
  let knowsJobShift: RotaShiftRow | null = null;

  for (const row of index.rotaByUser.get(member.userId) ?? []) {
    const iv = shiftInterval(row);
    if (!iv) continue;
    if (ukDayKeyOf(new Date(iv.start).toISOString()) === day) otherShiftsThatDay.push(row);
    if (row.job_id === jobId && knowsJobShift == null) knowsJobShift = row;
    if (overlaps(iv, slot)) clashingShifts.push(row);
  }

  const clashingLeave = (index.leaveByUser.get(member.userId) ?? []).filter((l) => {
    const iv = index.leaveIntervals.get(l.id);
    return iv != null && overlaps(iv, slot);
  });

  const placedClash = (index.placementsByUser.get(member.userId) ?? []).some((p) =>
    overlaps(p.interval, slot),
  );

  return {
    clashingShifts: clashingShifts.sort((a, b) => (a.id < b.id ? -1 : 1)),
    clashingLeave: clashingLeave.sort((a, b) => (a.id < b.id ? -1 : 1)),
    placedClash,
    knowsJobShift,
    otherShiftsThatDay: otherShiftsThatDay.sort((a, b) => (a.id < b.id ? -1 : 1)),
    shiftsInWindow: (index.rotaByUser.get(member.userId) ?? []).length,
  };
}

/**
 * True when this person is already working a job in `district` on `day`, from
 * either an existing rota entry or a placement this run made. Only positive when
 * a district is actually known for both sides.
 */
function alreadyInAreaThatDay(
  member: RosterMember,
  day: string,
  district: string | null,
  index: {
    rotaByUser: Map<string, RotaShiftRow[]>;
    placementsByUser: Map<string, Placement[]>;
  },
  jobDistrictByShiftJob: (jobId: string | null) => string | null,
): { hit: boolean; evidence: string[] } {
  if (district === null) return { hit: false, evidence: [] };
  const evidence: string[] = [];

  for (const row of index.rotaByUser.get(member.userId) ?? []) {
    const iv = shiftInterval(row);
    if (!iv) continue;
    if (ukDayKeyOf(new Date(iv.start).toISOString()) !== day) continue;
    if (jobDistrictByShiftJob(row.job_id) === district) evidence.push(row.id);
  }
  for (const p of index.placementsByUser.get(member.userId) ?? []) {
    if (p.day === day && p.district === district) {
      // A placement has no persistent row id; the district match is the evidence.
      return { hit: true, evidence };
    }
  }
  return { hit: evidence.length > 0, evidence };
}

// ── Build one assignment, factor by factor ───────────────────────────────────

function buildAssignment(
  member: RosterMember,
  need: RotaNeed,
  slot: Interval,
  avail: Availability,
  context: {
    namedAssigneeId: string | null;
    priorAssignmentsThisRun: number;
    area: { hit: boolean; evidence: string[] };
  },
  candidateCount: number,
): RotaAssignment {
  const factors: SolverFactor[] = [
    {
      code: "eligible_and_free",
      text: `free ${slotPhrase(slot, need.day)} — no shift of theirs overlaps it`,
      evidence: [],
      delta: SOLVER_SCORE.assign,
    },
    {
      code: "no_leave_booked",
      text: `no approved leave covering that window`,
      evidence: [],
      delta: 0,
    },
  ];

  if (context.namedAssigneeId && context.namedAssigneeId === member.userId) {
    factors.push({
      code: "named_assignee",
      text: `already the job's named assignee`,
      evidence: [need.jobId],
      delta: SOLVER_SCORE.namedAssignee,
    });
  }

  if (avail.knowsJobShift) {
    const iv = shiftInterval(avail.knowsJobShift);
    const otherDay = iv ? ukDayKeyOf(new Date(iv.start).toISOString()) : null;
    factors.push({
      code: "knows_the_job",
      text: otherDay
        ? `already on this job on ${dayLabel(otherDay)}`
        : `already on this job elsewhere in the window`,
      evidence: [avail.knowsJobShift.id],
      delta: SOLVER_SCORE.knowsTheJob,
    });
  }

  if (context.area.hit) {
    factors.push({
      code: "same_area_that_day",
      text: need.district
        ? `already working in ${need.district} that day — no extra travel`
        : `already working nearby that day`,
      evidence: context.area.evidence,
      delta: SOLVER_SCORE.sameAreaThatDay,
    });
  }

  const load = avail.otherShiftsThatDay.length;
  if (load === 0) {
    factors.push({
      code: "clear_all_day",
      text: `nothing else on their rota that day`,
      evidence: [],
      delta: SOLVER_SCORE.clearAllDay,
    });
  } else {
    factors.push({
      code: "existing_load",
      text: `already has ${load} other ${load === 1 ? "shift" : "shifts"} that day`,
      evidence: avail.otherShiftsThatDay.map((r) => r.id),
      delta: Math.max(
        SOLVER_SCORE.otherShiftPenaltyFloor,
        load * SOLVER_SCORE.perOtherShiftThatDay,
      ),
    });
  }

  if (context.priorAssignmentsThisRun > 0) {
    factors.push({
      code: "fair_share",
      text: `this plan has already given them ${context.priorAssignmentsThisRun} ${
        context.priorAssignmentsThisRun === 1 ? "job" : "jobs"
      }`,
      evidence: [],
      delta: Math.max(
        SOLVER_SCORE.priorAssignmentPenaltyFloor,
        context.priorAssignmentsThisRun * SOLVER_SCORE.perPriorAssignmentThisRun,
      ),
    });
  }

  return {
    need,
    userId: member.userId,
    userName: member.name,
    role: member.role,
    day: need.day,
    startIso: new Date(slot.start).toISOString(),
    endIso: new Date(slot.end).toISOString(),
    jobId: need.jobId,
    score: sumFactors(factors),
    factors,
    explanation: `${member.name} — ${factors.map((f) => f.text).join("; ")}.`,
    applyHref: buildApplyHref({
      userId: member.userId,
      start: slot.start,
      end: slot.end,
      day: need.day,
      jobId: need.jobId,
    }),
    candidateCount,
    shiftsInWindow: avail.shiftsInWindow,
  };
}

/**
 * A TOTAL order over candidates for ONE job: score, then the lighter fortnight,
 * then fewer prior assignments this run, then name, then id. The trailing keys
 * make it total — two candidates compare equal only when they are the same
 * person — so the pick is byte-identical for any permutation of the input rows,
 * which matters because they arrive from independent queries.
 */
function compareCandidates(
  a: { assignment: RotaAssignment; prior: number },
  b: { assignment: RotaAssignment; prior: number },
): number {
  if (a.assignment.score !== b.assignment.score) return b.assignment.score - a.assignment.score;
  if (a.assignment.shiftsInWindow !== b.assignment.shiftsInWindow) {
    return a.assignment.shiftsInWindow - b.assignment.shiftsInWindow;
  }
  if (a.prior !== b.prior) return a.prior - b.prior;
  if (a.assignment.userName !== b.assignment.userName) {
    return a.assignment.userName < b.assignment.userName ? -1 : 1;
  }
  return a.assignment.userId < b.assignment.userId ? -1 : a.assignment.userId > b.assignment.userId ? 1 : 0;
}

// ── Derive the needs ─────────────────────────────────────────────────────────

/**
 * The jobs that need staffing, discovered by running the SHARED detector over
 * the identical rows and keeping only the two gap classes. Reusing
 * `detectScheduleConflicts` guarantees the generator and the schedule check can
 * never disagree about which jobs have nobody on them.
 */
function deriveNeeds(
  input: RotaPlanInput,
  jobById: Map<string, ScheduledJobRow>,
): RotaNeed[] {
  const conflicts = detectScheduleConflicts(input);
  const needs: RotaNeed[] = [];
  const seen = new Set<string>();

  for (const c of conflicts) {
    if (!TARGET_KINDS.has(c.kind)) continue;
    const jobId = c.sourceIds.find((id) => jobById.has(id));
    if (!jobId || seen.has(jobId)) continue;
    const job = jobById.get(jobId)!;
    const day = job.scheduled_date;
    if (!day) continue;
    const start = utcInstantOnDay(day, JOB_DEFAULT_START_UTC_HOUR);
    const end = utcInstantOnDay(day, JOB_DEFAULT_END_UTC_HOUR);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    seen.add(jobId);
    needs.push({
      jobId,
      jobLabel: jobLabelOf(job),
      day,
      startIso: new Date(start).toISOString(),
      endIso: new Date(end).toISOString(),
      district: input.jobDistricts?.get(jobId) ?? null,
      reason: c.kind as RotaNeed["reason"],
      daysAway: Math.max(0, daysBetween(input.window.fromDay, day)),
    });
  }
  return needs;
}

// ── The engine ───────────────────────────────────────────────────────────────

/**
 * Generate a proposed rota for one org's window.
 *
 * Deterministic and pure: identical facts in, identical bytes out. It reads
 * `input.window` for the horizon rather than a clock of its own, so a plan
 * rendered twice a second apart cannot disagree with itself.
 *
 * The algorithm is a MOST-CONSTRAINED-FIRST greedy assignment — a standard,
 * explainable CP heuristic. Jobs with the FEWEST feasible people are staffed
 * first (the scarce slots, before the easy ones consume the people who could
 * have filled them); ties break by soonest day, then job id. Each pick commits a
 * placement that later jobs in the same run see, so one plan never double-books a
 * person and the fairness term spreads the load as it goes.
 */
export function generateRota(input: RotaPlanInput): RotaPlan {
  const window = input.window;
  const rota = input.rota ?? [];
  const leaveApproved = (input.leave ?? []).filter((l) => l.status === "approved");
  const roster = input.roster ?? [];
  const jobById = new Map((input.jobs ?? []).map((j) => [j.id, j]));

  // job_id → district, for both the target job and any job a shift points at
  // (so "same area that day" can read another job's location off the rota).
  const jobDistricts = input.jobDistricts ?? new Map<string, string | null>();
  const districtOfJob = (jobId: string | null): string | null =>
    jobId ? jobDistricts.get(jobId) ?? null : null;

  const needs = deriveNeeds(input, jobById);

  const notes: string[] = [
    "Every job is given the database's default 08:00–17:00 UTC shift, the same one the rota writes when a job gains an assignee. Change the times on the rota form before confirming if the job needs different hours.",
  ];
  if (!input.jobDistricts) {
    notes.push(
      "Job locations were not supplied to this run, so the “already near there that day” term did not apply — no travel signal was used.",
    );
  }

  // ── insufficient-input paths, said plainly ─────────────────────────────────
  if (needs.length === 0) {
    return {
      window,
      assignments: [],
      unfilled: [],
      summary: { needs: 0, assigned: 0, unfilled: 0, peopleUsed: 0 },
      insufficient:
        "No job in this window needs staffing — every scheduled job already has someone assigned or on the rota for it. There is nothing to generate.",
      notes,
    };
  }
  if (roster.length === 0) {
    return {
      window,
      assignments: [],
      unfilled: needs.map((need) => ({
        need,
        reason:
          "There are no staff on this organisation's list, so there is nobody to put on this job.",
        causes: { on_a_shift: 0, on_approved_leave: 0, placed_elsewhere_this_plan: 0 },
        considered: 0,
      })),
      summary: { needs: needs.length, assigned: 0, unfilled: needs.length, peopleUsed: 0 },
      insufficient:
        "There are no staff on this organisation's list, so no rota can be generated. Add team members first.",
      notes,
    };
  }

  // ── indices, and the mutable placement ledger this run builds ───────────────
  const index = {
    rotaByUser: groupBy(rota, (r) => r.user_id),
    leaveByUser: groupBy(leaveApproved, (l) => l.user_id),
    leaveIntervals: new Map<string, Interval>(),
    placementsByUser: new Map<string, Placement[]>(),
  };
  for (const l of leaveApproved) {
    const iv = approvedLeaveInterval(l);
    if (iv) index.leaveIntervals.set(l.id, iv);
  }

  // A stable per-person tally of what this run has committed — the fairness term.
  const priorByUser = new Map<string, number>();

  // ── order the needs: most constrained first ────────────────────────────────
  // Feasibility is measured against the ORIGINAL availability (no placements
  // yet), so the ordering itself is a fixed function of the inputs.
  const feasibleCountFor = (need: RotaNeed): number => {
    const slot: Interval = { start: Date.parse(need.startIso), end: Date.parse(need.endIso) };
    let count = 0;
    for (const member of roster) {
      const avail = availabilityFor(member, slot, need.day, need.jobId, index);
      if (avail.clashingShifts.length === 0 && avail.clashingLeave.length === 0) count += 1;
    }
    return count;
  };
  const ordered = needs
    .map((need) => ({ need, feasible: feasibleCountFor(need) }))
    .sort(
      (a, b) =>
        a.feasible - b.feasible ||
        a.need.daysAway - b.need.daysAway ||
        (a.need.jobId < b.need.jobId ? -1 : a.need.jobId > b.need.jobId ? 1 : 0),
    );

  const assignments: RotaAssignment[] = [];
  const unfilled: UnfilledJob[] = [];

  for (const { need } of ordered) {
    const slot: Interval = { start: Date.parse(need.startIso), end: Date.parse(need.endIso) };
    const job = jobById.get(need.jobId);
    const namedAssigneeId = job?.assigned_to ?? null;

    const feasible: Array<{ assignment: RotaAssignment; prior: number }> = [];
    const causes = { on_a_shift: 0, on_approved_leave: 0, placed_elsewhere_this_plan: 0 };

    // First pass just to know the feasible count, shown on every assignment.
    let candidateCount = 0;
    for (const member of roster) {
      const avail = availabilityFor(member, slot, need.day, need.jobId, index);
      if (
        avail.clashingShifts.length === 0 &&
        avail.clashingLeave.length === 0 &&
        !avail.placedClash
      ) {
        candidateCount += 1;
      }
    }

    for (const member of roster) {
      const avail = availabilityFor(member, slot, need.day, need.jobId, index);

      // HARD constraints — a gate, never a weight (rule 4).
      if (avail.clashingLeave.length > 0) {
        causes.on_approved_leave += 1;
        continue;
      }
      if (avail.clashingShifts.length > 0) {
        causes.on_a_shift += 1;
        continue;
      }
      if (avail.placedClash) {
        causes.placed_elsewhere_this_plan += 1;
        continue;
      }

      const prior = priorByUser.get(member.userId) ?? 0;
      const area = alreadyInAreaThatDay(
        member,
        need.day,
        need.district,
        index,
        districtOfJob,
      );
      feasible.push({
        assignment: buildAssignment(
          member,
          need,
          slot,
          avail,
          { namedAssigneeId, priorAssignmentsThisRun: prior, area },
          candidateCount,
        ),
        prior,
      });
    }

    if (feasible.length === 0) {
      unfilled.push({
        need,
        reason: unfilledReason(need, causes, roster.length),
        causes,
        considered: roster.length,
      });
      continue;
    }

    feasible.sort(compareCandidates);
    const chosen = feasible[0]!.assignment;
    assignments.push(chosen);

    // Commit the placement so later jobs in this run see it.
    const placements = index.placementsByUser.get(chosen.userId) ?? [];
    placements.push({
      userId: chosen.userId,
      interval: slot,
      day: need.day,
      district: need.district,
    });
    index.placementsByUser.set(chosen.userId, placements);
    priorByUser.set(chosen.userId, (priorByUser.get(chosen.userId) ?? 0) + 1);
  }

  // Present in a stable, readable order: soonest day first, then job id. (The
  // PROCESSING order was constrainedness; the DISPLAY order is chronological.)
  assignments.sort(
    (a, b) =>
      a.need.daysAway - b.need.daysAway ||
      (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0),
  );
  unfilled.sort(
    (a, b) =>
      a.need.daysAway - b.need.daysAway ||
      (a.need.jobId < b.need.jobId ? -1 : a.need.jobId > b.need.jobId ? 1 : 0),
  );

  const peopleUsed = new Set(assignments.map((a) => a.userId)).size;

  return {
    window,
    assignments,
    unfilled,
    summary: {
      needs: needs.length,
      assigned: assignments.length,
      unfilled: unfilled.length,
      peopleUsed,
    },
    insufficient: null,
    notes,
  };
}

/** Why a job could not be staffed — from the counts, never softened (rule 5). */
function unfilledReason(
  need: RotaNeed,
  causes: { on_a_shift: number; on_approved_leave: number; placed_elsewhere_this_plan: number },
  rosterSize: number,
): string {
  const parts: string[] = [];
  if (causes.on_a_shift > 0) parts.push(`${causes.on_a_shift} already on a shift that overlaps it`);
  if (causes.on_approved_leave > 0) parts.push(`${causes.on_approved_leave} on approved leave`);
  if (causes.placed_elsewhere_this_plan > 0) {
    parts.push(`${causes.placed_elsewhere_this_plan} already placed on another job by this plan`);
  }
  const reason =
    parts.length === 0
      ? "nobody on the team was free"
      : parts.length === 1
        ? parts[0]!
        : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]!}`;
  const slot = `${hhmm(Date.parse(need.startIso))}–${hhmm(Date.parse(need.endIso))} on ${dayLabel(need.day)}`;
  return `Nobody is free for ${need.jobLabel} at ${slot}. Of the ${rosterSize} on the team, ${reason}. This needs a decision the rota alone cannot make — overtime, a subcontractor, or moving the job.`;
}

/** The invariant, callable: score equals the sum of the shown factors. */
export function assertScoreIsSumOfFactors(assignment: RotaAssignment): boolean {
  return assignment.score === sumFactors(assignment.factors);
}
