import { addMonthsIso } from "@/lib/completion-certificates/snapshot";

/**
 * Warranty clock + servicing schedule — DERIVED, never stored (Phase 7).
 *
 * `job_warranties` (20261079) holds terms only: a period in months, an optional
 * servicing interval, and a start BASIS. Every date a human ever sees is
 * computed here, from the completion date frozen on the job's ISSUED completion
 * certificate (20261014).
 *
 * Two rules this module exists to enforce:
 *
 *  1. ONE COMPLETION DATE. The only date that can start a warranty is the one on
 *     an issued certificate. `jobs.practical_completion_date` is an editable
 *     working field with no freeze and no audit trail (20261013), so it is not
 *     accepted here — this function takes `certificateCompletionDate` and
 *     nothing else. When there is no issued certificate the result is
 *     `pending_completion`: the warranty has no honest start date, and callers
 *     print that in words rather than inventing one.
 *
 *  2. NOTHING IS SENT. `serviceSchedule` is a list for the screen. There is no
 *     queue, no job, no email. CrewFlow does not notify anyone about a warranty.
 *
 * Pure + server/client-safe: no imports beyond the shared month-arithmetic
 * helper, which clamps to month end (31 Jan + 1 month = 28/29 Feb).
 */

export type WarrantyStatus =
  /** No certificate issued yet — no start date exists, and none is invented. */
  | "pending_completion"
  /** Running: today is on or after the start and before the expiry. */
  | "active"
  /** The term has run out. */
  | "expired"
  /** Withdrawn by the contractor; terms no longer stand. */
  | "void";

export type ServiceOccurrence = {
  /** 1-based: the first service due after the start date. */
  sequence: number;
  /** YYYY-MM-DD. */
  due: string;
  state: "overdue" | "due_soon" | "upcoming";
};

export type WarrantyClock = {
  status: WarrantyStatus;
  /** YYYY-MM-DD, or null when no certificate has been issued. */
  start: string | null;
  /** YYYY-MM-DD, or null when there is no start. */
  expiry: string | null;
  /** Whole days from today to expiry; negative once expired. Null with no start. */
  daysRemaining: number | null;
  /** Every servicing occurrence inside the term. Empty when no interval or no start. */
  serviceSchedule: ServiceOccurrence[];
  /** The next occurrence not yet passed, or null. */
  nextService: ServiceOccurrence | null;
};

/** Occurrences are capped so a 1-month interval over 50 years can't build 600 rows. */
const MAX_OCCURRENCES = 60;
/** Inside this window an upcoming service reads as "due soon". */
const DUE_SOON_DAYS = 30;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days between two YYYY-MM-DD dates (b − a). UTC, so no DST drift. */
export function daysBetweenIso(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ms =
    Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!);
  return Math.round(ms / 86_400_000);
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function computeWarrantyClock(input: {
  periodMonths: number;
  serviceIntervalMonths: number | null;
  /**
   * The frozen `completion_date` of the job's ISSUED completion certificate, or
   * null when none has been issued. Nothing else may be passed here — see the
   * module docblock.
   */
  certificateCompletionDate: string | null;
  /** Set when the warranty has been voided; short-circuits the clock. */
  voided?: boolean;
  today?: string;
}): WarrantyClock {
  const today = input.today ?? todayIso();
  const start =
    input.certificateCompletionDate && ISO.test(input.certificateCompletionDate)
      ? input.certificateCompletionDate
      : null;

  if (!start) {
    // No certificate → no honest start date. Say so; do not fall back to any
    // other date on the job.
    return {
      status: input.voided ? "void" : "pending_completion",
      start: null,
      expiry: null,
      daysRemaining: null,
      serviceSchedule: [],
      nextService: null,
    };
  }

  const months = Math.max(1, Math.trunc(input.periodMonths));
  const expiry = addMonthsIso(start, months);
  const daysRemaining = daysBetweenIso(today, expiry);

  const status: WarrantyStatus = input.voided
    ? "void"
    : daysRemaining < 0
      ? "expired"
      : "active";

  const serviceSchedule = buildServiceSchedule({
    start,
    expiry,
    intervalMonths: input.serviceIntervalMonths,
    today,
  });

  return {
    status,
    start,
    expiry,
    daysRemaining,
    serviceSchedule,
    nextService: serviceSchedule.find((o) => o.state !== "overdue") ?? null,
  };
}

function buildServiceSchedule(input: {
  start: string;
  expiry: string;
  intervalMonths: number | null;
  today: string;
}): ServiceOccurrence[] {
  const interval = input.intervalMonths;
  if (!interval || interval < 1) return [];
  const out: ServiceOccurrence[] = [];
  for (let n = 1; n <= MAX_OCCURRENCES; n += 1) {
    const due = addMonthsIso(input.start, Math.trunc(interval) * n);
    // The schedule lives inside the term: a service due after the warranty has
    // expired is no longer a warranty obligation.
    if (daysBetweenIso(due, input.expiry) < 0) break;
    const delta = daysBetweenIso(input.today, due);
    out.push({
      sequence: n,
      due,
      state: delta < 0 ? "overdue" : delta <= DUE_SOON_DAYS ? "due_soon" : "upcoming",
    });
  }
  return out;
}

export const WARRANTY_KIND_LABELS: Record<string, string> = {
  workmanship: "Workmanship",
  product: "Product / manufacturer",
  structural: "Structural",
  defects_liability: "Defects liability",
  other: "Other",
};

export const WARRANTY_STATUS_LABELS: Record<WarrantyStatus, string> = {
  pending_completion: "Starts at completion",
  active: "In cover",
  expired: "Expired",
  void: "Withdrawn",
};

export const WARRANTY_STATUS_STYLES: Record<WarrantyStatus, string> = {
  pending_completion: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-800",
  expired: "bg-slate-200 text-slate-600",
  void: "bg-red-100 text-red-700",
};

/**
 * The single sentence shown wherever a warranty has no start date. Kept here so
 * the operator screen and the customer portal can never say different things
 * about the same missing fact.
 */
export const NO_CERTIFICATE_NOTE =
  "This warranty starts when the completion certificate is issued. Until then it has no start or expiry date.";
