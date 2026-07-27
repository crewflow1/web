import { round2, toPounds } from "@/lib/money";
import { invoiceBusinessToday, isInvoiceOverdue } from "@/lib/invoices/overdue";

/**
 * Deterministic short-horizon cash forecast (H2-CASH M3) — PURE.
 *
 * The owner's honest answer to "what's coming, and how sure is it?". The whole
 * point is to DISTINGUISH CERTAINTY, never to collapse everything into one
 * "expected cash" number. Four states, in descending certainty:
 *
 *   OVERDUE      — already invoiced, past its due date            (ledger fact)
 *   DUE          — already invoiced, a future due date            (ledger fact)
 *   PLANNED      — an agreed billing stage, NOT yet invoiced      (a plan)
 *   UNSCHEDULED  — revised contract value with no stage & no       (a gap)
 *                  invoice — the builder hasn't planned how to bill it
 *
 * There is NO fake probability ("87% chance of £10k") and NO AI. Each figure is
 * a deterministic sum of real rows. Planned billing is labelled "planned to
 * invoice", never "expected payment" — a stage's due date is a planning date,
 * not a guarantee of completed work or received cash.
 *
 * ── VAT axis ─────────────────────────────────────────────────────────────────
 * Everything here is the GROSS cash axis (what moves through the bank), because
 * a forecast is about cash. `revised`/`billed`/invoice `total` are gross
 * (verified: quotes.total & invoices.total are inc-VAT). A planned stage's gross
 * is `amount + round2(amount × vat_rate/100)` (stage `amount` is ex-VAT). We
 * NEVER subtract a net plan figure from a gross cash figure.
 *
 * ── Unscheduled uses the LIVE contract, not the frozen plan basis ────────────
 * `unscheduled = max(0, stillToBill − plannedGross − draftedGross)` where
 * `stillToBill = max(0, revised − billed)` from the LIVE quote/invoice ledger.
 * Using the live `revised` (not `job_billing_plans.basis_amount`, a frozen
 * ex-VAT snapshot) means a variation approved AFTER a plan was created correctly
 * flows into the forecast instead of silently vanishing.
 *
 * Retention is deliberately NOT netted out of the invoiced buckets here — those
 * are the gross "already invoiced" figures the §9 outlook shows. The precise
 * retention-netted chase figure (`collectableNow`) is computed separately by
 * lib/commercial/retention-attribution; retention held/due is its own dimension.
 * The outlook total never adds retention in, so nothing is double-counted.
 */

/** GROSS-collectable invoice statuses (money is still owed). */
const COLLECTABLE = new Set(["sent", "awaiting_payment", "partially_paid", "overdue"]);
/** Non-draft = "billed" (issued to the customer). */
const INVOICE_RAISED = new Set(["sent", "awaiting_payment", "partially_paid", "paid", "overdue"]);
const ACCEPTED = "accepted";

export type ForecastInvoice = {
  status: string;
  /** gross invoice total (inc-VAT). */
  total: number | string | null;
  due_date: string | null;
  /** gross paid to date on this invoice (Σ ledger), for the remaining balance. */
  paid: number;
};

export type ForecastStage = {
  /** null = not yet invoiced (a genuine "planned" stage). */
  invoice_id: string | null;
  /** ex-VAT stage amount. */
  amount: number | string | null;
  /** 0 | 5 | 20. */
  vat_rate: number | string | null;
  /** planned billing date (a plan, not a guarantee). */
  due_date: string | null;
};

export type ForecastQuote = {
  variation_number: number | null;
  status: string;
  /** gross quote total (inc-VAT). */
  total: number | string | null;
};

/** Non-overlapping horizon buckets; the presenter builds cumulative windows. */
export type HorizonBuckets = {
  /** due within [today, today+7]. */
  next7: number;
  /** due within (today+7, today+30]. */
  next30: number;
  /** due after today+30. */
  later: number;
  /** collectable/planned with no date to place it. */
  undated: number;
};

export type JobCashForecast = {
  /** already invoiced, past due (gross remaining). */
  overdue: number;
  /** already invoiced, future due date (gross remaining), by horizon. */
  due: HorizonBuckets;
  /** drafted invoices not yet issued (gross) — a nudge to send them. */
  draftedNotIssued: number;
  /** agreed stages not yet invoiced (gross), by planned date horizon. */
  planned: HorizonBuckets;
  /** Σ planned across all horizons (RAW stage gross, may over-carve the contract). */
  plannedTotal: number;
  /**
   * plannedTotal CAPPED at the remaining contract (stillToBill − drafted). This is
   * the honest "planned billing" figure to show: raw stages can exceed the live
   * contract (a stale plan after a downward variation, or stage VAT above the
   * contract's), and presenting that as near-term cash would overstate it.
   */
  plannedCapped: number;
  /** live contract (gross): original + approved variations. */
  revised: number;
  /** Σ non-draft invoice totals (gross). */
  billed: number;
  /** max(0, revised − billed) — contract value not yet issued as an invoice. */
  stillToBill: number;
  /** max(0, stillToBill − plannedTotal − draftedNotIssued) — no stage, no invoice. */
  unscheduled: number;
};

function addToHorizon(b: HorizonBuckets, dateIso: string | null, todayIso: string, amount: number): void {
  if (amount <= 0) return;
  if (!dateIso) {
    b.undated = round2(b.undated + amount);
    return;
  }
  // Whole-day horizon from today (dates are Postgres `date`, compare calendar days).
  const day = 86_400_000;
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  const when = Date.parse(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(when)) {
    b.undated = round2(b.undated + amount);
    return;
  }
  const days = Math.round((when - today) / day);
  if (days <= 7) b.next7 = round2(b.next7 + amount);
  else if (days <= 30) b.next30 = round2(b.next30 + amount);
  else b.later = round2(b.later + amount);
}

const emptyHorizon = (): HorizonBuckets => ({ next7: 0, next30: 0, later: 0, undated: 0 });

function stageGross(s: ForecastStage): number {
  const amount = round2(Math.max(0, toPounds(s.amount)));
  const rate = toPounds(s.vat_rate);
  const vat = round2((amount * (rate === 5 || rate === 20 ? rate : rate === 0 ? 0 : 20)) / 100);
  return round2(amount + vat);
}

/** Compute one job's forecast from its quotes, invoices and (planned) stages. */
export function computeJobCashForecast(input: {
  quotes: ForecastQuote[];
  invoices: ForecastInvoice[];
  stages: ForecastStage[];
  now?: Date;
}): JobCashForecast {
  const todayIso = invoiceBusinessToday(input.now ?? new Date());

  let overdue = 0;
  let draftedNotIssued = 0;
  let billed = 0;
  const due = emptyHorizon();

  for (const inv of input.invoices) {
    const status = String(inv.status ?? "");
    const total = round2(Math.max(0, toPounds(inv.total)));
    if (status === "draft") {
      draftedNotIssued = round2(draftedNotIssued + total);
      continue;
    }
    if (INVOICE_RAISED.has(status)) billed = round2(billed + total);
    if (!COLLECTABLE.has(status)) continue; // paid → nothing owed
    const remaining = round2(Math.max(0, total - round2(Math.max(0, inv.paid))));
    if (remaining <= 0) continue;
    if (isInvoiceOverdue({ status, due_date: inv.due_date }, todayIso)) {
      overdue = round2(overdue + remaining);
    } else {
      addToHorizon(due, inv.due_date, todayIso, remaining);
    }
  }

  // Planned billing — stages with no invoice yet (a genuine forward plan).
  const planned = emptyHorizon();
  let plannedTotal = 0;
  for (const s of input.stages) {
    if (s.invoice_id) continue; // already invoiced → lives in the invoice buckets
    const gross = stageGross(s);
    if (gross <= 0) continue;
    addToHorizon(planned, s.due_date, todayIso, gross);
    plannedTotal = round2(plannedTotal + gross);
  }

  // Live contract (gross) — SIGNED sum, matching computeCommercialCash. An
  // accepted omission/negative variation legitimately REDUCES the contract; a
  // per-quote floor would drop it and overstate `revised` / `unscheduled`.
  const revised = round2(
    input.quotes
      .filter((q) => q.status === ACCEPTED)
      .reduce((s, q) => round2(s + toPounds(q.total)), 0),
  );
  const stillToBill = round2(Math.max(0, revised - billed));
  // Planned billing capped at the remaining contract (never claim more near-term
  // cash than the live contract can hold). With the cap, the partition holds:
  // billed + drafted + plannedCapped + unscheduled === revised (when not over-billed).
  const plannedCapped = round2(Math.min(plannedTotal, Math.max(0, stillToBill - draftedNotIssued)));
  const unscheduled = round2(Math.max(0, stillToBill - draftedNotIssued - plannedCapped));

  return { overdue, due, draftedNotIssued, planned, plannedTotal, plannedCapped, revised, billed, stillToBill, unscheduled };
}

export type OrgCashForecast = JobCashForecast & {
  /** cumulative INVOICED-due within N days (overdue is a separate bucket). */
  dueNext7: number;
  dueNext30: number;
  plannedNext7: number;
  plannedNext30: number;
};

const sumHorizon = (a: HorizonBuckets, b: HorizonBuckets): HorizonBuckets => ({
  next7: round2(a.next7 + b.next7),
  next30: round2(a.next30 + b.next30),
  later: round2(a.later + b.later),
  undated: round2(a.undated + b.undated),
});

/** Roll per-job forecasts into the org forecast (org === Σ jobs, by construction). */
export function aggregateCashForecast(jobs: JobCashForecast[]): OrgCashForecast {
  const acc: JobCashForecast = {
    overdue: 0,
    due: emptyHorizon(),
    draftedNotIssued: 0,
    planned: emptyHorizon(),
    plannedTotal: 0,
    plannedCapped: 0,
    revised: 0,
    billed: 0,
    stillToBill: 0,
    unscheduled: 0,
  };
  for (const j of jobs) {
    acc.overdue = round2(acc.overdue + j.overdue);
    acc.due = sumHorizon(acc.due, j.due);
    acc.draftedNotIssued = round2(acc.draftedNotIssued + j.draftedNotIssued);
    acc.planned = sumHorizon(acc.planned, j.planned);
    acc.plannedTotal = round2(acc.plannedTotal + j.plannedTotal);
    acc.plannedCapped = round2(acc.plannedCapped + j.plannedCapped);
    acc.revised = round2(acc.revised + j.revised);
    acc.billed = round2(acc.billed + j.billed);
    acc.stillToBill = round2(acc.stillToBill + j.stillToBill);
    acc.unscheduled = round2(acc.unscheduled + j.unscheduled);
  }
  return {
    ...acc,
    dueNext7: round2(acc.due.next7),
    dueNext30: round2(acc.due.next7 + acc.due.next30),
    plannedNext7: round2(acc.planned.next7),
    plannedNext30: round2(acc.planned.next7 + acc.planned.next30),
  };
}
