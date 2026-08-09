import { round2, toPounds } from "@/lib/money";
import { OUTSTANDING_STATUSES } from "@/lib/invoices/schema";
import { invoiceBusinessToday, isInvoiceOverdue } from "@/lib/invoices/overdue";

/**
 * THE receivables-netting authority — the single source of truth for every
 * OPERATOR "how much are we owed / how much is overdue" money figure.
 *
 * Two rules, applied together, and nowhere else re-implemented:
 *
 *   1. STATUS. An invoice is a receivable only while it carries a canonical
 *      OUTSTANDING status (`lib/invoices/schema.OUTSTANDING_STATUSES` =
 *      sent · awaiting_payment · partially_paid · overdue). `draft` is not yet
 *      issued and `paid` is settled — neither is owed. A hardcoded subset such
 *      as `status === "sent" || status === "overdue"` silently drops
 *      `awaiting_payment` and `partially_paid`; the payment-sync trigger stamps
 *      `partially_paid` on ANY deposit, so that subset made a £10k invoice with a
 *      £3k deposit vanish from Outstanding entirely.
 *
 *   2. NETTING. What is owed on an invoice is `max(0, total − Σ payments)`, per
 *      invoice, capped at that invoice's own total — NEVER the gross `total`.
 *      Summing gross counts a partially-paid invoice at its full face value, so
 *      a deposit is billed to the customer twice on the owner's dashboard.
 *
 * This mirrors — and shares the `invoiceRemaining` primitive with — the two
 * authorities that already net correctly: `computePortalPayments`
 * (customer portal) and `computeOrgCashSummary` (/cash). All three agree to the
 * penny on the same invoices + payments (see the cross-surface consistency test
 * in __tests__/invoices/overdue-authority.test.ts).
 *
 * PURE + server/client-safe: no imports beyond money helpers and the status
 * authorities, so every surface can share one definition.
 */

const DAY_MS = 86_400_000;

/** An invoice paired with its ledger-derived paid amount (Σ invoice_payments.amount). */
export interface ReceivableInvoice {
  status: string | null | undefined;
  total: number | string | null;
  due_date: string | null | undefined;
  /** Σ invoice_payments.amount for THIS invoice — the ledger, not the status. */
  paid: number | string | null;
}

export interface ReceivablesSummary {
  /** Σ per-invoice remaining across every OUTSTANDING invoice — the debtor book. */
  outstandingTotal: number;
  /** Count of OUTSTANDING invoices with a balance still owed. */
  outstandingCount: number;
  /** Σ remaining on OUTSTANDING invoices past their due date (a subset of outstanding). */
  overdueTotal: number;
  overdueCount: number;
  /** Σ remaining on OUTSTANDING invoices due within the next 7 days (excl. already-overdue). */
  dueThisWeekTotal: number;
  dueThisWeekCount: number;
  /**
   * Expected incoming — the whole outstanding pool. It is exactly
   * `outstandingTotal` (already net of payments); a separate field so callers
   * read intent, not a coincidence.
   */
  expectedIncoming: number;
}

/**
 * THE netting rule: remaining owed on ONE invoice = max(0, total − paid), to 2dp,
 * never negative. Capped at the invoice's own total so an overpayment on one
 * invoice can never silently pay down another (which would understate the debtor
 * and let `overdue` exceed `outstanding`).
 */
export function invoiceRemaining(inv: {
  total: number | string | null;
  paid: number | string | null;
}): number {
  return round2(Math.max(0, toPounds(inv.total) - round2(toPounds(inv.paid))));
}

/** True when the invoice carries a canonical OUTSTANDING status (operator should chase). */
export function isOutstandingStatus(status: string | null | undefined): boolean {
  return (OUTSTANDING_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * Compute every netted receivables figure for a set of invoices + their paid
 * amounts. `overdue` and `dueThisWeek` are disjoint (an overdue invoice is never
 * also counted as due-this-week), and both are subsets of `outstanding`.
 */
export function computeReceivables(
  invoices: ReceivableInvoice[],
  now: Date = new Date(),
): ReceivablesSummary {
  const todayIso = invoiceBusinessToday(now);
  const weekEndIso = new Date(now.getTime() + 7 * DAY_MS).toISOString().slice(0, 10);

  let outstandingTotal = 0;
  let outstandingCount = 0;
  let overdueTotal = 0;
  let overdueCount = 0;
  let dueThisWeekTotal = 0;
  let dueThisWeekCount = 0;

  for (const inv of invoices) {
    if (!isOutstandingStatus(inv.status)) continue;
    const remaining = invoiceRemaining(inv);
    if (remaining <= 0) continue;
    outstandingCount += 1;
    outstandingTotal = round2(outstandingTotal + remaining);
    if (isInvoiceOverdue({ status: inv.status, due_date: inv.due_date }, todayIso)) {
      overdueCount += 1;
      overdueTotal = round2(overdueTotal + remaining);
      continue; // overdue is not also "due this week"
    }
    if (inv.due_date && inv.due_date >= todayIso && inv.due_date <= weekEndIso) {
      dueThisWeekCount += 1;
      dueThisWeekTotal = round2(dueThisWeekTotal + remaining);
    }
  }

  return {
    outstandingTotal,
    outstandingCount,
    overdueTotal,
    overdueCount,
    dueThisWeekTotal,
    dueThisWeekCount,
    expectedIncoming: outstandingTotal,
  };
}
