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

/**
 * The same preference order, for the customer's DISPLAY contact fields.
 *
 * Every surface that PRINTS or ACTS ON the invoice's customer (the PDF BILL TO
 * line, the detail page's "send" recipient, CSV/accounting exports, the bank
 * reconcile screen) must resolve the name/email exactly the way the id resolves:
 * the invoice's OWN joined customer first, the source quote's customer only as a
 * legacy-orphan fallback.
 *
 * This closes the display half of the class fixed for filter/ownership reads in
 * C51/C52. A stage/progress-billing invoice (generate_stage_invoice, migration
 * 20261039000000) is ALWAYS quote_id NULL with customer_id set, so a read that
 * resolved the name/email through the quote alone printed a "—" addressee and
 * reported "no recipient" for 100% of stage invoices — a legally/financially
 * defective document. The same happened to any quote-derived invoice whose quote
 * was later deleted (quote_id is ON DELETE SET NULL).
 *
 * Callers must join the DIRECT customer via the composite FK
 * (`customer:customers!invoices_customer_org_fkey ( name, email )`) so
 * `inv.customer` is populated; the quote embed remains only as the fallback.
 */
export type InvoiceCustomerContactShape = {
  customer?: { name?: string | null; email?: string | null } | null;
  quote?: { customer?: { name?: string | null; email?: string | null } | null } | null;
};

/** The invoice's customer name — direct join first, quote fallback. */
export function invoiceCustomerName(inv: InvoiceCustomerContactShape): string | null {
  return inv.customer?.name ?? inv.quote?.customer?.name ?? null;
}

/** The invoice's customer email — direct join first, quote fallback. */
export function invoiceCustomerEmail(inv: InvoiceCustomerContactShape): string | null {
  return inv.customer?.email ?? inv.quote?.customer?.email ?? null;
}
