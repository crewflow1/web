import type { InvoiceStatus } from "./schema";

/**
 * The canonical overdue authority.
 *
 * "Overdue" is DERIVED, never stored. Before this module it was both at once:
 * a stored enum value two paths could write (the status buttons and CSV
 * import), and a derived condition two surfaces computed differently —
 * `due_date < today` on the dashboard, `sent_at + 30d` in the AI aggregates.
 * Nothing kept the stored value current, so the dashboard tile counted one
 * population while `/invoices?status=overdue` filtered another, and they
 * coincided only by accident.
 *
 * Server/client-safe: pure functions, no imports beyond the status type, so
 * every surface can share one definition (mirrors ./due-date.ts).
 *
 * ---------------------------------------------------------------------------
 * The definition
 * ---------------------------------------------------------------------------
 * An invoice is overdue when ALL hold:
 *   1. it has a due date            — no due date, no deadline to miss;
 *   2. that date is before today    — `due_date` is the time authority, NOT
 *                                     `sent_at + 30d` (30 days after sending
 *                                     is not "overdue" under 60-day terms);
 *   3. a balance is still owed      — see below;
 *   4. it is collectable at all     — not draft, not settled.
 *
 * Balance: `status` IS the balance authority, not a second calculation.
 * `_tg_invoice_payments_sync_status` owns it — it sets `paid` when payments
 * reach the total and `partially_paid` while 0 < paid < total. So `paid`
 * means settled and every other collectable status means money is still owed.
 * Re-summing `invoice_payments` here would be a second, divergent source of
 * truth for a fact the database already maintains — exactly the mistake this
 * module exists to end.
 *
 * Terminal / non-collectable:
 *   - `draft` — never issued, so nothing is owed yet.
 *   - `paid`  — settled.
 * There is no `void` status in this schema (the enum is draft, sent,
 * awaiting_payment, partially_paid, paid, overdue — verified against the live
 * database). If one is ever added it belongs in NON_COLLECTABLE below.
 *
 * ---------------------------------------------------------------------------
 * The legacy `overdue` value
 * ---------------------------------------------------------------------------
 * `overdue` remains in the enum and stays in COLLECTABLE_STATUSES. It is a
 * TRANSITIONAL state: new writes are prevented at every application path, but
 * the value is not dropped from the database, because dropping an enum member
 * is irreversible and old rows could carry it. Treating a legacy stored
 * `overdue` as collectable is the safe reading — such an invoice was unpaid
 * when it was marked, so it is judged on its due date like any other. Once no
 * stored rows carry it, the enum member can be retired separately.
 */

/**
 * Statuses where money is still owed and therefore a deadline can be missed.
 *
 * Use for DB-level filters so a query returns exactly the population the pure
 * predicate would accept, e.g.
 *   .in("status", OVERDUE_COLLECTABLE_STATUSES).lt("due_date", todayIso)
 */
export const OVERDUE_COLLECTABLE_STATUSES = [
  "sent",
  "awaiting_payment",
  "partially_paid",
  // Legacy stored value — see the header. Never written any more, still read.
  "overdue",
] as const satisfies readonly InvoiceStatus[];

/** Statuses that can never be overdue: not issued, or already settled. */
export const OVERDUE_NON_COLLECTABLE_STATUSES = [
  "draft",
  "paid",
  // Terminal correction state (20261219): a voided invoice is not owed and can
  // never become overdue. Joins the non-collectable side so collectable +
  // non-collectable still partition the enum exactly.
  "void",
] as const satisfies readonly InvoiceStatus[];

/** The minimum an invoice must expose to be judged. */
export type OverdueJudgeable = {
  status: string | null | undefined;
  due_date: string | null | undefined;
};

/** Today as `YYYY-MM-DD`. `due_date` is a Postgres `date`, so compare calendar days. */
export function invoiceBusinessToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** True when a balance is still owed and the invoice can be chased. */
export function isCollectableStatus(status: string | null | undefined): boolean {
  return (OVERDUE_COLLECTABLE_STATUSES as readonly string[]).includes(
    status ?? "",
  );
}

/**
 * THE authority. Every surface must use this rather than re-deriving.
 *
 * Degrades safely: a missing due date, a missing status, or an unknown status
 * all return false — an invoice is never called overdue on incomplete facts.
 */
export function isInvoiceOverdue(
  invoice: OverdueJudgeable,
  todayIso: string,
): boolean {
  if (!invoice.due_date) return false;
  if (!isCollectableStatus(invoice.status)) return false;
  return invoice.due_date < todayIso;
}

/**
 * The status a human should be shown.
 *
 * Stored status stays the record; `overdue` is layered on top when the derived
 * predicate holds. This is what makes a 60-day-late invoice stop reading as
 * "sent" without anything writing to the database.
 */
export function invoiceDisplayStatus(
  invoice: OverdueJudgeable,
  todayIso: string,
): InvoiceStatus {
  if (isInvoiceOverdue(invoice, todayIso)) return "overdue";
  return (invoice.status ?? "draft") as InvoiceStatus;
}

/**
 * Whole days past the due date, or null when not overdue.
 *
 * Measured from `due_date` — the deadline actually missed. The AI aggregates
 * previously measured from `sent_at`, which answers a different question.
 */
export function invoiceDaysOverdue(
  invoice: OverdueJudgeable,
  todayIso: string,
): number | null {
  if (!isInvoiceOverdue(invoice, todayIso)) return null;
  const due = Date.parse(`${invoice.due_date}T00:00:00Z`);
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(today)) return null;
  return Math.max(0, Math.round((today - due) / 86_400_000));
}
