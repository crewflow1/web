import { round2, toPounds } from "@/lib/money";
import { invoiceBusinessToday, invoiceDaysOverdue, isInvoiceOverdue } from "@/lib/invoices/overdue";

/**
 * H2-CASH M2 — org-wide cash visibility, PURE.
 *
 * Aggregates the SAME per-invoice truth the job-level cash authority uses
 * (`remaining = total − Σ payments`, overdue via `lib/invoices/overdue`) across
 * every job, and buckets it by due date. It introduces NO new outstanding
 * formula — retention totals come from `computeRetentionDueRollup` and
 * ready-to-invoice from the billing plans, both passed in by the service. Every
 * £ traces to the ledger.
 */

const DAY_MS = 86_400_000;

/** One invoice with its ledger-derived paid amount + a drill-down label. */
export interface OrgCashInvoice {
  id: string;
  number: string | null;
  status: string;
  total: number | string | null;
  due_date: string | null;
  /** Σ invoice_payments.amount for this invoice (the ledger, not the status). */
  paid: number;
  jobId: string | null;
  jobLabel: string | null;
}

export interface OrgCashSummary {
  /** Σ per-invoice remaining (total − paid), never negative — the debtor book. */
  owedNow: number;
  /** Σ remaining on invoices past their due date (the overdue authority). */
  overdue: number;
  /** Σ remaining due within the next 7 days (excl. already-overdue). */
  dueThisWeek: number;
  /** Σ remaining due within this calendar month (excl. already-overdue). */
  dueThisMonth: number;
  /** Retention held (ex-VAT) — from computeRetentionDueRollup. */
  retentionHeld: number;
  /** Retention past its release date — from computeRetentionDueRollup. */
  retentionDueNow: number;
  /** owedNow − retentionHeld, floored at 0 — the true chase-now figure. */
  collectableNow: number;
  /** Σ planned (un-invoiced) billing-stage net — work ready to bill. */
  readyToInvoice: number;
  overdueCount: number;
  invoiceCount: number;
}

/** Remaining owed on one invoice — the one rule (total − paid), never negative. */
export function invoiceRemaining(inv: Pick<OrgCashInvoice, "total" | "paid">): number {
  return round2(Math.max(0, toPounds(inv.total) - round2(toPounds(inv.paid))));
}

const COLLECTABLE = new Set(["sent", "awaiting_payment", "partially_paid", "overdue"]);

function endOfMonthIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

export function computeOrgCashSummary(input: {
  invoices: OrgCashInvoice[];
  retentionHeld: number;
  retentionDueNow: number;
  readyToInvoice: number;
  now?: Date;
}): OrgCashSummary {
  const now = input.now ?? new Date();
  const todayIso = invoiceBusinessToday(now);
  const weekEndIso = new Date(now.getTime() + 7 * DAY_MS).toISOString().slice(0, 10);
  const monthEndIso = endOfMonthIso(now);

  let owedNow = 0, overdue = 0, dueThisWeek = 0, dueThisMonth = 0, overdueCount = 0, invoiceCount = 0;
  for (const inv of input.invoices) {
    if (!COLLECTABLE.has(inv.status)) continue;
    const remaining = invoiceRemaining(inv);
    if (remaining <= 0) continue;
    invoiceCount += 1;
    owedNow = round2(owedNow + remaining);
    if (isInvoiceOverdue({ status: inv.status, due_date: inv.due_date }, todayIso)) {
      overdue = round2(overdue + remaining);
      overdueCount += 1;
      continue; // overdue is not also "due soon"
    }
    if (inv.due_date && inv.due_date <= weekEndIso) dueThisWeek = round2(dueThisWeek + remaining);
    if (inv.due_date && inv.due_date <= monthEndIso) dueThisMonth = round2(dueThisMonth + remaining);
  }

  const retentionHeld = round2(Math.max(0, toPounds(input.retentionHeld)));
  return {
    owedNow,
    overdue,
    dueThisWeek,
    dueThisMonth,
    retentionHeld,
    retentionDueNow: round2(Math.max(0, toPounds(input.retentionDueNow))),
    collectableNow: round2(Math.max(0, owedNow - retentionHeld)),
    readyToInvoice: round2(Math.max(0, toPounds(input.readyToInvoice))),
    overdueCount,
    invoiceCount,
  };
}

/** An actionable row in a cash queue. */
export interface CashQueueItem {
  id: string;
  number: string | null;
  jobLabel: string | null;
  remaining: number;
  total: number;
  daysOverdue: number | null;
  dueDate: string | null;
  href: string;
}

/**
 * The actionable queues an owner works from: overdue (most late first), due-soon
 * (next 7 days), and part-paid (some but not all received).
 */
export function buildCashQueues(input: { invoices: OrgCashInvoice[]; now?: Date }): {
  overdue: CashQueueItem[];
  dueSoon: CashQueueItem[];
  partPaid: CashQueueItem[];
} {
  const now = input.now ?? new Date();
  const todayIso = invoiceBusinessToday(now);
  const weekEndIso = new Date(now.getTime() + 7 * DAY_MS).toISOString().slice(0, 10);
  const overdue: CashQueueItem[] = [];
  const dueSoon: CashQueueItem[] = [];
  const partPaid: CashQueueItem[] = [];

  for (const inv of input.invoices) {
    if (!COLLECTABLE.has(inv.status)) continue;
    const remaining = invoiceRemaining(inv);
    if (remaining <= 0) continue;
    const item: CashQueueItem = {
      id: inv.id,
      number: inv.number,
      jobLabel: inv.jobLabel,
      remaining,
      total: round2(toPounds(inv.total)),
      daysOverdue: invoiceDaysOverdue({ status: inv.status, due_date: inv.due_date }, todayIso),
      dueDate: inv.due_date,
      href: `/invoices/${inv.id}`,
    };
    if (item.daysOverdue != null) overdue.push(item);
    else if (inv.due_date && inv.due_date <= weekEndIso) dueSoon.push(item);
    if (round2(toPounds(inv.paid)) > 0 && remaining > 0) partPaid.push(item);
  }

  overdue.sort((a, b) => (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0) || b.remaining - a.remaining);
  dueSoon.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || b.remaining - a.remaining);
  partPaid.sort((a, b) => b.remaining - a.remaining);
  return { overdue, dueSoon, partPaid };
}
