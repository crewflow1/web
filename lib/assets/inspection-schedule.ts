import { z } from "zod";

/**
 * Asset Management — Milestone 4b: inspection schedule domain (pure).
 *
 * Standing rules that generate due inspections. This module owns the cadence
 * maths, cycle keys and validation; the DB (20260930) owns the idempotency
 * invariant ((schedule_id, cycle_key) unique) and same-org integrity; the
 * generator service owns claim + CAS advancement. Date-only arithmetic on ISO
 * `YYYY-MM-DD` strings — no clocks in here (callers pass "today"), no DST traps.
 */

// ── Cadence presets (UK site conventions; 6-weekly = O-licence PMI cycles) ────
export const SCHEDULE_CADENCES = [
  "one_off",
  "daily",
  "weekly",
  "six_weekly",
  "monthly",
  "quarterly",
  "six_monthly",
  "annual",
  "custom_days",
] as const;
export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number];

export const SCHEDULE_CADENCE_LABELS: Record<ScheduleCadence, string> = {
  one_off: "One-off",
  daily: "Daily (before first use)",
  weekly: "Every 7 days",
  six_weekly: "Every 6 weeks",
  monthly: "Monthly",
  quarterly: "Every 3 months",
  six_monthly: "Every 6 months",
  annual: "Every 12 months",
  custom_days: "Custom interval (days)",
};

export type Interval = { interval_days: number | null; interval_months: number | null };

/** Map a cadence preset (+ custom days) to the stored interval columns. */
export function cadenceToInterval(cadence: ScheduleCadence, customDays?: number): Interval {
  switch (cadence) {
    case "one_off":
      return { interval_days: null, interval_months: null };
    case "daily":
      return { interval_days: 1, interval_months: null };
    case "weekly":
      return { interval_days: 7, interval_months: null };
    case "six_weekly":
      return { interval_days: 42, interval_months: null };
    case "monthly":
      return { interval_days: null, interval_months: 1 };
    case "quarterly":
      return { interval_days: null, interval_months: 3 };
    case "six_monthly":
      return { interval_days: null, interval_months: 6 };
    case "annual":
      return { interval_days: null, interval_months: 12 };
    case "custom_days":
      return { interval_days: customDays ?? 1, interval_months: null };
  }
}

export function intervalLabel(i: Interval): string {
  if (i.interval_days == null && i.interval_months == null) return "One-off";
  if (i.interval_days != null) {
    if (i.interval_days === 1) return "Daily";
    if (i.interval_days === 7) return "Every 7 days";
    if (i.interval_days === 42) return "Every 6 weeks";
    return `Every ${i.interval_days} days`;
  }
  if (i.interval_months === 1) return "Monthly";
  if (i.interval_months === 12) return "Every 12 months";
  return `Every ${i.interval_months} months`;
}

export function isOneOff(i: Interval): boolean {
  return i.interval_days == null && i.interval_months == null;
}

// ── Date-only arithmetic (ISO YYYY-MM-DD strings) ─────────────────────────────
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && ISO_DATE_RE.test(v);
}

function toParts(iso: string): { y: number; m: number; d: number } {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const { y, m, d } = toParts(iso);
  return fromUtc(new Date(Date.UTC(y, m - 1, d + days)));
}

/** Month addition with month-end clamping (31 Jan + 1 month → 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const { y, m, d } = toParts(iso);
  const lastOfTarget = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return fromUtc(new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastOfTarget))));
}

/** The next cycle's due date after `dueIso` for a recurring interval. */
export function nextDueAfter(dueIso: string, interval: Interval): string {
  if (interval.interval_days != null) return addDays(dueIso, interval.interval_days);
  if (interval.interval_months != null) return addMonths(dueIso, interval.interval_months);
  // One-off schedules have no next cycle; the generator deactivates them.
  return dueIso;
}

/** Deterministic idempotency bucket: the cycle's due date. */
export function cycleKey(nextDueIso: string): string {
  return nextDueIso;
}

/** Generate when next_due is inside today + lead window. */
export function isDueForGeneration(
  schedule: { next_due: string; lead_time_days: number; active: boolean },
  todayIso: string,
): boolean {
  if (!schedule.active) return false;
  return schedule.next_due <= addDays(todayIso, schedule.lead_time_days);
}

/** A draft due inspection past its due date (UI badge; date-only compare). */
export function isInspectionOverdue(dueAt: string | null, todayIso: string): boolean {
  return !!dueAt && dueAt.slice(0, 10) < todayIso;
}

// ── Validation ────────────────────────────────────────────────────────────────
const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

export const createScheduleSchema = z
  .object({
    asset_id: z.string().uuid(),
    template_id: z.string().uuid(),
    cadence: z.enum(SCHEDULE_CADENCES),
    custom_days: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(3660).optional(),
    ),
    next_due: z.string().regex(ISO_DATE_RE, "Choose a due date"),
    lead_time_days: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).max(365).default(0),
    ),
    required_for_assignment: z.coerce.boolean().default(false),
  })
  .superRefine((s, ctx) => {
    if (s.cadence === "custom_days" && s.custom_days == null) {
      ctx.addIssue({ code: "custom", message: "Give the interval in days", path: ["custom_days"] });
    }
  });
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
