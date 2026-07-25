import { round2 } from "@/lib/money";
import type { RetentionPosition } from "@/lib/retentions/compute";

/**
 * Retention release schedule (Programme C extension) — PURE forecast of WHEN a
 * job's held construction retention is due back to the builder.
 *
 * A FORECAST LAYER over the ledger, never a second source of truth. The two
 * moieties (UK/JCT convention: a first release at Practical Completion, the
 * remainder at the end of the Defects Liability Period) are sized off **accrued**
 * — `accrued = held + released` — NOT off live `held`, which shrinks as money is
 * released (sizing off `held` would make the PC moiety appear to owe money after
 * it was fully released). Actual releases are reconciled against the moieties by
 * a **FIFO waterfall** (fill the first, overflow to the second): the ledger is a
 * flat, immutable sum with no moiety tag, so FIFO is the only defensible mapping.
 *
 * Degrades safely: no retention (rate 0 / accrued 0) → inactive; retention but
 * no Practical Completion date → `awaitingPcDate` (never a fake "due"/"overdue").
 * The second moiety is "due FROM" its date (the Certificate of Making Good can
 * slip later than PC + DLP), so it is a reminder, not an overdue alarm.
 *
 * Staff-internal: retention is the customer's money the builder is chasing back;
 * this schedule is never exposed on the customer portal.
 */

const TOL = 0.005;

export type MoietyStatus = "upcoming" | "due" | "released";

export type RetentionMoiety = {
  key: "first" | "second";
  label: string;
  /** This moiety's share of accrued retention (£). */
  amount: number;
  /** Still to release after the FIFO waterfall (£). */
  remaining: number;
  /** YYYY-MM-DD, or null if no Practical Completion date is set. */
  dueDate: string | null;
  /** The second moiety is "due FROM" its date (can slip) — not "overdue". */
  dueFrom: boolean;
  status: MoietyStatus;
};

export type RetentionSchedule = {
  /** false → the job has no retention worth scheduling. */
  active: boolean;
  /** true → retention exists but no PC date, so dates can't be forecast yet. */
  awaitingPcDate: boolean;
  accrued: number;
  released: number;
  held: number;
  moieties: RetentionMoiety[];
  /** Σ remaining across moieties already at/after their due date (£). */
  dueNow: number;
  /** The soonest unreleased moiety date, or null. */
  nextDueDate: string | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Add whole calendar months to a YYYY-MM-DD date, clamping to month end. */
export function addMonths(dateIso: string, months: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const base = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const daysInTarget = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d!, daysInTarget));
  return base.toISOString().slice(0, 10);
}

function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function computeRetentionSchedule(input: {
  position: RetentionPosition;
  practicalCompletionDate: string | null;
  defectsLiabilityMonths: number;
  firstReleasePct: number;
  now?: Date;
}): RetentionSchedule {
  const { accrued, released, held, ratePercent } = input.position;

  // No retention on this job → nothing to schedule.
  if (ratePercent <= 0 || accrued <= TOL) {
    return { active: false, awaitingPcDate: false, accrued, released, held, moieties: [], dueNow: 0, nextDueDate: null };
  }

  const firstPct = Math.min(100, Math.max(0, input.firstReleasePct));
  const firstAmount = round2((accrued * firstPct) / 100);
  const secondAmount = round2(accrued - firstAmount);

  // FIFO waterfall: fill the first moiety, overflow into the second.
  const releasedToFirst = Math.min(released, firstAmount);
  const releasedToSecond = Math.min(Math.max(0, released - firstAmount), secondAmount);
  const firstRemaining = round2(Math.max(0, firstAmount - releasedToFirst));
  const secondRemaining = round2(Math.max(0, secondAmount - releasedToSecond));

  const pc = input.practicalCompletionDate && DATE_RE.test(input.practicalCompletionDate)
    ? input.practicalCompletionDate
    : null;

  // Retention exists but no PC date → can't forecast dates yet.
  if (!pc) {
    const moieties: RetentionMoiety[] = [
      { key: "first", label: "At completion", amount: firstAmount, remaining: firstRemaining, dueDate: null, dueFrom: false, status: firstRemaining <= TOL ? "released" : "upcoming" },
    ];
    if (secondAmount > TOL) {
      moieties.push({ key: "second", label: "End of defects period", amount: secondAmount, remaining: secondRemaining, dueDate: null, dueFrom: true, status: secondRemaining <= TOL ? "released" : "upcoming" });
    }
    return { active: true, awaitingPcDate: true, accrued, released, held, moieties, dueNow: 0, nextDueDate: null };
  }

  const today = todayIso(input.now ?? new Date());
  const secondDue = addMonths(pc, Math.max(0, Math.trunc(input.defectsLiabilityMonths)));

  const first: RetentionMoiety = {
    key: "first",
    label: "At completion",
    amount: firstAmount,
    remaining: firstRemaining,
    dueDate: pc,
    dueFrom: false,
    status: firstRemaining <= TOL ? "released" : pc <= today ? "due" : "upcoming",
  };
  const moieties: RetentionMoiety[] = [first];
  if (secondAmount > TOL) {
    moieties.push({
      key: "second",
      label: "End of defects period",
      amount: secondAmount,
      remaining: secondRemaining,
      dueDate: secondDue,
      dueFrom: true,
      status: secondRemaining <= TOL ? "released" : secondDue <= today ? "due" : "upcoming",
    });
  }

  const dueNow = round2(moieties.filter((m) => m.status === "due").reduce((s, m) => s + m.remaining, 0));
  const nextDueDate = moieties
    .filter((m) => m.status !== "released" && m.dueDate)
    .map((m) => m.dueDate as string)
    .sort()[0] ?? null;

  return { active: true, awaitingPcDate: false, accrued, released, held, moieties, dueNow, nextDueDate };
}
