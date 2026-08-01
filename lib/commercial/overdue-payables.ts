import { formatDayKeyUK } from "@/lib/time/format";
import { addDays } from "@/lib/schedule/window";
import {
  composeAgedCreditors,
  type BillAgeDate,
  type CreditorBill,
} from "@/lib/commercial/aged-creditors";
import type { SupplierAllocationRow, SupplierPaymentRow } from "@/lib/suppliers/payments";
import type { AgeingLedger } from "@/lib/commercial/ageing";

/**
 * OVERDUE PAYABLES — the money-OUT twin of overdue receivables. PURE.
 *
 * This is the module that closes the "overdue-payables NOT COMPUTABLE" gap.
 * Aged creditors (lib/commercial/aged-creditors) ages a supplier bill from its
 * BILL DATE, because until migration 20261088 the schema stored no supplier
 * payment terms and therefore no deadline to have missed. That migration adds
 * `suppliers.payment_terms_days`, so a bill's DUE DATE — `bill_date + terms` —
 * is now derivable, and this module ages from it. The result is a true overdue
 * listing: `1–30 days` here means "1–30 days PAST DUE", the same reading the
 * debtor side has always had (lib/invoices/overdue), not "1–30 days since raised".
 *
 * ── IT COMPOSES aged-creditors — IT ADDS NO MONEY MATHS ──────────────────────
 * The only thing this module changes is the DATE a bill is aged from. Everything
 * else is aged-creditors, unmodified:
 *
 *   settlement / outstanding   `computeBillSettlements`  (via composeAgedCreditors)
 *   bucketing + totals         `buildAgeingLedger`       (via composeAgedCreditors)
 *
 * It injects a `BillAgeDate` resolver into `composeAgedCreditors` rather than
 * copying the settlement→item loop, so there is exactly one payables settlement
 * path in the codebase. No `amount + vat_total`, no `gross − settled`, no void
 * filter, no per-bill cap lives here — they cannot, because this module never
 * sees a payment or an allocation amount as anything but an opaque pass-through.
 * Pinned by __tests__/security/aged-ledgers-no-new-money-maths.test.ts.
 *
 * ── THE RECONCILIATION IDENTITY (the payables analogue of aged-debtors') ──────
 * Changing the ageing DATE moves a bill between buckets; it never changes how
 * much is outstanding. So for the same bills, payments and as-at day:
 *
 *     composeOverduePayables(...).totals.total === composeAgedCreditors(...).totals.total
 *                                              === computeOrgCashOut(...).unpaidBills
 *
 * i.e. true overdue ageing re-slices exactly the same payable the cash position
 * already reports — it introduces no new money and double-counts nothing. This
 * is the payables mirror of the debtors reconciliation
 * (composeAgedDebtors().totals.total === computeOrgCashSummary().owedNow) and is
 * proved in __tests__/commercial/overdue-payables.test.ts. It is ALSO why this
 * module is NOT added to the cash-out position: overdue payables is a SUBSET of
 * `unpaidBills`, which is already fully inside `outflowDueNow`. Adding it would
 * double-count the same cash. Overdue ageing is a lens on the money-out the
 * position already holds, not a new outflow line.
 *
 * ── THE 30-DAY ASSUMPTION IS APPLIED HERE, AND DISCLOSED, NEVER STORED ────────
 * `payment_terms_days` is nullable (see the migration): NULL means "terms not
 * recorded". Ageing still needs a number, so a null falls back to
 * `DEFAULT_PAYMENT_TERMS_DAYS` — but that is an ASSUMPTION the surface states in
 * words, not an agreed term written to the database. Keeping the default in code
 * is what lets the UI say "assumes 30 days where terms aren't set" instead of
 * silently presenting a fabricated deadline as fact.
 */

/**
 * The net terms assumed when a supplier has no recorded `payment_terms_days`.
 * An ASSUMPTION applied only at read time and disclosed as one — never written
 * to the database (see the migration header for why there is no DB default).
 */
export const DEFAULT_PAYMENT_TERMS_DAYS = 30;

/**
 * The terms to age by: the supplier's recorded value, or the documented default
 * when unrecorded. Non-finite / negative inputs collapse to the default rather
 * than producing a nonsensical due date — the DB CHECK already forbids them, so
 * this only guards a test or a pre-CHECK row.
 */
export function effectiveTermsDays(terms: number | null | undefined): number {
  if (terms == null || !Number.isFinite(terms) || terms < 0) return DEFAULT_PAYMENT_TERMS_DAYS;
  return Math.trunc(terms);
}

/**
 * A bill's DUE DATE (`YYYY-MM-DD`), or null when it has no datable base at all.
 *
 * Base date is the bill date, falling back to the row's Europe/London calendar
 * day of `created_at` — London-pinned via `formatDayKeyUK`, so a bill entered at
 * 23:30 BST is dated the day the operator saw, not the UTC day before (the repo's
 * BST-incident discipline). Terms are added with `addDays`, which is exact whole
 * days on a date KEY regardless of any DST transition in the interval. A bill
 * with neither date is UNDATED — it cannot be overdue, and lands in `current`.
 */
export function billDueDate(
  bill: Pick<CreditorBill, "bill_date" | "created_at" | "supplier_id">,
  termsBySupplier: Map<string, number | null>,
): string | null {
  const base = bill.bill_date ?? (formatDayKeyUK(bill.created_at) || null);
  if (!base) return null;
  const recorded = bill.supplier_id ? termsBySupplier.get(bill.supplier_id) ?? null : null;
  return addDays(base, effectiveTermsDays(recorded));
}

/**
 * The overdue-payables ledger — aged creditors, aged from the DUE DATE.
 *
 * `termsBySupplier` maps supplier id → recorded `payment_terms_days` (null when
 * unrecorded). Every other input is exactly what `composeAgedCreditors` takes,
 * because this IS `composeAgedCreditors` with a due-date resolver.
 */
export function composeOverduePayables(
  input: {
    bills: CreditorBill[];
    payments: SupplierPaymentRow[];
    allocations: SupplierAllocationRow[];
    supplierName: Map<string, string>;
    termsBySupplier: Map<string, number | null>;
  },
  asAtIso: string,
): AgeingLedger {
  const dueDateOf: BillAgeDate = (bill) => billDueDate(bill, input.termsBySupplier);
  return composeAgedCreditors(
    {
      bills: input.bills,
      payments: input.payments,
      allocations: input.allocations,
      supplierName: input.supplierName,
    },
    asAtIso,
    dueDateOf,
  );
}
