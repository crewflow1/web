import { formatDayKeyUK } from "@/lib/time/format";
import { daysBetween } from "@/lib/schedule/window";
import {
  computeBillSettlements,
  type SupplierAllocationRow,
  type SupplierBillRow,
  type SupplierPaymentRow,
} from "@/lib/suppliers/payments";
import { buildAgeingLedger, type AgeingItem, type AgeingLedger } from "@/lib/commercial/ageing";

/**
 * AGED CREDITORS — the bridge from supplier bills to aged buckets. PURE.
 *
 * Settlement comes entirely from `computeBillSettlements`
 * (lib/suppliers/payments): gross (`amount` + `vat_total`) less the LIVE
 * allocations against that bill, capped per bill, with voided payments settling
 * nothing. This module adds no arithmetic — it picks the ageing date, resolves
 * the supplier, and hands the outstanding figure to the bucketer.
 *
 * ── WHY THIS SIDE AGES FROM THE BILL DATE, NOT A DUE DATE ────────────────────
 * There is no due date to age from. `finances` (which IS the supplier-bill table
 * — there is no separate one) carries `bill_date`, the date printed on the
 * supplier's invoice, and NO due date; `suppliers` carries no payment-terms
 * column. So nothing in this schema records an agreed deadline for paying a
 * supplier, and nothing here may pretend otherwise: defaulting every supplier to
 * net-30 would put a fabricated contractual term into a report an operator makes
 * payment decisions from.
 *
 * The columns therefore mean DAYS SINCE THE BILL WAS RAISED, and the surface says
 * so in those words rather than reusing the debtor side's "overdue".
 *
 * A bill with no `bill_date` falls back to the row's Europe/London calendar day
 * of `created_at` — London-pinned via `formatDayKeyUK`, because a bill entered at
 * 23:30 BST belongs to the day the operator entered it, not to the UTC day
 * before. Ageing from the ledger's own arrival time is the honest second-best; it
 * beats parking undated bills in `current` where nothing ever chases them.
 *
 * ── THE DDL GAP IS NOW CLOSED — TRUE OVERDUE AGEING SUPERSEDES THIS ON /reports ─
 * Migration 20261088 adds `suppliers.payment_terms_days`, so a bill's DUE DATE
 * (bill_date + terms) is now derivable. `lib/commercial/overdue-payables.ts`
 * COMPOSES this module — the same settlement authority, the same bucketer — but
 * ages from that due date, and the /reports/ageing surface uses it as the primary
 * creditors view. This module is retained because the BILL-DATE basis is still a
 * legitimate, distinct lens ("how long since we were billed", independent of any
 * agreed term) and is the honest fallback wherever payment terms are unknown.
 * The ageing date is now injectable (`ageDateOf`) precisely so overdue-payables
 * can reuse every line below without a second copy of the settlement→item loop.
 */

/** A `finances` row that names a supplier — i.e. a supplier bill. */
export type CreditorBill = SupplierBillRow & {
  /** `finances.supplier_id`. Nullable in the column; unattributed if absent. */
  supplier_id: string | null;
};

export const UNATTRIBUTED_SUPPLIER_LABEL = "Unattributed";

/**
 * Which date a bill is aged FROM, as `YYYY-MM-DD`, or null when it cannot be
 * dated at all. A pure function of the bill — no I/O, no closure over time.
 */
export type BillAgeDate = (bill: CreditorBill) => string | null;

/**
 * The BILL-DATE basis (this module's default): the date printed on the
 * supplier's invoice, falling back to the row's Europe/London calendar day of
 * `created_at`. See the header for why London, not UTC.
 */
export const billDateBasis: BillAgeDate = (bill) =>
  bill.bill_date ?? (formatDayKeyUK(bill.created_at) || null);

/**
 * Turn supplier bills + the money-out ledger into aged-ledger items.
 *
 * `payments` must be every supplier payment in scope (voided included — the
 * settlement authority needs them to know what NOT to count), and `allocations`
 * every allocation row for those payments.
 *
 * `ageDateOf` chooses the date each bill is aged from. It defaults to
 * `billDateBasis`; `lib/commercial/overdue-payables.ts` injects a due-date
 * resolver (bill_date + supplier terms) to produce TRUE overdue ageing without
 * re-implementing the settlement→item mapping below. The ageing date only ever
 * decides which BUCKET a bill lands in — never its outstanding balance, which
 * comes solely from `computeBillSettlements`.
 */
export function composeCreditorItems(
  input: {
    bills: CreditorBill[];
    payments: SupplierPaymentRow[];
    allocations: SupplierAllocationRow[];
    supplierName: Map<string, string>;
  },
  asAtIso: string,
  ageDateOf: BillAgeDate = billDateBasis,
): AgeingItem[] {
  const billById = new Map(input.bills.map((b) => [b.id, b]));
  const settlements = computeBillSettlements({
    bills: input.bills,
    payments: input.payments,
    allocations: input.allocations,
  });

  const items: AgeingItem[] = [];
  for (const s of settlements) {
    if (s.outstanding <= 0) continue;
    const bill = billById.get(s.billId);
    if (!bill) continue;

    const supplierId = bill.supplier_id;
    const dateIso = ageDateOf(bill);

    items.push({
      id: s.billId,
      partyId: supplierId ?? "",
      partyName: supplierId
        ? input.supplierName.get(supplierId) || "Unnamed supplier"
        : UNATTRIBUTED_SUPPLIER_LABEL,
      amount: s.outstanding,
      ageDays: dateIso ? daysBetween(dateIso, asAtIso) : null,
      reference: bill.reference ?? null,
      dateIso,
      href: supplierId ? `/suppliers/${supplierId}` : "/expenses",
    });
  }
  return items;
}

/** The aged creditors ledger (bill-date basis by default; see `ageDateOf`). */
export function composeAgedCreditors(
  input: {
    bills: CreditorBill[];
    payments: SupplierPaymentRow[];
    allocations: SupplierAllocationRow[];
    supplierName: Map<string, string>;
  },
  asAtIso: string,
  ageDateOf: BillAgeDate = billDateBasis,
): AgeingLedger {
  return buildAgeingLedger(composeCreditorItems(input, asAtIso, ageDateOf));
}
