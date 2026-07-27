import { round2, toPounds } from "@/lib/money";
import { invoiceBusinessToday, isInvoiceOverdue } from "@/lib/invoices/overdue";

/**
 * H2-CASH M2 — customer-facing payments summary (PURE, customer-safe).
 *
 * Derived only from the customer's own invoices + their ledger paid amounts —
 * NEVER from costs, margins, internal notes or other customers' data. Reuses the
 * one overdue authority (lib/invoices/overdue). Deposit/stage invoices (quote_id
 * NULL, customer_id set) are ordinary invoices here, so they're included.
 */

export interface PortalInvoiceLite {
  status: string;
  total: number | string | null;
  due_date: string | null;
  /** Σ invoice_payments.amount for this invoice. */
  paid: number;
}

export interface PortalPaymentsSummary {
  /** Σ paid across the customer's non-draft invoices. */
  paidToDate: number;
  /** Σ outstanding (total − paid) still owed. */
  dueNow: number;
  /** Portion of dueNow on invoices past their due date. */
  overdue: number;
}

export function computePortalPayments(invoices: PortalInvoiceLite[], now: Date = new Date()): PortalPaymentsSummary {
  const todayIso = invoiceBusinessToday(now);
  let paidToDate = 0;
  let dueNow = 0;
  let overdue = 0;
  for (const inv of invoices) {
    if (inv.status === "draft") continue; // not issued to the customer
    const total = toPounds(inv.total);
    const paid = round2(toPounds(inv.paid));
    paidToDate = round2(paidToDate + paid);
    const remaining = round2(Math.max(0, total - paid));
    if (remaining <= 0) continue;
    dueNow = round2(dueNow + remaining);
    if (isInvoiceOverdue({ status: inv.status, due_date: inv.due_date }, todayIso)) {
      overdue = round2(overdue + remaining);
    }
  }
  return { paidToDate, dueNow, overdue };
}
