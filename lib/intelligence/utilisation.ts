import { round2 } from "@/lib/money";
import { hoursByUser, overlapMs, type TimeEntry } from "@/lib/time/compute";
import { labelled, type LabelledMetric, type SignalProvenance } from "./provenance";
import type { InstantDayWindow } from "./window";

/**
 * STAFF UTILISATION — rostered hours vs recorded hours vs jobs touched, per
 * member and org-wide, over a trailing Europe/London window. PURE.
 *
 * KIND: DERIVED. Every figure is exact arithmetic over two ledgers that
 * already exist — `rota_entries` (shifts an admin assigned: `starts_at`/
 * `ends_at` timestamptz, CHECK ends_at > starts_at) and `time_entries` (the
 * clock-in spine: `started_at`/`ended_at` + inline `breaks` jsonb). Nothing
 * here predicts anything; "utilisation" means the measured relationship
 * between what was planned and what was clocked, stated with its window.
 *
 * ── COMPOSITION, NOT RE-DERIVATION ──────────────────────────────────────────
 * Recorded hours come from `hoursByUser` (lib/time/compute) — the SAME
 * window-clipping, break-apportioning arithmetic payroll and the timesheet
 * already use. A second "hours worked" formula here would be two answers to
 * one question, so there isn't one. Rostered hours reuse `overlapMs` from the
 * same module (a rota entry is an interval like any other); the only new
 * arithmetic in this file is a division, and it is floored (below).
 *
 * ── THE COVERAGE RATIO'S SAMPLE FLOOR ───────────────────────────────────────
 * A percentage is only printed when at least MIN_RATED_ROSTERED_HOURS were
 * rostered in the window. "200 % coverage" off a single one-hour shift is the
 * volatility problem MIN_RATED_SAMPLE (lib/suppliers/performance) exists for,
 * transposed from counts to hours: below one full working day of roster the
 * ratio is the noise of one shift. The hours themselves are ALWAYS shown —
 * the floor withholds the rate, never the record.
 *
 * ── THE LABOUR-COST LENS ────────────────────────────────────────────────────
 * `users.hourly_pay` exists (20260521), so recorded hours convert to a labour
 * cost — but ONLY for members who have a rate. A member without one
 * contributes NOTHING and is COUNTED in `membersWithoutRate`, never defaulted
 * to £0/h (which would silently understate the org figure — the same refusal
 * as labourCostsFromTimeEntries' "owners get warned" note, made visible).
 *
 * ── WHAT THIS DELIBERATELY DOES NOT SAY ─────────────────────────────────────
 * Low coverage is NOT laziness and the module never says otherwise: a shift
 * can be rostered and worked without the member clocking in, and time can be
 * worked that was never rostered (call-outs). The surface prints both sides
 * and the gap; judging the gap is the operator's job.
 *
 * Dates: window boundaries are London-pinned instants supplied by
 * lib/intelligence/window.ts. No date helper is defined here.
 */

// ---------------------------------------------------------------------------
// Sample floor
// ---------------------------------------------------------------------------

/**
 * Minimum rostered hours in the window before a coverage PERCENTAGE is shown.
 * One full working day: below it, one short shift moves the rate by tens of
 * points and the figure misleads more than it informs.
 */
export const MIN_RATED_ROSTERED_HOURS = 8;

/** Hours against hours, with the rate withheld until the sample earns it. */
export type HoursRatio = {
  recorded: number;
  rostered: number;
  /** recorded / rostered as a whole %, or null below the floor. */
  pct: number | null;
  rated: boolean;
};

export function hoursRatio(recorded: number, rostered: number): HoursRatio {
  const rated = rostered >= MIN_RATED_ROSTERED_HOURS;
  return {
    recorded: round2(recorded),
    rostered: round2(rostered),
    pct: rated && rostered > 0 ? Math.round((recorded / rostered) * 100) : null,
    rated,
  };
}

// ---------------------------------------------------------------------------
// Row shapes (exactly as the read layer selects them)
// ---------------------------------------------------------------------------

export type UtilisationMember = {
  userId: string;
  name: string | null;
  /** `users.hourly_pay`. Null = no rate on file (disclosed, never defaulted). */
  hourlyPay: number | null;
};

/** A `rota_entries` row. Both timestamps are timestamptz strings. */
export type UtilisationRotaRow = {
  user_id: string;
  job_id: string | null;
  starts_at: string;
  ends_at: string;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type MemberUtilisation = {
  userId: string;
  name: string | null;
  /** Rota hours falling inside the window (shifts clipped at the edges). */
  rosteredHours: number;
  /** Clocked hours inside the window, breaks deducted (hoursByUser). */
  recordedHours: number;
  coverage: HoursRatio;
  /** Distinct jobs this member was rostered onto in the window. */
  jobsRostered: number;
  /** Distinct jobs this member clocked time against in the window. */
  jobsWorked: number;
  /** recordedHours × hourly rate, or null when no rate is on file. */
  labourCost: number | null;
};

export type OrgUtilisation = {
  window: { fromDay: string; toDay: string };
  members: MemberUtilisation[];
  totals: {
    rosteredHours: number;
    recordedHours: number;
    coverage: HoursRatio;
    membersWithRoster: number;
    membersWithTime: number;
    /** Σ labourCost over members WITH a rate. */
    labourCost: number;
    /** Members with recorded time but NO hourly rate — excluded from the £. */
    membersWithoutRate: number;
  };
};

/**
 * Compute per-member and org utilisation for one London-pinned window.
 *
 * `nowMs` is injected (never a clock read) so open time entries count up to a
 * reproducible instant and every output is testable — the cash-out/`series`
 * discipline.
 */
export function computeUtilisation(input: {
  members: UtilisationMember[];
  rota: UtilisationRotaRow[];
  timeEntries: TimeEntry[];
  window: InstantDayWindow;
  nowMs: number;
}): OrgUtilisation {
  const from = new Date(input.window.startMs);
  const to = new Date(input.window.endMs);
  const now = new Date(input.nowMs);

  // Recorded hours: THE existing authority, unchanged.
  const recordedByUser = hoursByUser(input.timeEntries, from, to, now);

  // Rostered hours: rota intervals clipped to the window via overlapMs (a
  // rota row is mapped onto the entry shape the helper takes; `ends_at` is
  // NOT NULL by CHECK, so nothing here ever counts "up to now").
  const rosteredByUser = new Map<string, number>();
  const jobsRosteredByUser = new Map<string, Set<string>>();
  for (const r of input.rota) {
    const ms = overlapMs({ started_at: r.starts_at, ended_at: r.ends_at }, from, to, now);
    if (ms <= 0) continue;
    rosteredByUser.set(r.user_id, (rosteredByUser.get(r.user_id) ?? 0) + ms);
    if (r.job_id) {
      const set = jobsRosteredByUser.get(r.user_id) ?? new Set<string>();
      set.add(r.job_id);
      jobsRosteredByUser.set(r.user_id, set);
    }
  }

  const jobsWorkedByUser = new Map<string, Set<string>>();
  for (const e of input.timeEntries) {
    if (!e.job_id) continue;
    if (overlapMs(e, from, to, now) <= 0) continue;
    const set = jobsWorkedByUser.get(e.user_id) ?? new Set<string>();
    set.add(e.job_id);
    jobsWorkedByUser.set(e.user_id, set);
  }

  const members: MemberUtilisation[] = input.members.map((m) => {
    const rostered = round2((rosteredByUser.get(m.userId) ?? 0) / 3_600_000);
    const recorded = round2(recordedByUser.get(m.userId) ?? 0);
    const rate = m.hourlyPay != null && Number.isFinite(m.hourlyPay) && m.hourlyPay > 0 ? m.hourlyPay : null;
    return {
      userId: m.userId,
      name: m.name,
      rosteredHours: rostered,
      recordedHours: recorded,
      coverage: hoursRatio(recorded, rostered),
      jobsRostered: jobsRosteredByUser.get(m.userId)?.size ?? 0,
      jobsWorked: jobsWorkedByUser.get(m.userId)?.size ?? 0,
      labourCost: rate == null ? null : round2(recorded * rate),
    };
  });

  // Deterministic total order: most recorded first, then most rostered, then
  // name, then the unique id — so the listing never reshuffles between loads.
  members.sort(
    (a, b) =>
      b.recordedHours - a.recordedHours ||
      b.rosteredHours - a.rosteredHours ||
      (a.name ?? "").localeCompare(b.name ?? "") ||
      a.userId.localeCompare(b.userId),
  );

  const rosteredTotal = round2(members.reduce((s, m) => s + m.rosteredHours, 0));
  const recordedTotal = round2(members.reduce((s, m) => s + m.recordedHours, 0));
  const withCost = members.filter((m) => m.labourCost != null);

  return {
    window: { fromDay: input.window.fromDay, toDay: input.window.toDay },
    members,
    totals: {
      rosteredHours: rosteredTotal,
      recordedHours: recordedTotal,
      coverage: hoursRatio(recordedTotal, rosteredTotal),
      membersWithRoster: members.filter((m) => m.rosteredHours > 0).length,
      membersWithTime: members.filter((m) => m.recordedHours > 0).length,
      labourCost: round2(withCost.reduce((s, m) => s + (m.labourCost ?? 0), 0)),
      membersWithoutRate: members.filter((m) => m.recordedHours > 0 && m.labourCost == null)
        .length,
    },
  };
}

/** The headline card, labelled. DERIVED — arithmetic over two ledgers, exact. */
export function utilisationMetric(u: OrgUtilisation): LabelledMetric<OrgUtilisation> {
  const provenance: SignalProvenance = {
    kind: "derived",
    basis:
      "Rostered hours are assigned shifts (rota) clipped to the window; recorded hours are " +
      "clock-ins minus breaks over the same window, computed by the same arithmetic as the " +
      "timesheet. A coverage percentage is only shown for members with at least " +
      `${MIN_RATED_ROSTERED_HOURS} rostered hours — below that one short shift swings the rate ` +
      "too far to mean anything. Labour cost covers only members with an hourly rate on file; " +
      "members without one are counted, not priced at £0.",
    window: u.window,
    computedFrom: [
      { label: "Rota", href: "/staff/rota" },
      { label: "Time entries", href: "/staff" },
    ],
    sampleFloorApplied: !u.totals.coverage.rated,
  };
  return labelled(u, provenance);
}
