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

import { effectiveVatRate, type CanonicalAccountingRow } from "./canonical";

function amount(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── VAT tax-code mappings (rate → each provider's own code) ───────────────────

/**
 * Xero Accounting-API system TaxType code for a UK SALES (output) line, keyed by
 * the line's effective VAT rate. Xero honours a manually-supplied `TaxAmount`
 * ONLY when a `TaxType` is present; without one it silently recalculates tax from
 * the account's default rate, so a 0% / 5% / exempt invoice would post the wrong
 * gross. These are Xero's UK system OUTPUT codes; the mapping mirrors the shipped
 * CSV export's `xeroTaxType` (same rate buckets, the API-code vocabulary instead
 * of the CSV-import labels). A Xero org on bespoke rates may need the operator to
 * remap, but every standard UK org resolves them.
 */
export function xeroSalesTaxType(rate: number): string {
  if (rate === 20) return "OUTPUT2"; // 20% VAT on Income
  if (rate === 5) return "RROUTPUT"; // 5% reduced-rate VAT on Income
  if (rate === 0) return "ZERORATEDOUTPUT"; // Zero Rated Income
  return "EXEMPTOUTPUT"; // Exempt / unmappable → Exempt Income
}

/**
 * QuickBooks Online UK VAT code NAME for a SALES line, keyed by effective rate.
 * The adapter resolves this to a `TxnTaxCodeRef` id (mirroring its Service-item
 * lookup); QBO ignores a bare `TotalTax` for a UK company unless a TxnTaxCodeRef
 * is supplied, so the push must attach the org's own code. Same rate buckets as
 * the CSV export. These are QBO UK's default VAT code names; an org that renamed
 * them needs the operator to remap.
 */
export function qboSalesTaxCodeName(rate: number): string {
  if (rate === 20) return "20.0% S (VAT on Income)";
  if (rate === 5) return "5.0% R (VAT on Income)";
  if (rate === 0) return "0.0% Z (VAT on Income)";
  return "Exempt (0%)";
}

// ── Xero ─────────────────────────────────────────────────────────────────────

/**
 * Xero Accounting API `POST /Invoices` body. An accounts-receivable (`ACCREC`)
 * sales invoice per canonical invoice row. Xero resolves the Contact BY NAME
 * (creating it when absent), so no customer-id pre-resolution is needed — this
 * is what lets Xero be activation-ready on credentials alone. `LineAmountTypes`
 * is `Exclusive` because canonical `net` is the ex-VAT subtotal and `vat` the
 * tax; the single line carries both so Xero's gross matches canonical `gross`.
 *
 * ACCOUNT + TAX CODE. An AUTHORISED ACCREC line MUST name a revenue account —
 * Xero rejects the invoice otherwise — so every line carries `AccountCode` (the
 * configured sales account, the exact twin of the bank code on the payments
 * body). `TaxType` is set from the line's effective VAT rate so Xero honours the
 * manual `TaxAmount`; without it Xero recalculates and non-standard rates
 * (0% / 5% / exempt) post the wrong gross.
 */
export function buildXeroInvoicesBody(
  rows: readonly CanonicalAccountingRow[],
  salesAccountCode: string,
): { Invoices: unknown[] } {
  return {
    Invoices: rows.map((r) => {
      const net = amount(r.net || r.gross);
      const vat = amount(r.vat);
      return {
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
            UnitAmount: net,
            TaxAmount: vat,
            AccountCode: salesAccountCode,
            TaxType: xeroSalesTaxType(effectiveVatRate(net, vat)),
          },
        ],
      };
    }),
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
 *
 * VAT. Canonical amounts are ex-VAT, so the body declares
 * `GlobalTaxCalculation: "TaxExcluded"` and QBO adds tax on top. A bare
 * `TotalTax` is IGNORED for a UK company unless a tax code is named, so when the
 * line bears VAT the caller resolves the org's `TxnTaxCodeRef` (by rate) and
 * passes it in; the txn then carries both the code and the exact `TotalTax`, so
 * QBO's gross equals canonical `gross`. A zero-VAT line carries no TxnTaxDetail
 * (TaxExcluded ⇒ gross == net).
 */
export function buildQboInvoiceBody(
  row: CanonicalAccountingRow,
  refs: { customerId: string; itemId: string; taxCodeId?: string | null },
): Record<string, unknown> {
  const net = amount(row.net || row.gross);
  const vat = amount(row.vat);
  return {
    DocNumber: row.invoice_number,
    TxnDate: row.date,
    CustomerRef: { value: refs.customerId },
    // Canonical amounts are ex-VAT; tell QBO to add tax rather than derive it
    // as tax-inclusive (a UK company defaults otherwise).
    GlobalTaxCalculation: "TaxExcluded",
    Line: [
      {
        DetailType: "SalesItemLineDetail",
        Amount: net,
        Description: row.invoice_number
          ? `Invoice ${row.invoice_number}`
          : "Sales invoice",
        SalesItemLineDetail: {
          ItemRef: { value: refs.itemId },
          // Name the line's tax code too when known, so QBO applies the rate.
          ...(refs.taxCodeId ? { TaxCodeRef: { value: refs.taxCodeId } } : {}),
        },
      },
    ],
    // Canonical splits VAT out; QBO honours the explicit TotalTax only when the
    // tax code is named. No code (or no VAT) ⇒ no TxnTaxDetail.
    TxnTaxDetail:
      vat > 0 && refs.taxCodeId
        ? { TxnTaxCodeRef: { value: refs.taxCodeId }, TotalTax: vat }
        : undefined,
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
