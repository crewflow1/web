import { round2, sumMoney, toPounds } from "@/lib/money";

/**
 * Payment allocation — pure domain math (Financial Operations).
 *
 * A real-world payment (a `payments` row) is split across one or more invoices.
 * Each split is an `invoice_payments` row carrying `payment_id` — i.e. an
 * ALLOCATION. This module answers two questions the DB also enforces:
 *
 *   1. How much of a payment is still unallocated? (drives the allocation UI;
 *      the DB rejects over-allocation with a FOR UPDATE-locked guard trigger.)
 *   2. How much of an invoice is still outstanding? (drives which invoices to
 *      offer, and mirrors the invoice status trigger's paid/partial logic.)
 *
 * All arithmetic goes through `lib/money` so rounding matches the DB
 * (numeric(12,2)) and the rest of the app. A small tolerance absorbs the last
 * penny of float noise — the same 0.005 the guard trigger allows.
 */

/** Half a penny — below the resolution of numeric(12,2), so float-safe. */
export const ALLOCATION_TOLERANCE = 0.005;

export type PaymentAllocationStatus =
  | "unallocated"
  | "part_allocated"
  | "fully_allocated"
  | "over_allocated";

export type PaymentAllocationPosition = {
  /** The payment's total value (£). */
  paymentAmount: number;
  /** Sum of allocations made from this payment (£). */
  allocated: number;
  /** Still available to allocate; never negative (£). */
  unallocated: number;
  /** Number of allocation rows. */
  count: number;
  status: PaymentAllocationStatus;
};

/**
 * Where a payment stands relative to its allocations.
 *
 * `over_allocated` should never persist — the DB guard rejects it — but the
 * status is modelled so the UI can render a rejected attempt coherently.
 */
export function computePaymentAllocation(input: {
  paymentAmount: number | string | null | undefined;
  allocations: Array<{ amount: number | string | null | undefined }>;
}): PaymentAllocationPosition {
  const paymentAmount = round2(toPounds(input.paymentAmount));
  const allocated = round2(sumMoney(input.allocations.map((a) => a.amount)));
  const unallocated = round2(Math.max(0, paymentAmount - allocated));

  let status: PaymentAllocationStatus;
  if (allocated > paymentAmount + ALLOCATION_TOLERANCE) {
    status = "over_allocated";
  } else if (allocated <= ALLOCATION_TOLERANCE) {
    status = "unallocated";
  } else if (allocated >= paymentAmount - ALLOCATION_TOLERANCE) {
    status = "fully_allocated";
  } else {
    status = "part_allocated";
  }

  return {
    paymentAmount,
    allocated,
    unallocated,
    count: input.allocations.length,
    status,
  };
}

export type InvoiceBalanceStatus = "unpaid" | "part_paid" | "paid" | "over_paid";

export type InvoiceBalance = {
  invoiceTotal: number;
  paid: number;
  /** Still owed; never negative (£). */
  outstanding: number;
  status: InvoiceBalanceStatus;
};

/**
 * An invoice's balance from the sum of its payments (allocated or standalone).
 * Mirrors `_tg_invoice_payments_sync_status`: paid when sum ≥ total, part-paid
 * when 0 < sum < total. Over-payment is allowed (deposits/credit) and capped to
 * a zero outstanding.
 */
export function computeInvoiceBalance(input: {
  invoiceTotal: number | string | null | undefined;
  payments: Array<{ amount: number | string | null | undefined }>;
}): InvoiceBalance {
  const invoiceTotal = round2(toPounds(input.invoiceTotal));
  const paid = round2(sumMoney(input.payments.map((p) => p.amount)));
  const outstanding = round2(Math.max(0, invoiceTotal - paid));

  let status: InvoiceBalanceStatus;
  if (paid <= ALLOCATION_TOLERANCE) {
    status = "unpaid";
  } else if (paid > invoiceTotal + ALLOCATION_TOLERANCE) {
    status = "over_paid";
  } else if (paid >= invoiceTotal - ALLOCATION_TOLERANCE) {
    status = "paid";
  } else {
    status = "part_paid";
  }

  return { invoiceTotal, paid, outstanding, status };
}

export const PAYMENT_ALLOCATION_STATUS_LABEL: Record<PaymentAllocationStatus, string> = {
  unallocated: "Unallocated",
  part_allocated: "Part allocated",
  fully_allocated: "Fully allocated",
  over_allocated: "Over-allocated",
};

export const PAYMENT_ALLOCATION_STATUS_CLASS: Record<PaymentAllocationStatus, string> = {
  unallocated: "bg-amber-100 text-amber-700",
  part_allocated: "bg-blue-100 text-blue-700",
  fully_allocated: "bg-emerald-100 text-emerald-700",
  over_allocated: "bg-red-100 text-red-700",
};
