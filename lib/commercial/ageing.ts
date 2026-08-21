import { round2, sumMoney } from "@/lib/money";

/**
 * Aged debtors / aged creditors — the BUCKETER. Pure, and deliberately ignorant
 * of money derivation.
 *
 * ── WHY THIS MODULE DOES NO ARITHMETIC ───────────────────────────────────────
 * Every £ that reaches here has ALREADY been settled by the authority that owns
 * it, and this module must never re-derive one:
 *
 *   receivables  `invoiceRemaining` (lib/commercial/org-cash) — max(0, total − Σ
 *                invoice_payments), capped per invoice so an overpayment on one
 *                cannot pay down another.
 *   payables     `computeBillSettlement` (lib/suppliers/payments) — gross
 *                (amount + vat_total) − Σ LIVE allocations, per bill.
 *
 * A second copy of either rule is how a report and the page it is supposed to
 * agree with drift apart, and this codebase has already paid for that once (see
 * the `computeCommercialCash` header: a `partially_paid` invoice's FULL total
 * read as paid).
 *
 * The invariant is enforced STRUCTURALLY rather than by asking reviewers to
 * notice: this module is never given the inputs a balance is derived FROM. No
 * document total, no `paid`, no `vat_total`, no `gross`, no `settled`, no
 * allocation or payment rows, no invoice status — so it *cannot* re-derive one,
 * however a future edit is written. (`total` appears below only as the NAME OF AN
 * OUTPUT: a party's or a ledger's summed balance, never an invoice's face value.)
 * It receives a settled `amount` and buckets it. The
 * only money operations here are `round2`-wrapped addition and `sumMoney`;
 * subtraction appears solely inside `.sort()` comparators, where it produces an
 * ORDERING and never a figure that is rendered. Both halves are pinned by
 * __tests__/security/aged-ledgers-no-new-money-maths.test.ts.
 *
 * ── AGEING IS MEASURED IN WHOLE DAYS, SUPPLIED BY THE CALLER ─────────────────
 * `ageDays` is likewise not computed here. Receivables age from the invoice DUE
 * DATE via `invoiceDaysOverdue` — the repo's single overdue authority — because
 * "overdue" commercially means the agreed deadline was missed, not that time has
 * passed since issue. Payables age from the supplier's BILL DATE, because this
 * schema stores no supplier payment terms and no bill due date, so there is no
 * deadline to have missed (see the service header for the DDL gap).
 *
 * ── THE BOUNDARY CONVENTION, STATED ONCE ────────────────────────────────────
 * Buckets count WHOLE DAYS PAST the ageing date and are CLOSED on the right:
 *
 *      ageDays ≤ 0  or null  →  current      (not yet due / undated)
 *      1  … 30               →  1 to 30 days
 *      31 … 60               →  31 to 60 days
 *      61 … 90               →  61 to 90 days
 *      91 +                  →  90+ days
 *
 * So EXACTLY 30 days past due sits in the "1 to 30" column, not "31 to 60": the 30-day
 * column means "up to and including thirty days late", which is how a UK
 * aged-debtor listing is read at a credit-control meeting. Due TODAY is
 * `current`, matching `isInvoiceOverdue` (`due_date < today`, strictly) — an
 * invoice is not late on the day it falls due. Both boundaries are pinned in
 * __tests__/commercial/ageing.test.ts at 0/1, 30/31, 60/61 and 90/91.
 *
 * An UNDATED item lands in `current` because it cannot be overdue — but its
 * value is ALSO reported separately as `undated`, so a ledger cannot quietly
 * launder undated debt into a reassuring "current" figure.
 */

/** The five columns, in reading order. */
export const AGEING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d91_plus"] as const;

export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** The four buckets that mean "past the ageing date". `current` is not one. */
export const PAST_DUE_BUCKETS = ["d1_30", "d31_60", "d61_90", "d91_plus"] as const;

export const AGEING_BUCKET_LABEL: Record<AgeingBucket, string> = {
  current: "Current",
  d1_30: "1 to 30 days",
  d31_60: "31 to 60 days",
  d61_90: "61 to 90 days",
  d91_plus: "90+ days",
};

/**
 * One document to age: an unpaid sales invoice, or an unsettled supplier bill.
 *
 * `amount` is the outstanding balance as the owning authority computed it. This
 * module never inspects a total, a payment or a status.
 */
export type AgeingItem = {
  /** Document id — also the deterministic sort tiebreaker. */
  id: string;
  /** Customer id (debtors) or supplier id (creditors). "" when unattributed. */
  partyId: string;
  /** Display name of that party at read time. */
  partyName: string;
  /** Outstanding balance (£), from the owning money authority. Never re-derived. */
  amount: number;
  /**
   * Whole days past the ageing date. `null` when the document has no ageing
   * date at all (an invoice with no due date, a bill with neither bill_date nor
   * created_at). Negative means not yet due.
   */
  ageDays: number | null;
  /** Human reference — invoice number, or the supplier's own bill reference. */
  reference: string | null;
  /** The ageing date itself (YYYY-MM-DD), for the drill-down. */
  dateIso: string | null;
  /** Where the operator goes to act on it. */
  href: string;
};

/** A party's row in the aged listing. */
export type AgeingPartyRow = {
  partyId: string;
  partyName: string;
  buckets: Record<AgeingBucket, number>;
  /** Σ every bucket — everything this party owes / is owed. */
  total: number;
  /** Σ the four past-due buckets. */
  pastDue: number;
  /** The single oldest item's `ageDays`, or null when every item is undated. */
  oldestAgeDays: number | null;
  itemCount: number;
  /** Σ items with no ageing date (already inside `current`). */
  undated: number;
  /** Oldest-first, so the argument at the top of the row is the strongest one. */
  items: AgeingItem[];
};

export type AgeingTotals = {
  buckets: Record<AgeingBucket, number>;
  total: number;
  pastDue: number;
  itemCount: number;
  partyCount: number;
  /** Σ items with no ageing date — a disclosure, already counted in `current`. */
  undated: number;
};

export type AgeingLedger = {
  rows: AgeingPartyRow[];
  totals: AgeingTotals;
};

function emptyBuckets(): Record<AgeingBucket, number> {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_plus: 0 };
}

/** THE boundary rule. See the header — closed on the right, `current` at ≤ 0. */
export function bucketForAgeDays(ageDays: number | null | undefined): AgeingBucket {
  if (ageDays == null || !Number.isFinite(ageDays)) return "current";
  if (ageDays <= 0) return "current";
  if (ageDays <= 30) return "d1_30";
  if (ageDays <= 60) return "d31_60";
  if (ageDays <= 90) return "d61_90";
  return "d91_plus";
}

/** Is this bucket one of the four past-due columns? */
export function isPastDueBucket(bucket: AgeingBucket): boolean {
  return (PAST_DUE_BUCKETS as readonly AgeingBucket[]).includes(bucket);
}

const UNATTRIBUTED = "";

/**
 * Build an aged ledger from already-settled outstanding balances.
 *
 * Items with a non-positive amount are DROPPED, not bucketed at zero: a fully
 * settled document is not a debtor, and a row of zeroes in a client-meeting
 * report is noise that invites the question "why is that there?". This mirrors
 * the `remaining <= 0` skip in `computeOrgCashSummary`, which is what makes the
 * totals reconcile — see the reconciliation test.
 *
 * Row order is deterministic and total: most past-due money first (that is the
 * chase order), then largest total, then name, then `partyId` as the unique
 * tiebreaker. A report whose row order shuffles between two loads of the same
 * data is a report nobody trusts.
 */
export function buildAgeingLedger(items: AgeingItem[]): AgeingLedger {
  const byParty = new Map<string, AgeingPartyRow>();

  for (const item of items) {
    if (!(item.amount > 0)) continue;

    const key = item.partyId || UNATTRIBUTED;
    let row = byParty.get(key);
    if (!row) {
      row = {
        partyId: key,
        partyName: item.partyName,
        buckets: emptyBuckets(),
        total: 0,
        pastDue: 0,
        oldestAgeDays: null,
        itemCount: 0,
        undated: 0,
        items: [],
      };
      byParty.set(key, row);
    }

    const bucket = bucketForAgeDays(item.ageDays);
    row.buckets[bucket] = round2(row.buckets[bucket] + item.amount);
    row.total = round2(row.total + item.amount);
    if (isPastDueBucket(bucket)) row.pastDue = round2(row.pastDue + item.amount);
    if (item.ageDays == null) row.undated = round2(row.undated + item.amount);
    if (item.ageDays != null && (row.oldestAgeDays == null || item.ageDays > row.oldestAgeDays)) {
      row.oldestAgeDays = item.ageDays;
    }
    row.itemCount += 1;
    row.items.push(item);
  }

  const rows = [...byParty.values()];
  for (const row of rows) {
    // Oldest first; undated last (they are not late, merely unscheduled). `id`
    // is the unique tiebreaker so two same-age items never swap between loads.
    row.items.sort(
      (a, b) =>
        (b.ageDays ?? Number.NEGATIVE_INFINITY) - (a.ageDays ?? Number.NEGATIVE_INFINITY) ||
        b.amount - a.amount ||
        a.id.localeCompare(b.id),
    );
  }
  rows.sort(
    (a, b) =>
      b.pastDue - a.pastDue ||
      b.total - a.total ||
      a.partyName.localeCompare(b.partyName) ||
      a.partyId.localeCompare(b.partyId),
  );

  const buckets = emptyBuckets();
  for (const bucket of AGEING_BUCKETS) {
    buckets[bucket] = sumMoney(rows.map((r) => r.buckets[bucket]));
  }

  return {
    rows,
    totals: {
      buckets,
      total: sumMoney(rows.map((r) => r.total)),
      pastDue: sumMoney(rows.map((r) => r.pastDue)),
      itemCount: rows.reduce((acc, r) => acc + r.itemCount, 0),
      partyCount: rows.length,
      undated: sumMoney(rows.map((r) => r.undated)),
    },
  };
}
