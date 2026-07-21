import { round2, sumMoney, toPounds } from "@/lib/money";
import { invoiceBusinessToday, isInvoiceOverdue } from "@/lib/invoices/overdue";

/**
 * Unified commercial cash position (Programme D) — the owner's real answer to
 * "how much money is still coming to me on this job, and how much is late?".
 *
 * PURE aggregation. It reuses the Programme B contract taxonomy (original +
 * approved variations = revised) but derives **cash from the payment ledger**,
 * not from invoice status — fixing a real defect: `computeJobCommercialPosition`
 * counts a `partially_paid` invoice's FULL total as paid, so a £20k invoice with
 * £5k received reads as £0 outstanding. Here `received` is Σ of the actual
 * `invoice_payments` allocated to THIS job's invoices (exactly what the customer
 * portal already shows), so `outstanding` is the true debtor figure.
 *
 * Security note (F2): a real-world receipt can be split across invoices of
 * different jobs/customers. This function only ever counts payments whose
 * `invoice_id` belongs to THIS job (the `jobInvoiceIds` guard) — it never sums a
 * parent receipt total. That keeps another job's/customer's money off this
 * job's figures.
 *
 * Cash rows are GROSS (VAT-inclusive) because that is what moves through the
 * bank. Cost/profit/retention (internal, ex-VAT) live in the separate cost
 * composer so a customer-safe projection never has to redact them.
 */

export type CashQuote = {
  status: string;
  total: number | string | null;
  variation_number: number | null;
};

export type CashInvoice = {
  id: string;
  status: string;
  total: number | string | null;
  due_date: string | null;
};

/** An `invoice_payments` allocation row for one of this job's invoices. */
export type CashPayment = {
  invoice_id: string;
  amount: number | string | null;
};

export type CommercialCashPosition = {
  /** Accepted base quote(s) — the original agreed value, never overwritten. */
  original: number;
  /** Σ accepted variations — approved scope changes. */
  approvedVariations: number;
  /** original + approvedVariations — the current contract sum. */
  revised: number;
  /** Variations sent/viewed, not yet decided (shown, never in `revised`). */
  pendingVariations: number;
  /** Σ non-draft invoice totals — certified/billed to date (gross). */
  billed: number;
  /** Σ real payments allocated to this job's invoices — cash in (gross). */
  received: number;
  /** billed − received — the true outstanding debtor (never negative). */
  outstanding: number;
  /** Portion of `outstanding` on invoices past their due date. */
  overdue: number;
  /** revised − billed — work agreed but not yet invoiced (never negative). */
  stillToBill: number;
  counts: {
    approvedVariations: number;
    pendingVariations: number;
    overdueInvoices: number;
  };
};

const ACCEPTED = "accepted";
const PENDING = new Set(["sent", "viewed"]);
const INVOICE_RAISED = new Set([
  "sent",
  "awaiting_payment",
  "partially_paid",
  "paid",
  "overdue",
]);

export function computeCommercialCash(input: {
  quotes: CashQuote[];
  invoices: CashInvoice[];
  payments: CashPayment[];
  now?: Date;
}): CommercialCashPosition {
  const todayIso = invoiceBusinessToday(input.now ?? new Date());

  // Contract — reuse the Programme B rules exactly (approved is firm; pending
  // is shown but never folded into the revised value).
  const base = input.quotes.filter((q) => q.variation_number == null && q.status === ACCEPTED);
  const acceptedVars = input.quotes.filter((q) => q.variation_number != null && q.status === ACCEPTED);
  const pendingVars = input.quotes.filter((q) => q.variation_number != null && PENDING.has(q.status));

  const original = sumMoney(base.map((q) => q.total));
  const approvedVariations = sumMoney(acceptedVars.map((q) => q.total));
  const revised = round2(original + approvedVariations);
  const pendingVariations = sumMoney(pendingVars.map((q) => q.total));

  // Billing.
  const raised = input.invoices.filter((i) => INVOICE_RAISED.has(i.status));
  const billed = sumMoney(raised.map((i) => i.total));

  // Cash from the ledger. Only this job's invoices count (F2), and payments are
  // bucketed once by invoice_id to avoid an O(invoices × payments) scan.
  const jobInvoiceIds = new Set(input.invoices.map((i) => i.id));
  const paidByInvoice = new Map<string, number>();
  for (const p of input.payments) {
    if (!jobInvoiceIds.has(p.invoice_id)) continue;
    paidByInvoice.set(
      p.invoice_id,
      round2((paidByInvoice.get(p.invoice_id) ?? 0) + toPounds(p.amount)),
    );
  }
  const received = round2(
    [...paidByInvoice.values()].reduce((s, v) => round2(s + v), 0),
  );
  const outstanding = round2(Math.max(0, billed - received));

  // Overdue = Σ per-invoice remaining balance on invoices past due.
  let overdue = 0;
  let overdueInvoices = 0;
  for (const inv of raised) {
    if (!isInvoiceOverdue({ due_date: inv.due_date, status: inv.status }, todayIso)) continue;
    const invBalance = round2(Math.max(0, toPounds(inv.total) - (paidByInvoice.get(inv.id) ?? 0)));
    if (invBalance > 0) {
      overdue = round2(overdue + invBalance);
      overdueInvoices += 1;
    }
  }

  return {
    original,
    approvedVariations,
    revised,
    pendingVariations,
    billed,
    received,
    outstanding,
    overdue,
    stillToBill: round2(Math.max(0, revised - billed)),
    counts: {
      approvedVariations: acceptedVars.length,
      pendingVariations: pendingVars.length,
      overdueInvoices,
    },
  };
}

/** Does the job have any commercial cash story worth surfacing? */
export function hasCommercialCash(p: CommercialCashPosition): boolean {
  return (
    p.original > 0 ||
    p.approvedVariations > 0 ||
    p.pendingVariations > 0 ||
    p.billed > 0 ||
    p.received > 0
  );
}
