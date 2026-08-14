import { addDays, ukDayStartMs } from "@/lib/schedule/window";
import { labelled, type LabelledMetric } from "./provenance";

/**
 * FORWARD LABOUR CAPACITY — booked labour vs available capacity, week by week.
 * PURE.
 *
 * ── FORWARD, WHERE utilisation.ts IS TRAILING ───────────────────────────────
 * lib/intelligence/utilisation.ts measures the PAST 30 days (rostered vs
 * clocked). This module looks FORWARD: over the next N weeks, how many hours are
 * already rostered, and how does that sit against the team's capacity? Both
 * sides are recorded facts of `rota_entries` and `memberships` — nothing here
 * clocks a future or predicts attendance.
 *
 * ── THE CAPACITY ASSUMPTION IS STATED, NOT HIDDEN ───────────────────────────
 * CrewFlow stores no contracted / standard weekly hours per member (verified:
 * `users` carries `hourly_pay`, not a working pattern). Capacity is therefore
 * `activeMembers × STANDARD_WEEKLY_HOURS`, a STATED assumption printed verbatim
 * in the basis — the decision-as-config seam (lib/health DEFAULT_HEALTH_THRESHOLDS
 * precedent), so an operator whose week isn't 40 hours can see exactly what to
 * change. This is why the figure is a HEURISTIC: the rostered hours are a fact,
 * the utilisation against an assumed week is a judgement. The rostered hours are
 * ALWAYS shown; only the utilisation rate rests on the assumption.
 *
 * ── WHAT IT DELIBERATELY DOESN'T CLAIM ──────────────────────────────────────
 * `availableHours` (capacity − rostered) is UNBOOKED capacity, not idle time — a
 * member can work unrostered (call-outs) exactly as utilisation.ts warns. A
 * NEGATIVE available figure is `overbooked`: more hours are rostered than the
 * assumed week holds, a real scheduling signal, surfaced not hidden.
 *
 * ── HONESTY ─────────────────────────────────────────────────────────────────
 * With no active members there is nothing to forecast → `sufficient: false`.
 * Zero rostered hours against real members is a VALID answer (full capacity
 * available), not insufficiency.
 *
 * PURE: no I/O, no clock. `todayKey` is the injected London day; week windows
 * are London-pinned instants (lib/schedule/window.ukDayStartMs), and a shift is
 * apportioned into weeks by exact ms overlap — so a shift spanning midnight or a
 * week boundary is split, never double-counted.
 */

/**
 * Assumed standard working week (hours) per active member. A STATED assumption,
 * not a stored fact — printed in the metric basis. The config seam: change it
 * here and every capacity figure and utilisation rate moves together.
 */
export const STANDARD_WEEKLY_HOURS = 40;

const MAX_HORIZON_WEEKS = 52;
const MS_PER_HOUR = 3_600_000;

export type LabourMember = { userId: string; name: string | null };

/** A future shift as instant bounds (rota_entries starts_at/ends_at → ms). */
export type LabourShift = { userId: string; startMs: number; endMs: number };

export type LabourWeek = {
  index: number;
  startDay: string;
  endDay: string;
  rosteredHours: number;
  capacityHours: number;
  /** capacity − rostered; negative means overbooked. */
  availableHours: number;
  /** rostered / capacity as a whole %, or null when capacity is 0. */
  utilisationPct: number | null;
  overbooked: boolean;
  membersRostered: number;
};

export type LabourMemberForecast = {
  userId: string;
  name: string | null;
  rosteredHours: number;
  /** Rostered hours per week, aligned to `weeks` by index. */
  weeklyHours: number[];
};

export type LabourForecast = {
  /** false → no active members, nothing to forecast. */
  sufficient: boolean;
  todayKey: string;
  horizonWeeks: number;
  standardWeeklyHours: number;
  activeMemberCount: number;
  weeks: LabourWeek[];
  members: LabourMemberForecast[];
  totalRosteredHours: number;
  totalCapacityHours: number;
  /** Highest weekly utilisation reached, or null when capacity is 0. */
  peakUtilisationPct: number | null;
  anyOverbooked: boolean;
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Exact ms overlap of [aStart,aEnd) with [bStart,bEnd), floored at 0. */
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

export function computeLabourForecast(input: {
  members: readonly LabourMember[];
  shifts: readonly LabourShift[];
  todayKey: string;
  horizonWeeks: number;
  standardWeeklyHours?: number;
}): LabourForecast {
  const horizonWeeks = Math.min(MAX_HORIZON_WEEKS, Math.max(1, Math.trunc(input.horizonWeeks)));
  const standardWeeklyHours =
    input.standardWeeklyHours != null && input.standardWeeklyHours > 0
      ? input.standardWeeklyHours
      : STANDARD_WEEKLY_HOURS;
  const todayKey = input.todayKey;

  const memberIds = [...new Set(input.members.map((m) => m.userId))];
  const activeMemberCount = memberIds.length;
  const nameById = new Map(input.members.map((m) => [m.userId, m.name] as const));
  const capacityPerWeek = activeMemberCount * standardWeeklyHours;

  // London-pinned instant bounds for each week [start, end).
  const weekBounds: Array<{ startDay: string; endDay: string; startMs: number; endMs: number }> = [];
  for (let i = 0; i < horizonWeeks; i++) {
    const startDay = addDays(todayKey, i * 7);
    const nextStartDay = addDays(todayKey, (i + 1) * 7);
    weekBounds.push({
      startDay,
      endDay: addDays(startDay, 6),
      startMs: ukDayStartMs(startDay),
      endMs: ukDayStartMs(nextStartDay),
    });
  }

  // Per-member per-week rostered hours, apportioned by exact overlap.
  const memberWeekly = new Map<string, number[]>();
  for (const id of memberIds) memberWeekly.set(id, new Array(horizonWeeks).fill(0));
  const weekMembers: Array<Set<string>> = weekBounds.map(() => new Set<string>());

  for (const shift of input.shifts) {
    if (!memberWeekly.has(shift.userId)) continue; // only known active members
    if (!(shift.endMs > shift.startMs)) continue;
    const perWeek = memberWeekly.get(shift.userId)!;
    for (let i = 0; i < weekBounds.length; i++) {
      const b = weekBounds[i]!;
      const ms = overlap(shift.startMs, shift.endMs, b.startMs, b.endMs);
      if (ms <= 0) continue;
      perWeek[i] = perWeek[i]! + ms / MS_PER_HOUR;
      weekMembers[i]!.add(shift.userId);
    }
  }

  const weeks: LabourWeek[] = weekBounds.map((b, i) => {
    let rostered = 0;
    for (const perWeek of memberWeekly.values()) rostered += perWeek[i]!;
    rostered = round1(rostered);
    const capacity = round1(capacityPerWeek);
    const available = round1(capacity - rostered);
    return {
      index: i,
      startDay: b.startDay,
      endDay: b.endDay,
      rosteredHours: rostered,
      capacityHours: capacity,
      availableHours: available,
      utilisationPct: capacity > 0 ? Math.round((rostered / capacity) * 100) : null,
      overbooked: rostered > capacity,
      membersRostered: weekMembers[i]!.size,
    };
  });

  const members: LabourMemberForecast[] = memberIds
    .map((id) => {
      const weekly = memberWeekly.get(id)!.map(round1);
      return {
        userId: id,
        name: nameById.get(id) ?? null,
        rosteredHours: round1(weekly.reduce((s, h) => s + h, 0)),
        weeklyHours: weekly,
      };
    })
    .sort(
      (a, b) =>
        b.rosteredHours - a.rosteredHours ||
        (a.name ?? "").localeCompare(b.name ?? "") ||
        a.userId.localeCompare(b.userId),
    );

  const totalRosteredHours = round1(weeks.reduce((s, w) => s + w.rosteredHours, 0));
  const totalCapacityHours = round1(weeks.reduce((s, w) => s + w.capacityHours, 0));
  const pcts = weeks.map((w) => w.utilisationPct).filter((p): p is number => p != null);
  const peakUtilisationPct = pcts.length > 0 ? Math.max(...pcts) : null;

  return {
    sufficient: activeMemberCount > 0,
    todayKey,
    horizonWeeks,
    standardWeeklyHours,
    activeMemberCount,
    weeks,
    members,
    totalRosteredHours,
    totalCapacityHours,
    peakUtilisationPct,
    anyOverbooked: weeks.some((w) => w.overbooked),
  };
}

// ---------------------------------------------------------------------------
// Labelled metric
// ---------------------------------------------------------------------------

/**
 * HEURISTIC: rostered hours are a fact, but utilisation and available capacity
 * rest on the STATED standard-week assumption, so the whole view is a heuristic
 * that prints its assumption.
 */
export function labourForecastMetric(f: LabourForecast): LabelledMetric<LabourForecast> {
  return labelled(f, {
    kind: "heuristic",
    basis:
      `Forward labour over the next ${f.horizonWeeks} weeks. Rostered hours are summed exactly ` +
      "from the rota (a shift spanning a week boundary is split, never double-counted). Capacity " +
      `assumes a ${f.standardWeeklyHours}-hour week for each of your ${f.activeMemberCount} team ` +
      "member(s) — CrewFlow stores no working pattern, so this assumption is stated, not measured; " +
      "change it if your week differs. Available hours are unbooked capacity, not idle time (people " +
      "can work unrostered); a negative figure means more is rostered than the assumed week holds.",
    computedFrom: [
      { label: "Rota", href: "/rota" },
      { label: "Team", href: "/team" },
    ],
  });
}
