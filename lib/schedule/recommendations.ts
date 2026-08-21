import {
  formatConflictDay,
  formatConflictTime,
  type LeaveRow,
  type RotaShiftRow,
  type ScheduleConflict,
  type ScheduleConflictInput,
  type ScheduleConflictKind,
  type ScheduledJobRow,
} from "./conflicts";
import {
  addDays,
  daysBetween,
  overlaps,
  ukDayEndMs,
  ukDayKeyOf,
  ukDayStartMs,
  type Interval,
  type ScheduleWindow,
} from "./window";

/**
 * Schedule Recommendations — turning a detected conflict into CANDIDATE
 * RESOLUTIONS (PURE, no I/O, no clock, no model).
 *
 * lib/schedule/conflicts.ts says "these two shifts clash". This module answers
 * the only question that follows — "so who can actually take it, and when?" —
 * by constraint-solving over the rows already read for detection. It is the
 * RECOMMEND half of observe → explain → recommend, and it is deliberately the
 * whole of it: there is no fourth verb.
 *
 * ── FOUR RULES THIS MODULE IS BUILT AROUND ───────────────────────────────────
 *
 * 1. PROPOSE, NEVER APPLY. Nothing here moves, creates, edits or deletes a
 *    shift, and nothing downstream may either without a human pressing a button.
 *    A candidate carries an `applyHref` — a LINK that opens the existing
 *    assign-shift form on /staff/rota with the fields pre-filled. The write is
 *    still `createRotaEntry` (admin-gated, active-org pinned, overlap-checked);
 *    this module introduces no write path and no new authority. A system that
 *    silently moves a person's shift is a system nobody trusts, so the trust
 *    boundary is structural: this file imports nothing that can write, and the
 *    surface renders links, never a form that posts on click.
 *
 * 2. NO AI, EVER. This is constraint-solving over known facts — interval
 *    overlap, set membership, integer arithmetic. There is no model call, no
 *    `lib/ai` import and no prompt anywhere in the chain, so there is no token
 *    spend, no governor to bypass, and no answer that changes between two runs
 *    on the same data. `__tests__/security/schedule-recommendations-no-ai.test.ts`
 *    pins that as source.
 *
 * 3. THE SCORE IS THE SHOWN REASONING — literally. Every candidate carries an
 *    ordered list of `factors`, each with the sentence a manager reads, the row
 *    ids that evidence it, and its EXACT contribution to the score. `score` is
 *    defined as the sum of those deltas and is asserted to be, so a factor that
 *    is not displayed cannot influence the ranking. "Suggest Dave" is useless;
 *    "Dave — free 09:00 to 18:00 Wed, no approved leave, nothing else on that day"
 *    is a decision a manager can accept or reject.
 *
 *    Positive claims cite row ids. A NEGATIVE claim ("no approved leave") is
 *    evidenced by the ABSENCE of a row in the window that was searched, so it
 *    carries no id and says which window it searched — an honest distinction,
 *    not a missing citation.
 *
 * 4. AN EMPTY LIST IS AN ANSWER. When everybody is booked, the answer is
 *    "nobody is free", with the count that proves it — never a padded
 *    suggestion so the panel looks helpful. A bad recommendation costs more
 *    than a blank one, because a manager who follows one learns not to read
 *    the next.
 *
 * ── THERE IS NO SKILLS OR COMPETENCY MODEL IN THIS PRODUCT ───────────────────
 *
 * Checked, not assumed: `public.users` holds avatar_url, email, phone,
 * emergency_contact, employment_type, hourly_pay, start_date and full_name —
 * and nothing describing what a person can DO. No skills table, no trade, no
 * certification/ticket record, and no requirement side on `jobs` to match one
 * against. `memberships.role` is owner/admin/staff: an AUTHORISATION role that
 * says who may edit the rota, not who can hang a door.
 *
 * So competence is NOT scored, and no proxy for it is invented. Role travels on
 * a candidate as plain context a manager already knows, with a zero score
 * contribution — visible, and provably inert. The ranking answers "who is
 * FREE", never "who is BEST", and the surface says exactly that. Building a
 * skills taxonomy is a product decision with a schema behind it; guessing one
 * from job history would produce confident, unfalsifiable nonsense.
 *
 * ── WHAT IS DELIBERATELY NOT RECOMMENDED ─────────────────────────────────────
 *
 * `asset_double_booked` gets no candidates at all. Two overlapping custody
 * records for one asset are a data-integrity fault — the past is wrong — and
 * "who is free" is not a sentence about it. The fix is to correct the history,
 * which the finding already links to. Offering staffing options there would be
 * answering a question nobody asked.
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * The conflict classes a resolution can be computed for. Every one of them
 * reduces to the same shape: SOMEBODY has to be on a known slot, and somebody
 * currently is not — which is why one candidate generator serves all four.
 */
export const RECOMMENDABLE_KINDS = [
  "staff_double_booked",
  "leave_clash",
  "assignment_off_rota",
  "job_unassigned",
] as const satisfies readonly ScheduleConflictKind[];

export type RecommendableKind = (typeof RECOMMENDABLE_KINDS)[number];

const RECOMMENDABLE = new Set<string>(RECOMMENDABLE_KINDS);

export function isRecommendable(kind: ScheduleConflictKind): kind is RecommendableKind {
  return RECOMMENDABLE.has(kind);
}

/**
 * `cover` — a DIFFERENT person takes the same slot. The promised date holds;
 *           only who turns up changes.
 * `move_day` — the SAME person keeps the work at the same clock times on a
 *           later day. The date changes, which is why it ranks below a cover:
 *           a customer may already have been told the date, and this module
 *           cannot see what they were told.
 */
export type CandidateKind = "cover" | "move_day";

/**
 * Every input to the ranking, named. Nothing else may move a candidate's score:
 * `score` is the sum of the deltas of the factors a candidate actually carries,
 * and `assertScoreIsSumOfFactors` (exercised in the unit suite) holds it there.
 *
 * The two bases are 500 apart — more than any bonus or penalty below can bridge
 * — so a cover ALWAYS outranks a day-move. That is a product statement (keep the
 * date, change the person), not a tuning artefact.
 */
export const CANDIDATE_SCORE = {
  /** Base — a different person on the same slot. */
  cover: 1000,
  /** Base — the same person, same times, a later free day. */
  moveDay: 500,
  /** `jobs.assigned_to` already names them: restoring the intended plan. */
  namedAssignee: 40,
  /** They hold another shift on THIS job inside the window: they know it. */
  knowsTheJob: 30,
  /** No other shift at all that UK day: the least disruptive choice. */
  clearAllDay: 20,
  /** Per other shift already held that UK day. */
  perOtherShiftThatDay: -10,
  /** Floor on the above, so a very busy person still ranks above nobody. */
  otherShiftPenaltyFloor: -30,
  /** Per whole day a `move_day` candidate displaces the work. */
  perDayDisplaced: -2,
} as const;

export type CandidateFactorCode =
  | "cover_for_the_slot"
  | "move_to_a_free_day"
  | "free_in_window"
  | "no_leave_booked"
  | "named_assignee"
  | "knows_the_job"
  | "clear_all_day"
  | "existing_load"
  | "days_displaced";

/**
 * One clause of the shown reasoning.
 *
 * `evidence` holds the row ids backing a POSITIVE claim. It is empty for a
 * claim about an absence (see rule 3) — the clause names the window searched
 * instead, which is what a manager checks.
 */
export interface CandidateFactor {
  code: CandidateFactorCode;
  /** The sentence fragment a manager reads. */
  text: string;
  /** Row ids evidencing this exact clause. Empty for an absence claim. */
  evidence: string[];
  /** This factor's EXACT contribution to `score`. */
  delta: number;
}

/**
 * The ranking criteria, in the order they are applied — exported so the surface
 * can print them. Criteria a user cannot read are not criteria, they are a
 * black box, and this module refuses to be one.
 */
export const RECOMMENDATION_CRITERIA: ReadonlyArray<{ label: string; detail: string }> = [
  {
    label: "Free for the whole slot",
    detail:
      "Required, not scored. No rota entry of theirs overlaps it, and no approved leave covers it.",
  },
  {
    label: "Cover before moving the date",
    detail: `A different person on the same slot scores ${CANDIDATE_SCORE.cover}; the same person on a later day scores ${CANDIDATE_SCORE.moveDay}. Keeping a promised date beats changing it.`,
  },
  {
    label: "The person the job already names",
    detail: `+${CANDIDATE_SCORE.namedAssignee} when the job's assignee is this person — restoring the plan that was already made.`,
  },
  {
    label: "Already on this job",
    detail: `+${CANDIDATE_SCORE.knowsTheJob} when they hold another shift on the same job inside the fortnight.`,
  },
  {
    label: "Clear that day",
    detail: `+${CANDIDATE_SCORE.clearAllDay} with nothing else on their rota that day; ${CANDIDATE_SCORE.perOtherShiftThatDay} per other shift they do hold, no worse than ${CANDIDATE_SCORE.otherShiftPenaltyFloor}.`,
  },
  {
    label: "Soonest replacement day",
    detail: `${CANDIDATE_SCORE.perDayDisplaced} per day a move pushes the work back, so the nearest free day comes first.`,
  },
  {
    label: "Then: lightest fortnight, then name",
    detail:
      "Equal scores break by who holds fewer shifts across the whole window, then alphabetically — so the order is total and reproducible.",
  },
];

/**
 * Skill is NOT among the criteria, and the surface must say so rather than let
 * a manager assume the ranking knows something it does not.
 */
export const NO_SKILLS_MODEL_NOTE =
  "Ranking answers who is free, not who is best: CrewFlow stores no skills, trades or certifications against a person, so competence is not — and cannot honestly be — part of this order.";

// ── Inputs ───────────────────────────────────────────────────────────────────

/**
 * A member of the ACTIVE org. Resolved by the service from this org's
 * `memberships` joined to `users`, so a colleague in the viewer's OTHER org can
 * never be proposed — the same pin that keeps them from being NAMED in a
 * conflict (server/services/schedule-integrity.ts).
 */
export interface RosterMember {
  userId: string;
  name: string;
  /** `memberships.role`. Context only — see the header. Never scored. */
  role: string;
}

export interface RecommendationInput extends ScheduleConflictInput {
  /** Every member of the active org — including everyone in no conflict at all. */
  roster?: readonly RosterMember[];
}

// ── Outputs ──────────────────────────────────────────────────────────────────

/** What has to become true for the conflict to be resolved. */
export interface CoverageNeed {
  /** One sentence stating the gap, e.g. "Someone needs to cover 09:00 to 18:00…". */
  summary: string;
  /** The Europe/London day the slot falls on. */
  day: string;
  startIso: string;
  endIso: string;
  /** The job the slot belongs to, when it has one. */
  jobId: string | null;
  /** The existing shift a resolution would replace — what a human deletes after. */
  replacesShiftIds: string[];
  /** The already-conflicted person; never offered as their own cover. */
  excludedUserIds: string[];
}

export interface RecommendationCandidate {
  kind: CandidateKind;
  userId: string;
  userName: string;
  /** `memberships.role` — context a manager already knows. Zero score weight. */
  role: string;
  day: string;
  startIso: string;
  endIso: string;
  jobId: string | null;
  /** Sum of `factors[].delta`, and nothing else. */
  score: number;
  factors: CandidateFactor[];
  /** The factor clauses joined into the line a manager reads. */
  explanation: string;
  /**
   * Opens the EXISTING assign-shift form with these fields pre-filled. A link,
   * never a submission: the shift exists only once a human presses Assign, and
   * only if `createRotaEntry` lets them.
   */
  applyHref: string;
  /** Shifts they already hold on that UK day (drives `existing_load`). */
  otherShiftsThatDay: number;
  /** Shifts they hold across the whole window — the load tiebreak. */
  shiftsInWindow: number;
}

export type RuledOutCode =
  | "is_the_conflicted_person"
  | "on_approved_leave"
  | "already_on_a_shift"
  | "already_on_this_job";

/** Somebody considered and rejected, with the record that rejected them. */
export interface RuledOutCandidate {
  userId: string;
  userName: string;
  code: RuledOutCode;
  text: string;
  evidence: string[];
}

export interface ScheduleRecommendation {
  /** The `ScheduleConflict.key` this answers — a 1:1 join, no re-derivation. */
  conflictKey: string;
  kind: RecommendableKind;
  need: CoverageNeed;
  /** Viable resolutions, best first. EMPTY when there genuinely is none. */
  candidates: RecommendationCandidate[];
  /** How many were viable BEFORE the display cap. */
  candidateTotal: number;
  ruledOut: RuledOutCandidate[];
  ruledOutTotal: number;
  /** Roster members evaluated for this need. */
  considered: number;
  /** Plain sentence, set ONLY when `candidates` is empty. Never padding. */
  impossible: string | null;
  /** Limits of this particular answer, always shown — not only when empty. */
  notes: string[];
}

/** Covers offered per conflict. Beyond a handful a manager is picking, not reading. */
export const MAX_COVER_CANDIDATES = 4;
/**
 * Day-moves offered per conflict. Held in a SEPARATE bucket from covers rather
 * than sharing one cap, because a cover always outscores a move: one merged cap
 * would hide the alternative-slot answer entirely whenever four people are free.
 */
export const MAX_DAY_MOVE_CANDIDATES = 2;
/** Ruled-out people listed. `ruledOutTotal` keeps the count honest past it. */
export const MAX_RULED_OUT_SHOWN = 8;

/**
 * The default shift the DATABASE itself writes when a job gains an assignee and
 * a date — 08:00 to 17:00 UTC, from `_tg_jobs_rota_sync`
 * (20260523000000_job_rota_unification.sql). A job-day gap has no shift of its
 * own to copy times from, so the product's own default is used rather than an
 * invented one. Stated in UTC because that is what the trigger stores.
 */
const JOB_DEFAULT_START_UTC_HOUR = 8;
const JOB_DEFAULT_END_UTC_HOUR = 17;

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

/** "09:00 to 18:00 on Wed 12 Aug" — the phrase every clause is built from. */
function slotPhrase(iv: Interval, day: string): string {
  return `${formatConflictTime(iv.start)}–${formatConflictTime(iv.end)} on ${formatConflictDay(day)}`;
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

function countPeople(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/**
 * The naive `YYYY-MM-DDTHH:mm` a `datetime-local` input wants.
 *
 * UTC ON PURPOSE. `createRotaEntry` inserts this string unqualified, so
 * Postgres reads it in the session zone (UTC), and the rota grid renders shifts
 * with `getUTCHours()`. The rota surface is therefore UTC wall-clock end to end;
 * pre-filling Europe/London digits would silently move every proposed shift an
 * hour later for the seven months of BST. The DISPLAYED time stays London, like
 * the rest of the conflicts page — the surface states the difference rather
 * than quietly reconciling it.
 */
function datetimeLocalUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

/**
 * The pre-fill link. Query parameters only ever populate form fields an admin
 * could type by hand; the write still runs the full `createRotaEntry` gate, so
 * a hand-crafted URL grants nothing.
 */
function buildApplyHref(input: {
  userId: string;
  start: number;
  end: number;
  day: string;
  jobId: string | null;
}): string {
  const params = new URLSearchParams({
    week: input.day,
    assign_user: input.userId,
    assign_start: datetimeLocalUtc(input.start),
    assign_end: datetimeLocalUtc(input.end),
  });
  if (input.jobId) params.set("assign_job", input.jobId);
  return `/staff/rota?${params.toString()}`;
}

/** `score` is the sum of the shown factors — the invariant, made callable. */
export function sumFactors(factors: readonly CandidateFactor[]): number {
  return factors.reduce((total, f) => total + f.delta, 0);
}

// ── Step 1 · what does this conflict actually need? ──────────────────────────

/**
 * Turn a finding back into a slot that needs staffing, using the same rows the
 * detector cited. `sourceIds` are sorted inside the conflict, so which row is
 * which is recovered by LOOKING THEM UP rather than by trusting their order.
 *
 * Returns null when the evidencing rows are no longer resolvable from the facts
 * in hand — a recommendation invented from a half-missing conflict would cite
 * records that do not support it.
 */
function deriveNeed(
  conflict: ScheduleConflict,
  facts: {
    rotaById: Map<string, RotaShiftRow>;
    leaveById: Map<string, LeaveRow>;
    jobById: Map<string, ScheduledJobRow>;
  },
): CoverageNeed | null {
  switch (conflict.kind) {
    // Two overlapping shifts for one person. Exactly one of them has to give.
    // The LATER-STARTING one is re-covered (a manager keeps the commitment
    // already under way); an exact tie — the shape the job-assignment trigger
    // produces, two identical 08:00 to 17:00 shifts — breaks on the greater row
    // id, so the choice is arbitrary but never varies between two runs.
    case "staff_double_booked": {
      const shifts = conflict.sourceIds
        .map((id) => facts.rotaById.get(id))
        .filter((r): r is RotaShiftRow => r != null)
        .map((row) => ({ row, iv: shiftInterval(row) }))
        .filter((s): s is { row: RotaShiftRow; iv: Interval } => s.iv != null);
      if (shifts.length < 2) return null;
      const target = [...shifts].sort(
        (a, b) => b.iv.start - a.iv.start || (a.row.id > b.row.id ? -1 : 1),
      )[0]!;
      const day = ukDayKeyOf(new Date(target.iv.start).toISOString());
      return {
        summary: `Someone else needs to cover ${slotPhrase(target.iv, day)} so the two shifts stop overlapping.`,
        day,
        startIso: new Date(target.iv.start).toISOString(),
        endIso: new Date(target.iv.end).toISOString(),
        jobId: target.row.job_id ?? null,
        replacesShiftIds: [target.row.id],
        excludedUserIds: [target.row.user_id],
      };
    }

    // Rostered during approved leave. The leave stands — this module never
    // proposes revisiting an approval — so the SHIFT is what needs covering.
    case "leave_clash": {
      const shift = conflict.sourceIds
        .map((id) => facts.rotaById.get(id))
        .find((r): r is RotaShiftRow => r != null);
      const leave = conflict.sourceIds
        .map((id) => facts.leaveById.get(id))
        .find((l): l is LeaveRow => l != null);
      if (!shift || !leave) return null;
      const iv = shiftInterval(shift);
      if (!iv) return null;
      const day = ukDayKeyOf(new Date(iv.start).toISOString());
      return {
        summary: `Someone else needs to cover ${slotPhrase(iv, day)} — the person rostered for it is on approved leave.`,
        day,
        startIso: new Date(iv.start).toISOString(),
        endIso: new Date(iv.end).toISOString(),
        jobId: shift.job_id ?? null,
        replacesShiftIds: [shift.id],
        excludedUserIds: [shift.user_id],
      };
    }

    // The job names an assignee who holds no shift that day, or names nobody at
    // all. Either way the slot is the job's day and nobody is excluded — for
    // the off-rota case the named assignee is the most likely right answer, so
    // ruling them out would be the one mistake worth avoiding.
    case "assignment_off_rota":
    case "job_unassigned": {
      const job = conflict.sourceIds
        .map((id) => facts.jobById.get(id))
        .find((j): j is ScheduledJobRow => j != null);
      const day = job?.scheduled_date ?? null;
      if (!job || !day) return null;
      const start = utcInstantOnDay(day, JOB_DEFAULT_START_UTC_HOUR);
      const end = utcInstantOnDay(day, JOB_DEFAULT_END_UTC_HOUR);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      const iv: Interval = { start, end };
      const summary =
        conflict.kind === "job_unassigned"
          ? `Nobody is on this job. It needs someone on ${slotPhrase(iv, day)}.`
          : `The assignee holds no shift that day. The job needs someone on ${slotPhrase(iv, day)}.`;
      return {
        summary,
        day,
        startIso: new Date(start).toISOString(),
        endIso: new Date(end).toISOString(),
        jobId: job.id,
        replacesShiftIds: [],
        excludedUserIds: [],
      };
    }

    default:
      return null;
  }
}

// ── Step 2 · availability, from records only ─────────────────────────────────

interface Availability {
  /** Shifts of theirs that overlap the slot — any one of these disqualifies. */
  clashingShifts: RotaShiftRow[];
  /** Approved leave covering the slot — disqualifying. */
  clashingLeave: LeaveRow[];
  /** A shift they already hold on THIS job, overlapping the slot. */
  alreadyOnJob: RotaShiftRow | null;
  /** Their other shifts that UK day (excluding the one being replaced). */
  otherShiftsThatDay: RotaShiftRow[];
  /** Their shifts across the whole window — the load tiebreak. */
  shiftsInWindow: number;
}

/**
 * Everything the ranking is allowed to know about one person for one slot, read
 * off the rows and nothing else. Approved leave is the only leave consulted —
 * a pending request is not yet a commitment, exactly as the detector treats it.
 */
function availabilityFor(
  userId: string,
  slot: Interval,
  day: string,
  need: CoverageNeed,
  index: {
    rotaByUser: Map<string, RotaShiftRow[]>;
    leaveByUser: Map<string, LeaveRow[]>;
    leaveIntervals: Map<string, Interval>;
  },
): Availability {
  const replaced = new Set(need.replacesShiftIds);
  const mine = (index.rotaByUser.get(userId) ?? []).filter((r) => !replaced.has(r.id));

  const clashingShifts: RotaShiftRow[] = [];
  const otherShiftsThatDay: RotaShiftRow[] = [];
  let alreadyOnJob: RotaShiftRow | null = null;

  for (const row of mine) {
    const iv = shiftInterval(row);
    if (!iv) continue;
    if (ukDayKeyOf(new Date(iv.start).toISOString()) === day) otherShiftsThatDay.push(row);
    if (!overlaps(iv, slot)) continue;
    if (need.jobId && row.job_id === need.jobId && alreadyOnJob == null) alreadyOnJob = row;
    clashingShifts.push(row);
  }

  const clashingLeave = (index.leaveByUser.get(userId) ?? []).filter((l) => {
    const iv = index.leaveIntervals.get(l.id);
    return iv != null && overlaps(iv, slot);
  });

  return {
    clashingShifts: clashingShifts.sort((a, b) => (a.id < b.id ? -1 : 1)),
    clashingLeave: clashingLeave.sort((a, b) => (a.id < b.id ? -1 : 1)),
    alreadyOnJob,
    otherShiftsThatDay: otherShiftsThatDay.sort((a, b) => (a.id < b.id ? -1 : 1)),
    shiftsInWindow: mine.length,
  };
}

const LEAVE_TYPE_LABELS: Record<string, string> = {
  holiday: "holiday",
  sick: "sick leave",
  emergency: "emergency leave",
  unpaid: "unpaid leave",
};

function leaveLabel(row: LeaveRow): string {
  return LEAVE_TYPE_LABELS[row.type ?? ""] ?? "leave";
}

// ── Step 3 · build one candidate, factor by factor ───────────────────────────

function buildCoverCandidate(
  member: RosterMember,
  slot: Interval,
  day: string,
  need: CoverageNeed,
  avail: Availability,
  context: { namedAssigneeId: string | null; sameJobShift: RotaShiftRow | null },
): RecommendationCandidate {
  const factors: CandidateFactor[] = [
    {
      code: "cover_for_the_slot",
      text: `covers the slot without changing the date`,
      evidence: [...need.replacesShiftIds],
      delta: CANDIDATE_SCORE.cover,
    },
    {
      code: "free_in_window",
      text: `free ${slotPhrase(slot, day)} — no shift of theirs overlaps it`,
      evidence: [],
      delta: 0,
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
      evidence: need.jobId ? [need.jobId] : [],
      delta: CANDIDATE_SCORE.namedAssignee,
    });
  }

  if (context.sameJobShift) {
    const iv = shiftInterval(context.sameJobShift);
    const otherDay = iv ? ukDayKeyOf(new Date(iv.start).toISOString()) : null;
    factors.push({
      code: "knows_the_job",
      text: otherDay
        ? `already on this job on ${formatConflictDay(otherDay)}`
        : `already on this job elsewhere in the fortnight`,
      evidence: [context.sameJobShift.id],
      delta: CANDIDATE_SCORE.knowsTheJob,
    });
  }

  const load = avail.otherShiftsThatDay.length;
  if (load === 0) {
    factors.push({
      code: "clear_all_day",
      text: `nothing else on their rota that day`,
      evidence: [],
      delta: CANDIDATE_SCORE.clearAllDay,
    });
  } else {
    factors.push({
      code: "existing_load",
      text: `already has ${load} other ${load === 1 ? "shift" : "shifts"} that day`,
      evidence: avail.otherShiftsThatDay.map((r) => r.id),
      delta: Math.max(
        CANDIDATE_SCORE.otherShiftPenaltyFloor,
        load * CANDIDATE_SCORE.perOtherShiftThatDay,
      ),
    });
  }

  return finishCandidate("cover", member, slot, day, need.jobId, factors, avail);
}

function buildMoveDayCandidate(
  member: RosterMember,
  slot: Interval,
  day: string,
  need: CoverageNeed,
  avail: Availability,
  displaced: number,
): RecommendationCandidate {
  const factors: CandidateFactor[] = [
    {
      code: "move_to_a_free_day",
      text: `keeps the same person and the same hours, on a later free day`,
      evidence: [...need.replacesShiftIds],
      delta: CANDIDATE_SCORE.moveDay,
    },
    {
      code: "free_in_window",
      text: `free ${slotPhrase(slot, day)} — no shift of theirs overlaps it`,
      evidence: [],
      delta: 0,
    },
    {
      code: "no_leave_booked",
      text: `no approved leave covering that window`,
      evidence: [],
      delta: 0,
    },
    {
      code: "days_displaced",
      text: `${displaced} ${displaced === 1 ? "day" : "days"} later than originally planned`,
      evidence: [],
      delta: displaced * CANDIDATE_SCORE.perDayDisplaced,
    },
  ];

  const load = avail.otherShiftsThatDay.length;
  if (load === 0) {
    factors.push({
      code: "clear_all_day",
      text: `nothing else on their rota that day`,
      evidence: [],
      delta: CANDIDATE_SCORE.clearAllDay,
    });
  } else {
    factors.push({
      code: "existing_load",
      text: `already has ${load} other ${load === 1 ? "shift" : "shifts"} that day`,
      evidence: avail.otherShiftsThatDay.map((r) => r.id),
      delta: Math.max(
        CANDIDATE_SCORE.otherShiftPenaltyFloor,
        load * CANDIDATE_SCORE.perOtherShiftThatDay,
      ),
    });
  }

  return finishCandidate("move_day", member, slot, day, need.jobId, factors, avail);
}

function finishCandidate(
  kind: CandidateKind,
  member: RosterMember,
  slot: Interval,
  day: string,
  jobId: string | null,
  factors: CandidateFactor[],
  avail: Availability,
): RecommendationCandidate {
  return {
    kind,
    userId: member.userId,
    userName: member.name,
    role: member.role,
    day,
    startIso: new Date(slot.start).toISOString(),
    endIso: new Date(slot.end).toISOString(),
    jobId,
    score: sumFactors(factors),
    factors,
    explanation: `${member.name} — ${factors.map((f) => f.text).join("; ")}.`,
    applyHref: buildApplyHref({
      userId: member.userId,
      start: slot.start,
      end: slot.end,
      day,
      jobId,
    }),
    otherShiftsThatDay: avail.otherShiftsThatDay.length,
    shiftsInWindow: avail.shiftsInWindow,
  };
}

/**
 * A TOTAL order: score, then the lighter fortnight, then name, then id. The
 * last key makes it total — two candidates compare equal only when they are the
 * same candidate — so the list is byte-identical for any permutation of the
 * input rows, which matters because they arrive from independent queries.
 */
export function compareCandidates(
  a: RecommendationCandidate,
  b: RecommendationCandidate,
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.shiftsInWindow !== b.shiftsInWindow) return a.shiftsInWindow - b.shiftsInWindow;
  if (a.userName !== b.userName) return a.userName < b.userName ? -1 : 1;
  if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
  return a.startIso < b.startIso ? -1 : a.startIso > b.startIso ? 1 : 0;
}

// ── Step 4 · the impossible case, said plainly ───────────────────────────────

/**
 * Why there is nobody — from the counts, never softened.
 *
 * Called ONLY when no candidate survived. Returning a sentence here is the
 * whole point: the alternative is a list padded with somebody who is already
 * booked, and a manager who follows one of those stops reading the panel.
 */
function explainImpossibility(
  ruledOut: readonly RuledOutCandidate[],
  rosterSize: number,
  need: CoverageNeed,
): string {
  if (rosterSize === 0) {
    return "No team members are on this organisation's staff list, so there is nobody to propose.";
  }
  const others = ruledOut.filter((r) => r.code !== "is_the_conflicted_person");
  if (others.length === 0) {
    return "There is nobody else on the team to cover this — the only person on the staff list is the one already booked.";
  }
  const counts = { booked: 0, leave: 0, sameJob: 0 };
  for (const r of others) {
    if (r.code === "on_approved_leave") counts.leave += 1;
    else if (r.code === "already_on_this_job") counts.sameJob += 1;
    else counts.booked += 1;
  }
  const parts: string[] = [];
  if (counts.booked > 0) {
    parts.push(`${counts.booked} already on a shift that overlaps it`);
  }
  if (counts.leave > 0) parts.push(`${counts.leave} on approved leave`);
  if (counts.sameJob > 0) parts.push(`${counts.sameJob} already on this job`);
  const reason =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]!}`;
  const slot = `${formatConflictTime(Date.parse(need.startIso))}–${formatConflictTime(Date.parse(need.endIso))} on ${formatConflictDay(need.day)}`;
  return `Nobody is free for ${slot}. Of the ${countPeople(others.length)} who could have taken it, ${reason}. This needs a decision you cannot make from the rota alone — extra hours, a subcontractor, or moving the work.`;
}

// ── The engine ───────────────────────────────────────────────────────────────

/**
 * Compute resolutions for one conflict.
 *
 * Deterministic and pure: identical facts in, identical bytes out. It reads
 * `input.window` for the horizon rather than a clock of its own, so a report
 * rendered twice a second apart cannot disagree with itself.
 */
export function recommendForConflict(
  conflict: ScheduleConflict,
  input: RecommendationInput,
): ScheduleRecommendation | null {
  if (!isRecommendable(conflict.kind)) return null;

  const rota = input.rota ?? [];
  const leave = (input.leave ?? []).filter((l) => l.status === "approved");
  const jobs = input.jobs ?? [];
  const roster = input.roster ?? [];

  const rotaById = new Map(rota.map((r) => [r.id, r]));
  const leaveById = new Map((input.leave ?? []).map((l) => [l.id, l]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  const need = deriveNeed(conflict, { rotaById, leaveById, jobById });
  if (!need) return null;

  const slot: Interval = { start: Date.parse(need.startIso), end: Date.parse(need.endIso) };
  if (!Number.isFinite(slot.start) || !Number.isFinite(slot.end) || slot.end <= slot.start) {
    return null;
  }

  const index = {
    rotaByUser: groupBy(rota, (r) => r.user_id),
    leaveByUser: groupBy(leave, (l) => l.user_id),
    leaveIntervals: new Map<string, Interval>(),
  };
  for (const l of leave) {
    const iv = approvedLeaveInterval(l);
    if (iv) index.leaveIntervals.set(l.id, iv);
  }

  const job = need.jobId ? jobById.get(need.jobId) ?? null : null;
  const namedAssigneeId = job?.assigned_to ?? null;
  const excluded = new Set(need.excludedUserIds);

  // ── covers ────────────────────────────────────────────────────────────────
  const covers: RecommendationCandidate[] = [];
  const ruledOut: RuledOutCandidate[] = [];

  for (const member of roster) {
    if (excluded.has(member.userId)) {
      ruledOut.push({
        userId: member.userId,
        userName: member.name,
        code: "is_the_conflicted_person",
        text: `${member.name} is the person already booked here, so they cannot cover it.`,
        evidence: [...need.replacesShiftIds],
      });
      continue;
    }

    const avail = availabilityFor(member.userId, slot, need.day, need, index);

    if (avail.clashingLeave.length > 0) {
      const l = avail.clashingLeave[0]!;
      ruledOut.push({
        userId: member.userId,
        userName: member.name,
        code: "on_approved_leave",
        text: `${member.name} has approved ${leaveLabel(l)} from ${formatConflictDay(l.starts_at)} to ${formatConflictDay(l.ends_at)}.`,
        evidence: [l.id],
      });
      continue;
    }

    if (avail.alreadyOnJob) {
      ruledOut.push({
        userId: member.userId,
        userName: member.name,
        code: "already_on_this_job",
        text: `${member.name} is already on this job for that window — proposing them would change nothing.`,
        evidence: [avail.alreadyOnJob.id],
      });
      continue;
    }

    if (avail.clashingShifts.length > 0) {
      const s = avail.clashingShifts[0]!;
      const iv = shiftInterval(s);
      ruledOut.push({
        userId: member.userId,
        userName: member.name,
        code: "already_on_a_shift",
        text: iv
          ? `${member.name} is already on a shift ${slotPhrase(iv, ukDayKeyOf(new Date(iv.start).toISOString()))}.`
          : `${member.name} already has a shift overlapping that window.`,
        evidence: [s.id],
      });
      continue;
    }

    // The "knows the job" signal: another shift of theirs on the SAME job,
    // anywhere in the window. It cannot overlap the slot — that path ruled them
    // out above — so it is genuinely a second, separate day on this job.
    const sameJobShift = need.jobId
      ? (index.rotaByUser.get(member.userId) ?? []).find(
          (r) => r.job_id === need.jobId && !need.replacesShiftIds.includes(r.id),
        ) ?? null
      : null;

    covers.push(
      buildCoverCandidate(member, slot, need.day, need, avail, {
        namedAssigneeId,
        sameJobShift,
      }),
    );
  }

  // ── day-moves ─────────────────────────────────────────────────────────────
  const notes: string[] = [];
  const moves = buildDayMoves(need, slot, roster, index, input.window, notes, job);

  const ranked = [
    ...covers.sort(compareCandidates).slice(0, MAX_COVER_CANDIDATES),
    ...moves,
  ].sort(compareCandidates);

  ruledOut.sort((a, b) =>
    a.userName !== b.userName
      ? a.userName < b.userName
        ? -1
        : 1
      : a.userId < b.userId
        ? -1
        : 1,
  );

  const candidateTotal = covers.length + moves.length;

  return {
    conflictKey: conflict.key,
    kind: conflict.kind as RecommendableKind,
    need,
    candidates: ranked,
    candidateTotal,
    ruledOut: ruledOut.slice(0, MAX_RULED_OUT_SHOWN),
    ruledOutTotal: ruledOut.length,
    considered: roster.length,
    impossible:
      candidateTotal === 0 ? explainImpossibility(ruledOut, roster.length, need) : null,
    notes,
  };
}

/**
 * Alternative slots for the SAME person: the same clock times on the nearest
 * later days inside the window on which they hold no shift and no approved
 * leave.
 *
 * TWO DELIBERATE LIMITS, both stated to the user rather than hidden:
 *
 *   • Only for a shift with NO job. Moving a job-bound shift to another day
 *     leaves `jobs.scheduled_date` behind, which manufactures an
 *     `assignment_off_rota` conflict — a recommendation whose only effect is a
 *     different conflict is not a recommendation.
 *   • Only LATER days. Bringing work forward needs notice — materials, access,
 *     a customer who agreed a date — that no record here can confirm.
 */
function buildDayMoves(
  need: CoverageNeed,
  slot: Interval,
  roster: readonly RosterMember[],
  index: {
    rotaByUser: Map<string, RotaShiftRow[]>;
    leaveByUser: Map<string, LeaveRow[]>;
    leaveIntervals: Map<string, Interval>;
  },
  window: ScheduleWindow,
  notes: string[],
  job: ScheduledJobRow | null,
): RecommendationCandidate[] {
  const subjectId = need.excludedUserIds[0];
  if (!subjectId || need.replacesShiftIds.length === 0) return [];

  const subject = roster.find((m) => m.userId === subjectId);
  if (!subject) return [];

  if (need.jobId) {
    notes.push(
      `Moving the shift to another day is not offered: it is tied to a job scheduled for ${formatConflictDay(job?.scheduled_date ?? need.day)}, so the shift and the job's date would then disagree.`,
    );
    return [];
  }

  const out: RecommendationCandidate[] = [];
  const span = slot.end - slot.start;
  const horizon = Math.max(0, daysBetween(need.day, window.toDay));

  for (let offset = 1; offset <= horizon && out.length < MAX_DAY_MOVE_CANDIDATES; offset++) {
    const targetDay = addDays(need.day, offset);
    const targetStart = slot.start + offset * 86_400_000;
    const target: Interval = { start: targetStart, end: targetStart + span };
    const avail = availabilityFor(subjectId, target, targetDay, need, index);
    if (avail.clashingShifts.length > 0 || avail.clashingLeave.length > 0) continue;
    out.push(buildMoveDayCandidate(subject, target, targetDay, need, avail, offset));
  }

  if (out.length === 0) {
    notes.push(
      `No later day inside this fortnight is free for the same person at the same times, so moving the shift is not offered.`,
    );
  }
  return out;
}

/**
 * Approved leave as an instant range, INCLUSIVE of both dates — the same
 * conversion the detector applies, so "on leave" means one thing in both halves
 * of the feature. Kept local rather than shared because it is three lines and
 * duplicating it is cheaper than exporting a private detail of the detector.
 */
function approvedLeaveInterval(row: LeaveRow): Interval | null {
  const start = ukDayStartMs(row.starts_at);
  const end = ukDayEndMs(row.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/**
 * Recommendations for a whole ranked conflict list, keyed by conflict.
 *
 * Conflicts that carry no staffing question — today only `asset_double_booked`
 * — are absent from the map rather than present-and-empty, so a surface cannot
 * mistake "nothing to recommend here" for "we looked and found nobody".
 */
export function recommendForConflicts(
  conflicts: readonly ScheduleConflict[],
  input: RecommendationInput,
): Map<string, ScheduleRecommendation> {
  const out = new Map<string, ScheduleRecommendation>();
  for (const conflict of conflicts) {
    const rec = recommendForConflict(conflict, input);
    if (rec) out.set(conflict.key, rec);
  }
  return out;
}

export interface RecommendationSummary {
  /** Conflicts a resolution was computed for. */
  withRecommendations: number;
  /** Of those, how many had at least one viable candidate. */
  withCandidates: number;
  /** Of those, how many honestly had none. */
  withNobodyFree: number;
}

export function summariseRecommendations(
  recommendations: ReadonlyMap<string, ScheduleRecommendation>,
): RecommendationSummary {
  let withCandidates = 0;
  let withNobodyFree = 0;
  for (const rec of recommendations.values()) {
    if (rec.candidates.length > 0) withCandidates += 1;
    else withNobodyFree += 1;
  }
  return {
    withRecommendations: recommendations.size,
    withCandidates,
    withNobodyFree,
  };
}
