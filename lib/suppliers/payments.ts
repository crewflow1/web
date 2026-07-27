import { round2, sumMoney, toPounds } from "@/lib/money";
import { ALLOCATION_TOLERANCE } from "@/lib/payments/allocation";

/**
 * H2-CIS M2 — supplier payment (money-OUT) domain maths. PURE: no Supabase, no
 * server-only, no I/O. Imported by server actions, pages and tests alike.
 *
 * Mirrors `lib/payments/allocation.ts` (money-IN) deliberately, so the two
 * ledgers read the same way. It answers the four questions the supplier page
 * asks and the DB independently enforces:
 *
 *   1. What is a bill's GROSS value?      (finances.amount + vat_total)
 *   2. How much of a bill is outstanding? (gross − live allocations)
 *   3. Where does a supplier stand?       (billed / paid / outstanding /
 *                                          CIS withheld / net cash)
 *   4. Is a proposed payment legal?       (before the DB says no, and with a
 *                                          better message than a raw SQL error)
 *
 * ── THE INVARIANT THIS MODULE MUST NOT BREAK ───────────────────────────────
 * CIS withholding does not reduce cost. £10,000 gross with £2,000 withheld is
 * £8,000 of cash out, but the job still cost £10,000 — the £2,000 is the
 * subcontractor's tax held for HMRC, not margin. So `cisWithheld` and `netCash`
 * are reported as CASH facts and are NEVER subtracted from `billedNet`,
 * `billedGross` or `outstanding`. `billedNet` is exposed precisely so a caller
 * can show that the cost figure is untouched by any withholding. The database
 * enforces the same thing structurally: this ledger never writes `finances`.
 *
 * Every figure goes through `lib/money` (2dp, no float drift) and shares
 * `ALLOCATION_TOLERANCE` with the money-in ledger so a penny reads the same on
 * both sides of the books and matches the DB guard's ±0.005.
 */

export { ALLOCATION_TOLERANCE };

/** UK CIS payment methods — mirrors the `supplier_payments.method` CHECK. */
export const SUPPLIER_PAYMENT_METHODS = [
  "bank_transfer",
  "card",
  "cash",
  "cheque",
  "other",
] as const;

export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];

export const SUPPLIER_PAYMENT_METHOD_LABEL: Record<SupplierPaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  card: "Card",
  cash: "Cash",
  cheque: "Cheque",
  other: "Other",
};

// ---------------------------------------------------------------------------
// Row shapes (as the app reads them)
// ---------------------------------------------------------------------------

/**
 * A supplier bill — i.e. a `public.finances` row. `amount` is NET; `vat_total`
 * is the stored generated VAT. There is no supplier_bills table and this type
 * must not imply one.
 */
export type SupplierBillRow = {
  id: string;
  /** NET (ex-VAT). THE cost figure — profitability sums exactly this. */
  amount: number | string | null;
  /** Generated VAT on `amount`. */
  vat_total: number | string | null;
  reference?: string | null;
  bill_date?: string | null;
  created_at?: string | null;
  category?: string | null;
  job_id?: string | null;
};

/** A `public.supplier_payments` row. */
export type SupplierPaymentRow = {
  id: string;
  paid_at: string;
  method: string;
  reference: string | null;
  /** Value settled against the supplier account (VAT-inclusive). */
  gross_amount: number | string | null;
  /** Tax withheld for HMRC. A liability — never a cost saving. */
  cis_withheld: number | string | null;
  /** Cash that actually left the bank. */
  net_paid: number | string | null;
  notes?: string | null;
  voided_at?: string | null;
  void_reason?: string | null;
  created_at?: string | null;
};

/** A `public.supplier_payment_allocations` row. */
export type SupplierAllocationRow = {
  payment_id: string;
  finance_id: string;
  amount: number | string | null;
};

/** A payment is LIVE unless it has been voided. Voided rows count for nothing. */
export function isLivePayment(p: { voided_at?: string | null }): boolean {
  return !p.voided_at;
}

// ---------------------------------------------------------------------------
// 1 + 2 — bill value and per-bill settlement
// ---------------------------------------------------------------------------

/**
 * A bill's GROSS value — what the supplier is actually owed, VAT included.
 * This is the figure a payment settles, and the cap the DB applies. The NET
 * `amount` alone is the COST figure and is deliberately not used here.
 */
export function billGross(bill: Pick<SupplierBillRow, "amount" | "vat_total">): number {
  return round2(toPounds(bill.amount) + toPounds(bill.vat_total));
}

export type BillSettlementStatus = "unpaid" | "part_paid" | "paid" | "over_paid";

export type BillSettlement = {
  billId: string;
  /** amount + vat_total. */
  gross: number;
  /** NET value — the cost. Carried so callers can show it is unaffected by CIS. */
  net: number;
  /** Σ live allocations against this bill. */
  settled: number;
  /** gross − settled, never negative. */
  outstanding: number;
  status: BillSettlementStatus;
};

/**
 * Where one bill stands. `allocations` must already be filtered to LIVE
 * payments — a voided payment's allocations settle nothing (the DB's CAP 2
 * excludes them for the same reason, which is what makes void-then-re-record
 * work). Use `liveAllocations` below rather than filtering by hand.
 *
 * `over_paid` should not persist — the DB refuses it from BOTH directions, which
 * takes two guards because there are two ways in: CAP 2 in
 * `tg_supplier_payment_allocation_guard` (20261047000000) refuses an allocation
 * that would exceed the bill, and the settlement floor in
 * `tg_finances_bill_value_guard` (20261054000000) refuses cutting the bill below
 * what is already settled. Until the latter existed the second door was open and
 * this state DID persist. It stays modelled so a rejected attempt, or a row
 * predating either guard, renders coherently instead of as a negative
 * outstanding.
 */
export function computeBillSettlement(input: {
  bill: SupplierBillRow;
  allocations: Array<{ amount: number | string | null }>;
}): BillSettlement {
  const gross = billGross(input.bill);
  const net = round2(toPounds(input.bill.amount));
  const settled = sumMoney(input.allocations.map((a) => a.amount));
  const outstanding = round2(Math.max(0, gross - settled));

  let status: BillSettlementStatus;
  if (settled <= ALLOCATION_TOLERANCE) status = "unpaid";
  else if (settled > gross + ALLOCATION_TOLERANCE) status = "over_paid";
  else if (settled >= gross - ALLOCATION_TOLERANCE) status = "paid";
  else status = "part_paid";

  return { billId: input.bill.id, gross, net, settled, outstanding, status };
}

/** Allocations belonging to payments that have not been voided. */
export function liveAllocations(
  allocations: SupplierAllocationRow[],
  payments: SupplierPaymentRow[],
): SupplierAllocationRow[] {
  const live = new Set(payments.filter(isLivePayment).map((p) => p.id));
  return allocations.filter((a) => live.has(a.payment_id));
}

/** Per-bill settlement for a whole supplier, in the order the bills came in. */
export function computeBillSettlements(input: {
  bills: SupplierBillRow[];
  payments: SupplierPaymentRow[];
  allocations: SupplierAllocationRow[];
}): BillSettlement[] {
  const live = liveAllocations(input.allocations, input.payments);
  const byBill = new Map<string, Array<{ amount: number | string | null }>>();
  for (const a of live) {
    const list = byBill.get(a.finance_id);
    if (list) list.push({ amount: a.amount });
    else byBill.set(a.finance_id, [{ amount: a.amount }]);
  }
  return input.bills.map((bill) =>
    computeBillSettlement({ bill, allocations: byBill.get(bill.id) ?? [] }),
  );
}

// ---------------------------------------------------------------------------
// 3 — the supplier's overall position
// ---------------------------------------------------------------------------

export type SupplierPosition = {
  /** Σ bill NET. THE COST. Never reduced by CIS withholding — see the header. */
  billedNet: number;
  /** Σ bill GROSS (net + VAT) — what the supplier has invoiced you. */
  billedGross: number;
  /** Σ live allocations — bill value actually settled. */
  settled: number;
  /** Σ per-bill remaining, each capped at its own bill (see the note below). */
  outstanding: number;
  /** Σ live gross_amount — total settled by payments, allocated or not. */
  grossPaid: number;
  /** Σ live cis_withheld — HMRC liability, NOT a saving. */
  cisWithheld: number;
  /** Σ live net_paid — cash that actually left the bank. */
  netCash: number;
  /** grossPaid − settled: paid on account, not yet matched to a bill. */
  unallocated: number;
  counts: {
    bills: number;
    payments: number;
    voidedPayments: number;
    unpaidBills: number;
  };
};

/**
 * The five numbers the supplier page shows, plus the two the UI needs to be
 * honest about (unallocated cash on account, voided payments).
 *
 * `outstanding` is Σ of each bill's OWN remaining balance, not
 * `billedGross − settled`. Over-settling one bill must never appear to pay down
 * another — the identical defect `computeCommercialCash` exists to fix on the
 * money-in side. `grossPaid` stays the true settled total even when it exceeds
 * what any bill could absorb.
 *
 * Voided payments contribute NOTHING to any figure: they are excluded from
 * cash, from withholding and from settlement, and surface only as a count.
 */
export function computeSupplierPosition(input: {
  bills: SupplierBillRow[];
  payments: SupplierPaymentRow[];
  allocations: SupplierAllocationRow[];
}): SupplierPosition {
  const settlements = computeBillSettlements(input);
  const livePayments = input.payments.filter(isLivePayment);

  const billedNet = sumMoney(input.bills.map((b) => b.amount));
  const billedGross = round2(billedNet + sumMoney(input.bills.map((b) => b.vat_total)));
  const settled = sumMoney(settlements.map((s) => s.settled));
  const outstanding = sumMoney(settlements.map((s) => s.outstanding));

  const grossPaid = sumMoney(livePayments.map((p) => p.gross_amount));
  const cisWithheld = sumMoney(livePayments.map((p) => p.cis_withheld));
  const netCash = sumMoney(livePayments.map((p) => p.net_paid));

  return {
    billedNet,
    billedGross,
    settled,
    outstanding,
    grossPaid,
    cisWithheld,
    netCash,
    unallocated: round2(Math.max(0, grossPaid - settled)),
    counts: {
      bills: input.bills.length,
      payments: livePayments.length,
      voidedPayments: input.payments.length - livePayments.length,
      unpaidBills: settlements.filter((s) => s.status !== "paid").length,
    },
  };
}

// ---------------------------------------------------------------------------
// 4 — validating a proposed payment
// ---------------------------------------------------------------------------

export type DraftAllocation = {
  financeId: string;
  amount: number | string | null;
};

export type SupplierPaymentDraft = {
  grossAmount: number | string | null;
  cisWithheld: number | string | null;
  allocations: DraftAllocation[];
};

export type DraftValidation = {
  ok: boolean;
  /** Operator-facing messages, most important first. Empty when ok. */
  errors: string[];
  /** round2(gross). */
  gross: number;
  /** round2(withheld). */
  withheld: number;
  /** gross − withheld — the cash that will leave the bank. */
  net: number;
  /** Σ allocations. */
  allocated: number;
  /** gross − allocated, never negative — payment left on account. */
  unallocated: number;
};

/**
 * Check a proposed payment BEFORE it reaches the database.
 *
 * This is a courtesy, never the control: every rule below is independently
 * enforced by a CHECK, a composite FK or the FOR UPDATE-locked guard trigger,
 * and those hold for direct PostgREST callers that never run this code. The
 * value here is a precise, human message instead of a raw constraint name.
 *
 * `outstandingByBill` is the remaining balance per bill (from
 * `computeBillSettlements`). A bill missing from the map is treated as
 * unknown — which is itself an error, because a payment may only settle bills
 * belonging to this same supplier.
 */
export function validateSupplierPaymentDraft(
  draft: SupplierPaymentDraft,
  outstandingByBill: Map<string, number>,
): DraftValidation {
  const errors: string[] = [];

  const gross = round2(toPounds(draft.grossAmount));
  const withheld = round2(toPounds(draft.cisWithheld));
  const net = round2(gross - withheld);
  const allocated = sumMoney(draft.allocations.map((a) => a.amount));
  const unallocated = round2(Math.max(0, gross - allocated));

  if (gross < 0) errors.push("The payment amount can't be negative.");
  if (withheld < 0) errors.push("CIS withheld can't be negative.");
  if (withheld > gross + ALLOCATION_TOLERANCE) {
    errors.push(
      `You can't withhold ${withheld.toFixed(2)} from a payment of ${gross.toFixed(2)}.`,
    );
  }

  const seen = new Set<string>();
  for (const line of draft.allocations) {
    const amount = round2(toPounds(line.amount));
    if (amount <= 0) {
      errors.push("Every bill you're paying needs an amount greater than zero.");
      continue;
    }
    if (seen.has(line.financeId)) {
      errors.push("The same bill is listed twice — combine it into one line.");
      continue;
    }
    seen.add(line.financeId);

    const remaining = outstandingByBill.get(line.financeId);
    if (remaining === undefined) {
      errors.push("One of the bills isn't an open bill for this supplier.");
      continue;
    }
    if (amount > remaining + ALLOCATION_TOLERANCE) {
      errors.push(
        `You can't pay ${amount.toFixed(2)} against a bill with ` +
          `${remaining.toFixed(2)} outstanding.`,
      );
    }
  }

  if (allocated > gross + ALLOCATION_TOLERANCE) {
    errors.push(
      `You've allocated ${allocated.toFixed(2)} of a ${gross.toFixed(2)} payment. ` +
        "Reduce a line.",
    );
  }

  // De-duplicate repeated messages (e.g. three zero-amount lines).
  const unique = [...new Set(errors)];
  return { ok: unique.length === 0, errors: unique, gross, withheld, net, allocated, unallocated };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const BILL_SETTLEMENT_STATUS_LABEL: Record<BillSettlementStatus, string> = {
  unpaid: "Unpaid",
  part_paid: "Part paid",
  paid: "Paid",
  over_paid: "Over-paid",
};

/** Matches the house palette used by PO_BILL_STATUS_CLASS / payments. */
export const BILL_SETTLEMENT_STATUS_CLASS: Record<BillSettlementStatus, string> = {
  unpaid: "bg-slate-100 text-slate-700",
  part_paid: "bg-amber-100 text-amber-800",
  paid: "bg-green-100 text-green-800",
  over_paid: "bg-red-100 text-red-800",
};

export function isSupplierPaymentMethod(v: unknown): v is SupplierPaymentMethod {
  return typeof v === "string" && (SUPPLIER_PAYMENT_METHODS as readonly string[]).includes(v);
}
