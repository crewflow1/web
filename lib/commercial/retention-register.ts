import { round2, sumMoney } from "@/lib/money";
import { daysBetween } from "@/lib/schedule/window";
import {
  computeRetentionPosition,
  type RetentionInvoice,
  type RetentionRelease,
} from "@/lib/retentions/compute";
import { computeRetentionSchedule } from "@/lib/retentions/schedule";

/**
 * THE RETENTION REGISTER — every pound of retention the business is owed, across
 * every job, in one listing, with the contractual dates that entitle it. PURE.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * The retention MODEL has been live since Programme C: `jobs.retention_percent`
 * sets the rate, `retention_releases` is the append-only release ledger,
 * `computeRetentionPosition` derives accrued/released/held, and
 * `computeRetentionSchedule` forecasts the two JCT moieties. What did not exist
 * is the REGISTER — the portfolio listing. `computeRetentionDueRollup` gives an
 * org four scalars (totalHeld, dueNow, and two counts); the per-job schedule
 * lives on the job page. Neither is the document a contractor puts on the table
 * at a client meeting to argue for release, which has to name each job, each
 * moiety, each amount and — decisively — the DATE that entitles it.
 *
 * This module composes the existing authorities into that listing. It derives NO
 * retention: `accrued`, `released`, `held` come from `computeRetentionPosition`,
 * and the moiety split, the FIFO release waterfall and the defects-liability
 * date arithmetic all come from `computeRetentionSchedule`. What is genuinely new
 * here is (1) resolving WHICH practical-completion date governs, and (2) the
 * state model.
 *
 * ── (1) WHICH PRACTICAL COMPLETION DATE — the certificate wins ───────────────
 * Practical Completion is what releases the first moiety AND starts the defects
 * clock that governs the second, so the whole register hangs off that one date.
 * CrewFlow holds it in two places, and they are not equal in standing:
 *
 *   `completion_certificates.completion_date` — the date on an ISSUED Practical
 *       Completion Certificate. A contractual instrument, frozen at issue by a
 *       write-once snapshot (20261014000000), delivered to the customer portal.
 *       This is EVIDENCE: it is what you point at across the table.
 *   `jobs.practical_completion_date` — an operator's working field on the job
 *       (20261013000000). Useful, editable, and no evidence of anything.
 *
 * So an issued certificate's date takes precedence over the job field whenever
 * one exists, and the register reports `completionSource` per line, because
 * "release is due, per certificate CERT-0007" and "release is due, per a date
 * somebody typed into the job" are different arguments and the operator must be
 * able to tell which one they are about to make. When neither exists the line is
 * `awaiting_completion` — never a fabricated "due", which is the same refusal
 * `computeRetentionSchedule` already makes with `awaitingPcDate`.
 *
 * ── (2) THE STATE MODEL ──────────────────────────────────────────────────────
 * Per MOIETY, not per job: retention is released in stages, so a job routinely
 * has one moiety long overdue and another two years out, and a single per-job
 * status would have to lie about one of them.
 *
 *   `released`            nothing left on this moiety (FIFO waterfall filled it)
 *   `overdue`             unreleased, and its date has PASSED — first moiety only
 *   `due`                 unreleased and claimable now, but not called late
 *   `held`                unreleased, dated, date still in the future
 *   `awaiting_completion` retention exists, no PC date anywhere → no date to owe
 *
 * ONLY THE FIRST MOIETY CAN BE `overdue`. Practical Completion is a fixed
 * contractual date, so money still held after it is late. The second moiety is
 * due FROM the end of the defects-liability period — the Certificate of Making
 * Good Defects can legitimately slip past PC + DLP, which is exactly why
 * `computeRetentionSchedule` marks it `dueFrom: true` and calls it "a reminder,
 * not an overdue alarm". Colouring it red would teach operators to ignore the
 * colour. It still carries a populated `daysPastDue`, so the register can say
 * "due from 12/01/2026 — 210 days ago" and let the operator judge; it just does
 * not claim a breach the contract does not support.
 *
 * `due` at EXACTLY the due date, `overdue` only strictly past it — the same
 * boundary `isInvoiceOverdue` applies to invoices (`due_date < today`). Money is
 * not late on the day it falls due.
 *
 * ── The internal reconciliation ──────────────────────────────────────────────
 * Σ over lines of `remaining` === Σ over jobs of `position.held`, necessarily:
 * the moieties partition `accrued`, and the waterfall distributes exactly
 * `released` across them, so Σ remaining = accrued − released = held. The
 * register therefore cannot disagree with the retention authority about how much
 * is outstanding — pinned in __tests__/commercial/retention-register.test.ts.
 *
 * Staff-internal, like every other retention surface. The rate, the certified
 * base and the moiety split never cross to the customer portal.
 */

/** Where the governing practical-completion date came from. */
export type CompletionSource = "certificate" | "job" | "none";

/** The lifecycle of one retention moiety. See the header. */
export type RetentionLineState =
  | "overdue"
  | "due"
  | "held"
  | "awaiting_completion"
  | "released";

/** States in the order an operator wants to be shown them (worst first). */
export const RETENTION_LINE_STATES = [
  "overdue",
  "due",
  "held",
  "awaiting_completion",
  "released",
] as const satisfies readonly RetentionLineState[];

export const RETENTION_LINE_STATE_LABEL: Record<RetentionLineState, string> = {
  overdue: "Overdue for release",
  due: "Due for release",
  held: "Held",
  awaiting_completion: "Awaiting completion date",
  released: "Released",
};

/** One job's inputs. Every figure is raw — this module derives no retention. */
export type RegisterJob = {
  jobId: string;
  /** Job title/reference for the listing. */
  jobLabel: string | null;
  customerId: string | null;
  customerName: string | null;
  /** `jobs.retention_percent`. */
  ratePercent: number | string | null;
  /** `jobs.defects_liability_months`. */
  defectsLiabilityMonths: number | string | null;
  /** `jobs.retention_first_release_pct`. */
  firstReleasePct: number | string | null;
  /** `jobs.practical_completion_date` — the operator's working field. */
  jobCompletionDate: string | null;
  /** An ISSUED certificate's frozen `completion_date`, when one exists. */
  certificateCompletionDate: string | null;
  /** That certificate's number, for the evidence column. */
  certificateNumber: string | null;
  /** The job's invoices — the retention base (non-draft NET). */
  invoices: RetentionInvoice[];
  /** The job's `retention_releases` rows. */
  releases: RetentionRelease[];
};

export type RetentionRegisterLine = {
  /** `${jobId}:${moiety}` — unique, so React keys and sorts are stable. */
  id: string;
  jobId: string;
  jobLabel: string | null;
  customerId: string | null;
  customerName: string | null;
  moiety: "first" | "second";
  /** "At completion" / "End of defects period", from the schedule authority. */
  moietyLabel: string;
  ratePercent: number;
  /** This moiety's share of accrued retention (£). */
  amount: number;
  /** Still to release after the FIFO waterfall (£) — the money being argued for. */
  remaining: number;
  state: RetentionLineState;
  /** The contractual date entitling release, or null when unknown. */
  dueDate: string | null;
  /** True for the defects moiety: "due FROM", may legitimately slip. */
  dueFrom: boolean;
  /** Whole days past `dueDate` (never negative; null when undated/future). */
  daysPastDue: number | null;
  /** Which date governs — see the header. */
  completionSource: CompletionSource;
  /** The certificate number when `completionSource === "certificate"`. */
  certificateNumber: string | null;
  href: string;
};

export type RetentionRegisterTotals = {
  /** Σ `position.accrued` — retention withheld to date across the portfolio. */
  accrued: number;
  /** Σ `position.released` — got back so far. */
  released: number;
  /** Σ `position.held` — still outstanding. Must equal Σ line.remaining. */
  held: number;
  /** Σ `remaining` per state. `released` is 0 by construction. */
  outstandingByState: Record<RetentionLineState, number>;
  lineCountByState: Record<RetentionLineState, number>;
  /** Jobs carrying retention at all (rate > 0 with accrued value). */
  jobCount: number;
  /** Jobs with any unreleased retention. */
  jobsHoldingCount: number;
  /** Jobs with at least one `overdue` line. */
  jobsOverdueCount: number;
};

export type RetentionRegister = {
  lines: RetentionRegisterLine[];
  totals: RetentionRegisterTotals;
};

function zeroByState(): Record<RetentionLineState, number> {
  return { overdue: 0, due: 0, held: 0, awaiting_completion: 0, released: 0 };
}

/**
 * Which practical-completion date governs this job, and on whose authority.
 *
 * Exported because the precedence is a contractual decision, not an
 * implementation detail, and deserves its own test.
 */
export function resolveCompletionDate(job: {
  certificateCompletionDate: string | null;
  jobCompletionDate: string | null;
}): { date: string | null; source: CompletionSource } {
  if (job.certificateCompletionDate) {
    return { date: job.certificateCompletionDate, source: "certificate" };
  }
  if (job.jobCompletionDate) return { date: job.jobCompletionDate, source: "job" };
  return { date: null, source: "none" };
}

/**
 * Build the register.
 *
 * `todayIso` is passed in rather than read from the clock so the register, the
 * aged ledgers and the page header can all state ONE as-at date. A report whose
 * sections disagree about what "today" is cannot be reconciled.
 */
export function buildRetentionRegister(input: {
  jobs: RegisterJob[];
  todayIso: string;
}): RetentionRegister {
  const lines: RetentionRegisterLine[] = [];
  const accruedAll: number[] = [];
  const releasedAll: number[] = [];
  const heldAll: number[] = [];
  let jobCount = 0;
  let jobsHoldingCount = 0;
  let jobsOverdueCount = 0;

  for (const job of input.jobs) {
    const position = computeRetentionPosition({
      ratePercent: job.ratePercent,
      invoices: job.invoices,
      releases: job.releases,
    });

    const { date: completionDate, source: completionSource } = resolveCompletionDate(job);

    const schedule = computeRetentionSchedule({
      position,
      practicalCompletionDate: completionDate,
      defectsLiabilityMonths: Number(job.defectsLiabilityMonths ?? 12),
      firstReleasePct: Number(job.firstReleasePct ?? 50),
      // The schedule's own `now` only decides due/upcoming; we re-derive state
      // below from `todayIso` so every surface shares one as-at date.
      now: new Date(`${input.todayIso}T00:00:00Z`),
    });

    // A job with no retention contributes nothing — not a zero row. An empty
    // line in a client-meeting report is noise that invites doubt.
    if (!schedule.active) continue;

    jobCount += 1;
    accruedAll.push(position.accrued);
    releasedAll.push(position.released);
    heldAll.push(position.held);
    if (position.held > 0) jobsHoldingCount += 1;

    let jobHasOverdue = false;
    for (const moiety of schedule.moieties) {
      const daysPastDue =
        moiety.dueDate != null
          ? Math.max(0, daysBetween(moiety.dueDate, input.todayIso))
          : null;

      let state: RetentionLineState;
      if (moiety.status === "released") {
        state = "released";
      } else if (schedule.awaitingPcDate || moiety.dueDate == null) {
        state = "awaiting_completion";
      } else if (moiety.status === "due") {
        // Only the fixed PC date supports calling money late; the defects moiety
        // is "due FROM" and may legitimately slip (see the header).
        state = !moiety.dueFrom && daysPastDue != null && daysPastDue > 0 ? "overdue" : "due";
      } else {
        state = "held";
      }
      if (state === "overdue") jobHasOverdue = true;

      lines.push({
        id: `${job.jobId}:${moiety.key}`,
        jobId: job.jobId,
        jobLabel: job.jobLabel,
        customerId: job.customerId,
        customerName: job.customerName,
        moiety: moiety.key,
        moietyLabel: moiety.label,
        ratePercent: position.ratePercent,
        amount: moiety.amount,
        remaining: moiety.remaining,
        state,
        dueDate: moiety.dueDate,
        dueFrom: moiety.dueFrom,
        // A future date is not "past due" — report null rather than 0, so a UI
        // cannot render "0 days" for money that is not claimable yet.
        daysPastDue: daysPastDue != null && daysPastDue > 0 ? daysPastDue : null,
        completionSource,
        certificateNumber:
          completionSource === "certificate" ? job.certificateNumber : null,
        // The job's commercial page is where retention actually lives (its
        // schedule panel + the release form) — there is no /retention route.
        href: `/jobs/${job.jobId}/commercial`,
      });
    }
    if (jobHasOverdue) jobsOverdueCount += 1;
  }

  const outstandingByState = zeroByState();
  const lineCountByState = zeroByState();
  for (const line of lines) {
    outstandingByState[line.state] = round2(outstandingByState[line.state] + line.remaining);
    lineCountByState[line.state] += 1;
  }

  // Worst first, then biggest money, then oldest date, then the unique id — a
  // total order, so the listing never reshuffles between two loads.
  const rank = new Map<RetentionLineState, number>(
    RETENTION_LINE_STATES.map((s, i) => [s, i]),
  );
  lines.sort(
    (a, b) =>
      (rank.get(a.state) ?? 99) - (rank.get(b.state) ?? 99) ||
      b.remaining - a.remaining ||
      (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") ||
      a.id.localeCompare(b.id),
  );

  return {
    lines,
    totals: {
      accrued: sumMoney(accruedAll),
      released: sumMoney(releasedAll),
      held: sumMoney(heldAll),
      outstandingByState,
      lineCountByState,
      jobCount,
      jobsHoldingCount,
      jobsOverdueCount,
    },
  };
}

/** Σ retention claimable right now — the number the meeting is actually about. */
export function retentionClaimableNow(totals: RetentionRegisterTotals): number {
  return round2(totals.outstandingByState.overdue + totals.outstandingByState.due);
}
