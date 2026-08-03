/**
 * Accounting push — the PURE provider-payload builders.
 *
 * The canonical row (lib/integrations/accounting/canonical.ts) is the one place
 * the money split + status are decided. These functions are the credential-free,
 * network-free edge that projects canonical rows into each provider's request
 * body — the exact twin of csv.ts, but for the Xero / QuickBooks JSON APIs
 * instead of a spreadsheet. Keeping them pure (no `fetch`, no clock, no env)
 * means the request SHAPE is exhaustively unit-testable without a live provider.
 *
 * WHY NUMBERS, NOT THE 2dp STRINGS. Canonical amounts are fixed 2-decimal
 * strings (the CSV/pence representation). The JSON APIs want numeric amounts, so
 * each builder coerces via `Number(...)`; canonical guarantees a finite "0.00"
 * for a bad row, so this never emits NaN.
 */

import type { CanonicalAccountingRow } from "./canonical";

function amount(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Xero ─────────────────────────────────────────────────────────────────────

/**
 * Xero Accounting API `POST /Invoices` body. An accounts-receivable (`ACCREC`)
 * sales invoice per canonical invoice row. Xero resolves the Contact BY NAME
 * (creating it when absent), so no customer-id pre-resolution is needed — this
 * is what lets Xero be activation-ready on credentials alone. `LineAmountTypes`
 * is `Exclusive` because canonical `net` is the ex-VAT subtotal and `vat` the
 * tax; the single line carries both so Xero's gross matches canonical `gross`.
 */
export function buildXeroInvoicesBody(
  rows: readonly CanonicalAccountingRow[],
): { Invoices: unknown[] } {
  return {
    Invoices: rows.map((r) => ({
      Type: "ACCREC",
      Contact: { Name: r.customer || "Unknown customer" },
      Date: r.date,
      InvoiceNumber: r.invoice_number,
      Reference: r.invoice_number,
      Status: "AUTHORISED",
      LineAmountTypes: "Exclusive",
      LineItems: [
        {
          Description: r.invoice_number
            ? `Invoice ${r.invoice_number}`
            : "Sales invoice",
          Quantity: 1,
          UnitAmount: amount(r.net || r.gross),
          TaxAmount: amount(r.vat),
        },
      ],
    })),
  };
}

/**
 * Xero Accounting API `POST /Payments` body. A cash receipt per canonical
 * payment row, applied to its invoice BY InvoiceNumber (the reference canonical
 * carries). `Account.Code` is the bank account the receipt lands in; Xero
 * requires an account, so the caller supplies the configured bank code.
 */
export function buildXeroPaymentsBody(
  rows: readonly CanonicalAccountingRow[],
  bankAccountCode: string,
): { Payments: unknown[] } {
  return {
    Payments: rows.map((r) => ({
      Invoice: { InvoiceNumber: r.invoice_number },
      Account: { Code: bankAccountCode },
      Date: r.date,
      Amount: amount(r.gross),
    })),
  };
}

// ── QuickBooks Online ────────────────────────────────────────────────────────

/**
 * QBO `POST /invoice` body for ONE canonical invoice row. Unlike Xero, QBO
 * cannot resolve a customer or an item inline by name — both must be existing
 * entity ids — so the caller resolves them first and passes them in. `DocNumber`
 * carries the CrewFlow invoice number so a re-push is detectable and the payment
 * link can find the invoice again.
 */
export function buildQboInvoiceBody(
  row: CanonicalAccountingRow,
  refs: { customerId: string; itemId: string },
): Record<string, unknown> {
  const net = amount(row.net || row.gross);
  const vat = amount(row.vat);
  return {
    DocNumber: row.invoice_number,
    TxnDate: row.date,
    CustomerRef: { value: refs.customerId },
    Line: [
      {
        DetailType: "SalesItemLineDetail",
        Amount: net,
        Description: row.invoice_number
          ? `Invoice ${row.invoice_number}`
          : "Sales invoice",
        SalesItemLineDetail: { ItemRef: { value: refs.itemId } },
      },
    ],
    // Canonical splits VAT out; QBO carries it as a global tax on the txn.
    TxnTaxDetail: vat > 0 ? { TotalTax: vat } : undefined,
  };
}

/**
 * QBO `POST /payment` body for ONE canonical payment row. Links to the invoice
 * (by QBO invoice id) when the caller resolved one; otherwise records an
 * unapplied customer payment (still an honest receipt, applied later in QBO).
 */
export function buildQboPaymentBody(
  row: CanonicalAccountingRow,
  refs: { customerId: string; invoiceId?: string | null },
): Record<string, unknown> {
  const total = amount(row.gross);
  const body: Record<string, unknown> = {
    TxnDate: row.date,
    TotalAmt: total,
    CustomerRef: { value: refs.customerId },
  };
  if (refs.invoiceId) {
    body.Line = [
      {
        Amount: total,
        LinkedTxn: [{ TxnId: refs.invoiceId, TxnType: "Invoice" }],
      },
    ];
  }
  return body;
}
