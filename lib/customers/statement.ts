import { round2, toPounds } from "@/lib/money";
import { isIssuedStatus } from "@/lib/invoices/schema";

/**
 * THE customer statement-of-account generator — PURE, server/client-safe.
 *
 * A statement of account is the running-ledger view a customer is handed or
 * sent: every issued invoice as a CHARGE, every payment received as a CREDIT,
 * in date order, with an opening balance, a running balance after each line,
 * and a closing balance. It answers "what has this account done, and what is
 * owed as at a date" — a different question from the receivables authorities:
 *
 *   - `computeReceivables` / `invoiceRemaining` FLOOR each invoice at £0 and
 *     count only OUTSTANDING statuses — the debtor book, "how much are we owed
 *     right now". A statement instead shows the TRUE ledger movement, so an
 *     overpayment legitimately drives the balance NEGATIVE (a credit balance)
 *     and a fully-settled account nets to £0 through its charges and credits.
 *
 * This is deliberately NOT re-implemented against the DB: it consumes the exact
 * row shapes `loadCustomerFinancials` already reads (paged + loud, F-1 safe),
 * so there is one read path and this stays a hermetically testable fold.
 *
 * ── WHAT COUNTS ──────────────────────────────────────────────────────────────
 *   - INVOICES: only ISSUED ones (`isIssuedStatus` — every status but `draft`).
 *     A draft is not a document the customer has been given, so it is neither a
 *     charge on their account nor visible to them; it must never appear on a
 *     statement.
 *   - PAYMENTS: only those against an issued invoice. A charge and its
 *     settlements share one include/exclude decision, so the balance can never
 *     show a credit with no matching charge (which would net to a spurious
 *     negative opening).
 *
 * ── DATES ────────────────────────────────────────────────────────────────────
 * An invoice is placed on its document date (`created_at`, the day it was
 * raised — the same anchor the customer timeline uses; there is no separate
 * issue-date column). A payment is placed on `paid_at`. Both are reduced to a
 * YYYY-MM-DD calendar day so they compare cleanly with the range bounds, which
 * are calendar days.
 *
 * ── ORDERING (stability is load-bearing) ─────────────────────────────────────
 * Movements sort by (date, kind, sourceId): same-day CHARGES sort before
 * CREDITS (an invoice is raised before it is paid), and the row id is the final
 * unique tiebreak so two same-day, same-kind rows never swap between renders —
 * the running balance is therefore deterministic to the penny.
 *
 * ── MONEY ────────────────────────────────────────────────────────────────────
 * Pounds, 2dp, every step through `round2` — the codebase money convention.
 */

/** An issued/draft invoice as read by `loadCustomerFinancials`. */
export interface StatementInvoiceInput {
  id: string;
  number: string;
  status: string;
  total: number | string | null;
  /** ISO timestamp — the invoice's document (raised) date. */
  created_at: string;
  due_date: string | null;
}

/** A payment row as read by `loadCustomerFinancials`. */
export interface StatementPaymentInput {
  id: string;
  invoice_id: string;
  amount: number | string | null;
  /** ISO timestamp — when the money was received. */
  paid_at: string;
  reference: string | null;
}

export type StatementEntryKind = "invoice" | "payment";

export interface StatementEntry {
  kind: StatementEntryKind;
  /** YYYY-MM-DD calendar day this entry falls on. */
  date: string;
  /** Invoice number, or the payment reference (may be null). */
  reference: string | null;
  /** Human-readable line label. */
  description: string;
  /** Amount added to the balance (invoices). 0 for payments. */
  charge: number;
  /** Amount taken off the balance (payments received). 0 for invoices. */
  credit: number;
  /** Running balance owed AFTER this entry. */
  balance: number;
  /** Source row id — unique, drives React keys and the ordering tiebreak. */
  sourceId: string;
  /** Invoice status (invoice entries only). */
  status?: string;
}

export interface CustomerStatement {
  /** Normalised range bounds (YYYY-MM-DD) or null when open-ended. */
  from: string | null;
  to: string | null;
  /** Balance owed at the very start of the range (net of everything before it). */
  openingBalance: number;
  /** Balance owed at the end of the range. */
  closingBalance: number;
  /** Σ charges (issued invoice totals) falling inside the range. */
  totalCharged: number;
  /** Σ credits (payments received) falling inside the range. */
  totalCredited: number;
  /** The in-range ledger, in display order. */
  entries: StatementEntry[];
  /** Count of invoice charges inside the range. */
  invoiceCount: number;
  /** Count of payment credits inside the range. */
  paymentCount: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Trim + validate a YYYY-MM-DD bound; anything else becomes null (open-ended). */
function normaliseBound(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return DATE_RE.test(t) ? t : null;
}

/** The calendar day of an ISO timestamp (or an already-date string). */
function calendarDay(iso: string | null | undefined): string {
  return typeof iso === "string" ? iso.slice(0, 10) : "";
}

type Movement = {
  kind: StatementEntryKind;
  date: string;
  reference: string | null;
  description: string;
  charge: number;
  credit: number;
  /** charge − credit: the signed effect on the balance. */
  delta: number;
  sourceId: string;
  status?: string;
};

/** Same-day charges before credits; id the final unique tiebreak. */
const KIND_RANK: Record<StatementEntryKind, number> = { invoice: 0, payment: 1 };

/**
 * Build a customer's statement of account for an (optional) date range.
 *
 * With no range both bounds are open: the opening balance is £0 and every
 * movement is in-range. A `from` folds everything strictly before it into the
 * opening balance; a `to` drops everything strictly after it (a statement is
 * "as at" its closing date). An invalid bound (not YYYY-MM-DD) is treated as
 * absent rather than throwing.
 */
export function buildCustomerStatement(
  invoices: StatementInvoiceInput[],
  payments: StatementPaymentInput[],
  range: { from?: string | null; to?: string | null } = {},
): CustomerStatement {
  const from = normaliseBound(range.from);
  const to = normaliseBound(range.to);

  // Only issued invoices are real account activity; index them so a payment can
  // be admitted only when its parent invoice is.
  const issuedIds = new Set<string>();
  const movements: Movement[] = [];

  for (const inv of invoices) {
    if (!isIssuedStatus(inv.status)) continue;
    issuedIds.add(inv.id);
    const charge = round2(toPounds(inv.total));
    movements.push({
      kind: "invoice",
      date: calendarDay(inv.created_at),
      reference: inv.number,
      description: `Invoice ${inv.number}`,
      charge,
      credit: 0,
      delta: charge,
      sourceId: inv.id,
      status: inv.status,
    });
  }

  for (const pay of payments) {
    if (!issuedIds.has(pay.invoice_id)) continue;
    const credit = round2(toPounds(pay.amount));
    movements.push({
      kind: "payment",
      date: calendarDay(pay.paid_at),
      reference: pay.reference,
      description: pay.reference
        ? `Payment received · ${pay.reference}`
        : "Payment received",
      charge: 0,
      credit,
      delta: -credit,
      sourceId: pay.id,
    });
  }

  movements.sort(
    (a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0),
  );

  // First pass: fold pre-range movements into the opening balance; keep the
  // in-range ones. Post-range movements are dropped (a statement is "as at" to).
  let openingBalance = 0;
  const inRange: Movement[] = [];
  for (const m of movements) {
    if (from && m.date < from) {
      openingBalance = round2(openingBalance + m.delta);
      continue;
    }
    if (to && m.date > to) continue;
    inRange.push(m);
  }

  // Second pass: run the balance forward from the opening.
  let balance = openingBalance;
  let totalCharged = 0;
  let totalCredited = 0;
  let invoiceCount = 0;
  let paymentCount = 0;
  const entries: StatementEntry[] = inRange.map((m) => {
    balance = round2(balance + m.delta);
    if (m.kind === "invoice") {
      totalCharged = round2(totalCharged + m.charge);
      invoiceCount += 1;
    } else {
      totalCredited = round2(totalCredited + m.credit);
      paymentCount += 1;
    }
    return {
      kind: m.kind,
      date: m.date,
      reference: m.reference,
      description: m.description,
      charge: m.charge,
      credit: m.credit,
      balance,
      sourceId: m.sourceId,
      status: m.status,
    };
  });

  return {
    from,
    to,
    openingBalance,
    closingBalance: balance,
    totalCharged,
    totalCredited,
    entries,
    invoiceCount,
    paymentCount,
  };
}
