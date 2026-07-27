/**
 * The one authoritative "who is this invoice's customer" resolver.
 *
 * Issue #349 Phase 1 denormalised customer onto invoices, so an invoice now
 * carries its customer directly (invoices.customer_id) instead of only reaching
 * one through its quote (quote -> customer, where quote_id is ON DELETE SET
 * NULL). Every surface that needs the invoice's customer must resolve it THE
 * SAME WAY, so this preference lives here and nowhere else:
 *
 *   1. the invoice's own customer_id      — authoritative; survives quote loss;
 *   2. else the source quote's customer   — fallback for a legacy orphan whose
 *                                           customer_id was never backfilled
 *                                           (its quote was already gone).
 *
 * Server/client-safe: a pure accessor over already-loaded fields, no I/O.
 */

export type InvoiceCustomerShape = {
  customer_id?: string | null;
  quote?: { customer_id?: string | null } | null;
};

/** The invoice's customer id — direct column first, quote fallback. */
export function invoiceCustomerId(inv: InvoiceCustomerShape): string | null {
  return inv.customer_id ?? inv.quote?.customer_id ?? null;
}
