import type { BriefingSeverity } from "@/lib/briefing/types";
import {
  daysBetween,
  intersection,
  overlaps,
  ukDayEndMs,
  ukDayKeyOf,
  ukDayStartMs,
  type Interval,
  type ScheduleWindow,
} from "./window";

/**
 * Deterministic Schedule Integrity — OBSERVE → EXPLAIN → RECOMMEND (PURE).
 *
 * A read-only conflict detector over the org's REAL scheduling facts. It owns no
 * data, performs no I/O, and — by construction — cannot move, reassign or edit
 * anything: it takes already-fetched rows and returns sentences. Every finding
 * carries the row ids that evidence it, the exact clashing times, and a deep link
 * to the surface where a human decides what to do. There is no probability, no
 * model, and no suggestion the product acts on by itself.
 *
 * The split mirrors lib/site-ops/timeline.ts: server/services/schedule-integrity.ts
 * does the org-pinned, windowed, paged reads; every RULE lives here so it is
 * unit-testable without a database and the numbers asserted in tests are the exact
 * numbers an owner sees.
 *
 * ── WHAT THE REAL SCHEMA SUPPORTS ───────────────────────────────────────────
 *
 *   `rota_entries`      user_id + job_id? + starts_at/ends_at timestamptz,
 *                       CHECK (ends_at > starts_at). CANONICAL for "who is
 *                       working when" (20260523000000_job_rota_unification.sql).
 *   `jobs`              assigned_to (a SINGLE nullable "primary assignee" —
 *                       there is no job↔staff join table) + scheduled_date, a
 *                       plain `date` with no time and no end date. A job is
 *                       therefore a WHOLE UK DAY, never an hour range.
 *   `leave_requests`    date range INCLUSIVE of both ends + a real
 *                       'approved' status.
 *   `asset_assignments` assigned_at timestamptz + actual_return_at timestamptz?,
 *                       i.e. a genuine custody interval per asset.
 *
 * A DB trigger auto-creates a default 08:00–17:00 UTC rota entry whenever
 * `jobs.assigned_to` and `jobs.scheduled_date` are both set. That trigger does
 * NOT run the rota form's write-time overlap guard, so assigning one person to
 * two jobs on the same date silently produces two exactly-overlapping shifts —
 * the single most reachable double-booking in the product, and invisible today.
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const SCHEDULE_CONFLICT_KINDS = [
  /** One person, two overlapping shifts. */
  "staff_double_booked",
  /** A shift that runs during that person's APPROVED leave. */
  "leave_clash",
  /** The job names an assignee for a day on which they hold no shift. */
  "assignment_off_rota",
  /** An imminent job with nobody on it at all — no assignee AND no shift. */
  "job_unassigned",
  /** One asset, two overlapping custody windows. */
  "asset_double_booked",
] as const;

export type ScheduleConflictKind = (typeof SCHEDULE_CONFLICT_KINDS)[number];

/**
 * Presentation metadata. `label` is the WORD on the badge — a conflict's class
 * is never communicated by colour alone (WCAG 1.4.1); tone only reinforces it.
 */
export const SCHEDULE_CONFLICT_META: Record<
  ScheduleConflictKind,
  { label: string; tone: string; blurb: string }
> = {
  staff_double_booked: {
    label: "Double-booked",
    tone: "bg-rose-100 text-rose-800",
    blurb: "The same person is on two shifts that run at the same time.",
  },
  leave_clash: {
    label: "On approved leave",
    tone: "bg-amber-100 text-amber-900",
    blurb: "Someone is rostered to work during leave you have already approved.",
  },
  assignment_off_rota: {
    label: "Not on the rota",
    tone: "bg-sky-100 text-sky-800",
    blurb: "The job names an assignee, but they hold no shift on the scheduled day.",
  },
  job_unassigned: {
    label: "Nobody assigned",
    tone: "bg-violet-100 text-violet-800",
    blurb: "A job is coming up with no assignee and no one on the rota for it.",
  },
  asset_double_booked: {
    label: "Plant clash",
    tone: "bg-slate-100 text-slate-700",
    blurb: "One asset shows two custody records covering the same period.",
  },
};

/**
 * Same-score tiebreak order — purely for a readable, reproducible list: people
 * problems before paperwork problems before plant.
 */
const KIND_RANK: Record<ScheduleConflictKind, number> = {
  staff_double_booked: 0,
  leave_clash: 1,
  job_unassigned: 2,
  assignment_off_rota: 3,
  asset_double_booked: 4,
};

export interface ScheduleConflict {
  /** Unique, stable identity: kind + the sorted ids of the rows that evidence it. */
  key: string;
  kind: ScheduleConflictKind;
  severity: BriefingSeverity;
  /** The Europe/London day the clash lands on. */
  day: string;
  /** First instant of the clash, canonical ISO-8601 UTC. */
  at: string;
  /** Whole UK days from the window's first day. 0 = today. */
  daysAway: number;
  /** Imperative headline naming the person / asset / job. */
  title: string;
  /** One plain sentence: who, when, and why it is a conflict. */
  detail: string;
  /** The user or asset the conflict is about, when it has one subject. */
  subjectId: string | null;
  subjectName: string | null;
  /** Every row id that evidences the finding — the audit trail. */
  sourceIds: string[];
  /** Deep link to the surface where a human resolves it. */
  href: string;
  /** Deterministic rank, higher = more urgent. */
  score: number;
}

// ── Input rows (exactly the columns the service selects) ─────────────────────

export interface RotaShiftRow {
  id: string;
  user_id: string;
  job_id: string | null;
  starts_at: string;
  ends_at: string;
}

export interface ScheduledJobRow {
  id: string;
  assigned_to: string | null;
  scheduled_date: string | null;
  status: string | null;
  /** Resolved by the caller from the `customers` join — jobs carry no title. */
  customer_name: string | null;
}

export interface LeaveRow {
  id: string;
  user_id: string;
  type: string | null;
  status: string | null;
  /** `date` columns, INCLUSIVE of both ends. */
  starts_at: string;
  ends_at: string;
}

export interface AssetCustodyRow {
  id: string;
  asset_id: string;
  status: string | null;
  assigned_at: string;
  actual_return_at: string | null;
}

export interface ScheduleConflictInput {
  window: ScheduleWindow;
  rota?: readonly RotaShiftRow[];
  jobs?: readonly ScheduledJobRow[];
  leave?: readonly LeaveRow[];
  custody?: readonly AssetCustodyRow[];
  /** user_id → display name, resolved by the caller from THIS org's memberships. */
  people?: ReadonlyMap<string, string>;
  /** asset_id → display name. */
  assets?: ReadonlyMap<string, string>;
}

/**
 * Job statuses that still represent work to be done. A 'completed' job's
 * staffing is history, and flagging it would be noise no one can act on.
 */
const LIVE_JOB_STATUSES = new Set(["new", "in-progress", "blocked"]);

/** Sentinel end for still-open asset custody. Finite so every value stays serialisable. */
const OPEN_ENDED = Number.MAX_SAFE_INTEGER;

// ── Severity + ranking ───────────────────────────────────────────────────────

/**
 * Band gaps (1000) exceed the maximum secondary bonus (150 proximity + 4 kind),
 * so severity STRICTLY dominates — exactly the invariant lib/briefing/compose.ts
 * states. Proximity only orders items WITHIN a band.
 */
const SEVERITY_BASE: Record<BriefingSeverity, number> = {
  critical: 4000,
  high: 3000,
  medium: 2000,
  low: 1000,
};

/**
 * Honest severity, derived from nothing but how soon it bites.
 *
 * DELIBERATELY CAPPED AT "high". In CrewFlow `critical` means a live safety or
 * legal breach — work proceeding without a RAMS, an expired-but-still-active
 * permit. A double-booking is operationally expensive and costs a day, but it is
 * not a legal exposure, and inflating it would push a genuine breach down the
 * briefing. A clash today is `high`, one next month is `low`; that ordering is
 * the signal, not the word.
 */
export function conflictSeverity(daysAway: number): BriefingSeverity {
  if (daysAway <= 1) return "high";
  if (daysAway <= 7) return "medium";
  return "low";
}

function rankScore(severity: BriefingSeverity, daysAway: number, kind: ScheduleConflictKind): number {
  const proximity = Math.max(0, 150 - Math.max(0, daysAway) * 12);
  return SEVERITY_BASE[severity] + proximity + (4 - KIND_RANK[kind]);
}

/**
 * Total order over findings: most urgent first, then soonest, then by key. The
 * last two make it TOTAL — two conflicts compare equal only if they are the same
 * conflict — so the output is identical for any permutation of the input rows,
 * which matters because the sources arrive from independent queries.
 */
export function compareConflicts(a: ScheduleConflict, b: ScheduleConflict): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return Math.abs(n) === 1 ? singular : pluralForm;
}

/** Parse a timestamptz to epoch ms, or null when absent/unparseable. */
function instant(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** HH:mm in Europe/London. Local, because that is what a site manager reads. */
const UK_HHMM = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function hhmm(ms: number): string {
  return UK_HHMM.format(new Date(ms));
}

/** "Mon 20 Jul" — enough to place a day without a full date. */
const UK_DAY_LABEL = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
});

export function formatConflictDay(dayKey: string): string {
  const ms = ukDayStartMs(dayKey);
  if (!Number.isFinite(ms)) return dayKey;
  // Midday avoids any chance of a boundary instant rendering as the prior day.
  return UK_DAY_LABEL.format(new Date(ms + 43_200_000));
}

function personName(people: ReadonlyMap<string, string> | undefined, userId: string): string {
  const n = people?.get(userId)?.trim();
  return n && n.length > 0 ? n : "A team member";
}

function jobLabel(job: ScheduledJobRow): string {
  const n = job.customer_name?.trim();
  return n && n.length > 0 ? n : "an unnamed job";
}

/** Stable key from a kind plus the evidencing rows, order-independent. */
function conflictKey(kind: ScheduleConflictKind, sourceIds: readonly string[]): string {
  return `${kind}:${[...sourceIds].sort().join("+")}`;
}

/** Shape a finding, deriving day / severity / score from the clash instant. */
function makeConflict(
  win: ScheduleWindow,
  kind: ScheduleConflictKind,
  clash: Interval,
  fields: {
    title: string;
    detail: string;
    subjectId?: string | null;
    subjectName?: string | null;
    sourceIds: string[];
    href: string;
  },
): ScheduleConflict {
  const at = new Date(clash.start).toISOString();
  const day = ukDayKeyOf(at) || at.slice(0, 10);
  const daysAway = daysBetween(win.fromDay, day);
  const severity = conflictSeverity(daysAway);
  return {
    key: conflictKey(kind, fields.sourceIds),
    kind,
    severity,
    day,
    at,
    daysAway,
    title: fields.title,
    detail: fields.detail,
    subjectId: fields.subjectId ?? null,
    subjectName: fields.subjectName ?? null,
    sourceIds: [...fields.sourceIds].sort(),
    href: fields.href,
    score: rankScore(severity, daysAway, kind),
  };
}

/** A rota row as a usable interval, or null when its timestamps don't parse. */
function shiftInterval(row: RotaShiftRow): Interval | null {
  const start = instant(row.starts_at);
  const end = instant(row.ends_at);
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

/**
 * Approved leave as an instant range. `leave_requests` stores INCLUSIVE dates,
 * so 20th–22nd covers three whole UK days and ends at the start of the 23rd.
 */
function leaveInterval(row: LeaveRow): Interval | null {
  const start = ukDayStartMs(row.starts_at);
  const end = ukDayEndMs(row.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

const LEAVE_TYPE_LABELS: Record<string, string> = {
  holiday: "holiday",
  sick: "sick leave",
  emergency: "emergency leave",
  unpaid: "unpaid leave",
};

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

// ── Rule 1 · the same person on two overlapping shifts ───────────────────────

/**
 * A sweep, not a cross-product: shifts are sorted by start, and each is compared
 * only with those that begin before it ends. Cost is proportional to the number
 * of clashes found, so a clean fortnight is effectively linear.
 *
 * This is the flagship class. `jobs.assigned_to` writes a default 08:00–17:00
 * shift through a DB trigger that bypasses the rota form's own overlap guard, so
 * one person assigned to two jobs on one date lands here — and nowhere else in
 * the product today.
 */
function detectDoubleBookings(input: ScheduleConflictInput): ScheduleConflict[] {
  const win = input.window;
  const out: ScheduleConflict[] = [];

  for (const [userId, rows] of groupBy(input.rota ?? [], (r) => r.user_id)) {
    const shifts = rows
      .map((row) => ({ row, iv: shiftInterval(row) }))
      .filter((s): s is { row: RotaShiftRow; iv: Interval } => s.iv !== null)
      .sort((a, b) => a.iv.start - b.iv.start || (a.row.id < b.row.id ? -1 : 1));

    for (let i = 0; i < shifts.length; i++) {
      const a = shifts[i]!;
      for (let j = i + 1; j < shifts.length && shifts[j]!.iv.start < a.iv.end; j++) {
        const b = shifts[j]!;
        if (!overlaps(a.iv, b.iv)) continue; // touching endpoints: a handover
        const clash = intersection(a.iv, b.iv);
        // The 48h read pad can surface a pair that clashes entirely BEFORE the
        // window; only report what falls inside the horizon we claim to cover.
        const inWindow = clash ? intersection(clash, win.interval) : null;
        if (!inWindow) continue;

        const name = personName(input.people, userId);
        const day = ukDayKeyOf(new Date(inWindow.start).toISOString());
        out.push(
          makeConflict(win, "staff_double_booked", inWindow, {
            title: `${name} is double-booked on ${formatConflictDay(day)}`,
            detail:
              `${name} has two shifts that overlap on ${formatConflictDay(day)} — ` +
              `${hhmm(a.iv.start)}–${hhmm(a.iv.end)} and ${hhmm(b.iv.start)}–${hhmm(b.iv.end)}. ` +
              `They can only be in one place; move or shorten one of them.`,
            subjectId: userId,
            subjectName: name,
            sourceIds: [a.row.id, b.row.id],
            href: `/staff/rota?week=${day}`,
          }),
        );
      }
    }
  }
  return out;
}

// ── Rule 2 · rostered during approved leave ──────────────────────────────────

/**
 * Only `status = 'approved'` counts. A pending request is not yet a commitment,
 * and rejected/cancelled leave is not leave at all — flagging either would train
 * owners to ignore the signal. The rule runs against `rota_entries` because that
 * table is the canonical record of who is working when; a job assignment reaches
 * it through the sync trigger, so nothing is missed by not re-checking `jobs`.
 */
function detectLeaveClashes(input: ScheduleConflictInput): ScheduleConflict[] {
  const win = input.window;
  const out: ScheduleConflict[] = [];
  const rotaByUser = groupBy(input.rota ?? [], (r) => r.user_id);

  for (const leave of input.leave ?? []) {
    if (leave.status !== "approved") continue;
    const leaveIv = leaveInterval(leave);
    if (!leaveIv) continue;

    for (const row of rotaByUser.get(leave.user_id) ?? []) {
      const shift = shiftInterval(row);
      if (!shift || !overlaps(shift, leaveIv)) continue;
      const clash = intersection(shift, leaveIv);
      const inWindow = clash ? intersection(clash, win.interval) : null;
      if (!inWindow) continue;

      const name = personName(input.people, leave.user_id);
      const day = ukDayKeyOf(new Date(inWindow.start).toISOString());
      const kindLabel = LEAVE_TYPE_LABELS[leave.type ?? ""] ?? "leave";
      out.push(
        makeConflict(win, "leave_clash", inWindow, {
          title: `${name} is on the rota during approved ${kindLabel}`,
          detail:
            `${name} has approved ${kindLabel} from ${formatConflictDay(leave.starts_at)} to ` +
            `${formatConflictDay(leave.ends_at)}, but is rostered ${hhmm(shift.start)}–${hhmm(shift.end)} ` +
            `on ${formatConflictDay(day)}. Cover the shift or revisit the leave.`,
          subjectId: leave.user_id,
          subjectName: name,
          sourceIds: [row.id, leave.id],
          href: `/staff/rota?week=${day}`,
        }),
      );
    }
  }
  return out;
}

// ── Rules 3 & 4 · job assignment vs the rota ─────────────────────────────────

/**
 * Two findings from one pass over the window's jobs.
 *
 * `assignment_off_rota` — the job names an assignee for a scheduled day on which
 * that person holds NO shift. The sync trigger guarantees a shift exists the
 * moment `assigned_to` + `scheduled_date` are both set, so its ABSENCE means the
 * shift was later deleted or moved: the job record and the rota now disagree, and
 * only one of them is what will actually happen. Deliberately narrow — it asks
 * whether the assignee is working AT ALL that day, not whether they are working
 * on THIS job, because a crew legitimately covers several jobs in a day and
 * `jobs.assigned_to` is only ever the "primary" pointer.
 *
 * `job_unassigned` — nobody at all: no `assigned_to` AND no rota entry pointing
 * at the job. Strictly stronger than the dashboard's existing
 * `jobs_unassigned_tomorrow` signal, which looks only at `assigned_to` and so
 * counts a job whose crew was rostered directly.
 */
function detectJobAssignmentGaps(input: ScheduleConflictInput): ScheduleConflict[] {
  const win = input.window;
  const out: ScheduleConflict[] = [];

  // Day coverage per person, and per job — both consulted with the SAME overlap
  // test, so "is anyone actually working on this?" means one thing everywhere.
  const shiftsByUser = groupBy(input.rota ?? [], (r) => r.user_id);
  const shiftsByJob = groupBy(
    (input.rota ?? []).filter((r) => typeof r.job_id === "string" && r.job_id.length > 0),
    (r) => r.job_id as string,
  );

  for (const job of input.jobs ?? []) {
    const day = job.scheduled_date;
    if (!day) continue;
    if (!LIVE_JOB_STATUSES.has(String(job.status ?? ""))) continue;
    const dayIv: Interval = { start: ukDayStartMs(day), end: ukDayEndMs(day) };
    if (!Number.isFinite(dayIv.start) || !Number.isFinite(dayIv.end)) continue;
    if (!intersection(dayIv, win.interval)) continue;

    if (job.assigned_to) {
      const worksThatDay = (shiftsByUser.get(job.assigned_to) ?? []).some((row) => {
        const iv = shiftInterval(row);
        return iv != null && overlaps(iv, dayIv);
      });
      if (worksThatDay) continue;
      const name = personName(input.people, job.assigned_to);
      out.push(
        makeConflict(win, "assignment_off_rota", dayIv, {
          title: `${name} is down for ${jobLabel(job)} but has no shift that day`,
          detail:
            `${jobLabel(job)} is scheduled for ${formatConflictDay(day)} with ${name} as the assignee, ` +
            `but ${name} has no shift on the rota that day. Either the shift was removed or the job ` +
            `needs a different name against it.`,
          subjectId: job.assigned_to,
          subjectName: name,
          sourceIds: [job.id],
          href: `/jobs/${job.id}`,
        }),
      );
      continue;
    }

    const anyoneRostered = (shiftsByJob.get(job.id) ?? []).some((row) => {
      const iv = shiftInterval(row);
      return iv != null && overlaps(iv, dayIv);
    });
    if (anyoneRostered) continue; // somebody IS on it, just not via `assigned_to`
    out.push(
      makeConflict(win, "job_unassigned", dayIv, {
        title: `${jobLabel(job)} on ${formatConflictDay(day)} has nobody on it`,
        detail:
          `${jobLabel(job)} is scheduled for ${formatConflictDay(day)} with no assignee and nobody ` +
          `on the rota for it. Assign someone before the day arrives.`,
        subjectId: null,
        subjectName: null,
        sourceIds: [job.id],
        href: `/jobs/${job.id}`,
      }),
    );
  }
  return out;
}

// ── Rule 5 · one asset, two custody windows ──────────────────────────────────

/**
 * Plant clashes, with an honest caveat stated up front: `asset_assignments`
 * carries a PARTIAL UNIQUE INDEX `(asset_id) WHERE status = 'open'`, so two
 * simultaneously-open custody records are impossible at the database. The
 * product's own actions never backdate either timestamp (`assigned_at` defaults
 * to `now()`, `actual_return_at` is set to `now()` on return, and the transfer
 * RPC closes and reopens inside one transaction, so the two records TOUCH rather
 * than overlap). What this rule can therefore still catch is an overlap created
 * OUTSIDE those actions — an import, a backfill, or direct SQL — which is a real
 * data-integrity fault worth surfacing but is expected to fire rarely.
 *
 * `cancelled` custody never happened, so it is excluded. A `closed` record with
 * no `actual_return_at` has an UNKNOWN end and is also excluded: asserting an
 * overlap against an unknown boundary would be inventing a fact.
 */
function detectAssetClashes(input: ScheduleConflictInput): ScheduleConflict[] {
  const win = input.window;
  const out: ScheduleConflict[] = [];

  const usable = (input.custody ?? []).filter((r) => r.status !== "cancelled");

  for (const [assetId, rows] of groupBy(usable, (r) => r.asset_id)) {
    const spans = rows
      .map((row) => {
        const start = instant(row.assigned_at);
        if (start == null) return null;
        const returned = instant(row.actual_return_at);
        if (row.status === "open") return { row, iv: { start, end: OPEN_ENDED } };
        if (returned == null) return null; // closed with an unknown end — cannot assert
        return returned > start ? { row, iv: { start, end: returned } } : null;
      })
      .filter((s): s is { row: AssetCustodyRow; iv: Interval } => s !== null)
      .sort((a, b) => a.iv.start - b.iv.start || (a.row.id < b.row.id ? -1 : 1));

    for (let i = 0; i < spans.length; i++) {
      const a = spans[i]!;
      for (let j = i + 1; j < spans.length && spans[j]!.iv.start < a.iv.end; j++) {
        const b = spans[j]!;
        if (!overlaps(a.iv, b.iv)) continue;
        const clash = intersection(a.iv, b.iv);
        const inWindow = clash ? intersection(clash, win.interval) : null;
        if (!inWindow) continue;

        const name = input.assets?.get(assetId)?.trim() || "An asset";
        const day = ukDayKeyOf(new Date(inWindow.start).toISOString());
        out.push(
          makeConflict(win, "asset_double_booked", inWindow, {
            title: `${name} has two custody records covering ${formatConflictDay(day)}`,
            detail:
              `${name} shows two overlapping custody records around ${formatConflictDay(day)}. ` +
              `Only one can be true — check the check-out and return history and close the stale one.`,
            subjectId: assetId,
            subjectName: name,
            sourceIds: [a.row.id, b.row.id],
            href: `/assets/${assetId}`,
          }),
        );
      }
    }
  }
  return out;
}

// ── The detector ─────────────────────────────────────────────────────────────

/**
 * Run every rule and return one ranked, de-duplicated list.
 *
 * Pure: no clock of its own (`input.window` carries the pinned instant), no I/O,
 * no mutation of the inputs. Dedupe is by `key`, which is derived from the kind
 * plus the sorted evidencing row ids, so the same underlying clash reached by two
 * routes is reported once.
 */
export function detectScheduleConflicts(input: ScheduleConflictInput): ScheduleConflict[] {
  const all = [
    ...detectDoubleBookings(input),
    ...detectLeaveClashes(input),
    ...detectJobAssignmentGaps(input),
    ...detectAssetClashes(input),
  ];

  const byKey = new Map<string, ScheduleConflict>();
  for (const c of all) if (!byKey.has(c.key)) byKey.set(c.key, c);

  return [...byKey.values()].sort(compareConflicts);
}

// ── Aggregation for the briefing ─────────────────────────────────────────────

export interface ScheduleKindRollup {
  count: number;
  /** Days until the SOONEST conflict of this kind. 0 = today. Null when none. */
  soonestDays: number | null;
}

export interface ScheduleIntegritySummary {
  total: number;
  byKind: Record<ScheduleConflictKind, ScheduleKindRollup>;
  /** The highest severity present, or null when the schedule is clean. */
  worstSeverity: BriefingSeverity | null;
}

const EMPTY_ROLLUP: ScheduleKindRollup = { count: 0, soonestDays: null };

/**
 * Roll a ranked conflict list up to per-kind counts. The briefing shows ONE
 * aggregate line per class — never a row per clash — so a bad week reads as
 * "3 people are double-booked", not as thirty lines an owner scrolls past.
 */
export function summariseScheduleConflicts(
  conflicts: readonly ScheduleConflict[],
): ScheduleIntegritySummary {
  const byKind = Object.fromEntries(
    SCHEDULE_CONFLICT_KINDS.map((k) => [k, { ...EMPTY_ROLLUP }]),
  ) as Record<ScheduleConflictKind, ScheduleKindRollup>;

  let worst: BriefingSeverity | null = null;
  for (const c of conflicts) {
    const bucket = byKind[c.kind];
    bucket.count += 1;
    bucket.soonestDays =
      bucket.soonestDays == null ? c.daysAway : Math.min(bucket.soonestDays, c.daysAway);
    if (worst == null || SEVERITY_BASE[c.severity] > SEVERITY_BASE[worst]) worst = c.severity;
  }

  return { total: conflicts.length, byKind, worstSeverity: worst };
}

/**
 * Roll up ONE class, optionally ignoring anything closer than `fromDaysAway`.
 *
 * The offset exists for exactly one reason: the dashboard already carries
 * `jobs_unassigned_tomorrow`, so the briefing's schedule line must start at day
 * 2 or the same job is counted twice under two different headlines. Keeping the
 * cut here (pure, tested) rather than in the service is what makes that
 * disjointness assertable.
 */
export function rollupKind(
  conflicts: readonly ScheduleConflict[],
  kind: ScheduleConflictKind,
  options: { fromDaysAway?: number } = {},
): ScheduleKindRollup {
  const floor = options.fromDaysAway ?? Number.NEGATIVE_INFINITY;
  let count = 0;
  let soonest: number | null = null;
  for (const c of conflicts) {
    if (c.kind !== kind || c.daysAway < floor) continue;
    count += 1;
    soonest = soonest == null ? c.daysAway : Math.min(soonest, c.daysAway);
  }
  return { count, soonestDays: soonest };
}

/**
 * Bucket an ALREADY-ORDERED list by UK day for the page, preserving rank order
 * within each day. Days come back in the order they are first encountered, which
 * for a ranked list means most-urgent-day first.
 */
export function groupConflictsByDay(
  conflicts: readonly ScheduleConflict[],
): Array<{ day: string; conflicts: ScheduleConflict[] }> {
  const out: Array<{ day: string; conflicts: ScheduleConflict[] }> = [];
  const index = new Map<string, number>();
  for (const c of conflicts) {
    const at = index.get(c.day);
    if (at != null) out[at]!.conflicts.push(c);
    else {
      index.set(c.day, out.length);
      out.push({ day: c.day, conflicts: [c] });
    }
  }
  return out;
}

/** "3 people", "1 job" — used by both the page header and the briefing detail. */
export function countPhrase(n: number, noun: string): string {
  return `${n} ${plural(n, noun)}`;
}
