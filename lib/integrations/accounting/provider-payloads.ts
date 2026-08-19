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

import {
  assertKnownVatRate,
  effectiveVatRate,
  type CanonicalAccountingRow,
  type CanonicalTaxLine,
} from "./canonical";

function amount(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Sum a list of 2dp money strings, rounded back to 2dp (no float drift). */
function sumMoney(values: readonly string[]): number {
  const pence = values.reduce((s, v) => s + Math.round(amount(v) * 100), 0);
  return pence / 100;
}

/**
 * The per-rate buckets a provider INVOICE body posts, one line each. On the push
 * path the canonical row already carries `taxLines` (bucketed by
 * buildAccountingExport); a directly-constructed row without them falls back to a
 * single header-derived bucket (the rate VALIDATED via effectiveVatRate — fail loud
 * on an unknown header rate).
 */
function invoiceTaxBuckets(row: CanonicalAccountingRow): CanonicalTaxLine[] {
  if (row.taxLines && row.taxLines.length > 0) return row.taxLines;
  const net = amount(row.net || row.gross);
  const vat = amount(row.vat);
  return [{ rate: effectiveVatRate(net, vat), net: row.net || row.gross || "0.00", vat: row.vat || "0.00" }];
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
  // FAIL LOUD: an unmappable rate throws (UnknownVatRateError) rather than
  // silently falling through to EXEMPTOUTPUT — posting VAT under an exempt code
  // mis-states the return. The adapter catches this and aborts the push.
  switch (assertKnownVatRate(rate, "Xero sales TaxType")) {
    case 20:
      return "OUTPUT2"; // 20% VAT on Income
    case 5:
      return "RROUTPUT"; // 5% reduced-rate VAT on Income
    case 0:
      return "ZERORATEDOUTPUT"; // Zero Rated Income
  }
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
  // FAIL LOUD: an unmappable rate throws (UnknownVatRateError) rather than naming
  // 'Exempt (0%)' — which would post VAT-bearing income out of scope / exempt.
  // The adapter catches this and aborts the push. rate 0 resolves the ZERO-rated
  // code (so zero-rated income posts zero-rated, not out-of-scope).
  switch (assertKnownVatRate(rate, "QuickBooks sales VAT code")) {
    case 20:
      return "20.0% S (VAT on Income)";
    case 5:
      return "5.0% R (VAT on Income)";
    case 0:
      return "0.0% Z (VAT on Income)";
  }
}

/**
 * Sage Business Cloud Accounting SALES tax rate PERCENTAGE for a line, keyed by
 * effective VAT rate. Unlike Xero (a system TaxType string) or QBO (a code NAME),
 * Sage identifies a tax rate by a `tax_rate_id` the adapter must resolve from the
 * business's own `/tax_rates` collection — and it resolves it by matching this
 * whole-percent percentage. This helper is the single fail-loud gate: an
 * unmappable rate throws (UnknownVatRateError) rather than silently falling
 * through to a wrong (often exempt) rate, mirroring the other two providers.
 */
export function sageSalesTaxRatePercentage(rate: number): number {
  // FAIL LOUD on an unmappable rate — never post VAT under the wrong Sage rate.
  return assertKnownVatRate(rate, "Sage sales tax rate");
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
 * body). `TaxType` is set PER LINE from that bucket's own VAT rate so Xero honours
 * the manual `TaxAmount`; without it Xero recalculates and non-standard rates
 * (0% / 5% / exempt) post the wrong gross.
 *
 * ONE LINE PER VAT-RATE BUCKET. A mixed-rate invoice (`taxLines` with more than
 * one bucket) posts as ONE Xero invoice with one LineItem per rate, each naming
 * the correct TaxType — never a single blended-rate line. `LineAmountTypes:
 * Exclusive` means Xero's gross = Σ(UnitAmount + TaxAmount) = header net + vat.
 * An unknown bucket rate makes `xeroSalesTaxType` throw, aborting the push.
 */
export function buildXeroInvoicesBody(
  rows: readonly CanonicalAccountingRow[],
  salesAccountCode: string,
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
      LineItems: invoiceTaxBuckets(r).map((bucket) => ({
        Description: r.invoice_number ? `Invoice ${r.invoice_number}` : "Sales invoice",
        Quantity: 1,
        UnitAmount: amount(bucket.net),
        TaxAmount: amount(bucket.vat),
        AccountCode: salesAccountCode,
        TaxType: xeroSalesTaxType(bucket.rate),
      })),
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
 *
 * VAT. Canonical amounts are ex-VAT, so the body declares
 * `GlobalTaxCalculation: "TaxExcluded"` and QBO adds tax on top. A bare
 * `TotalTax` is IGNORED for a UK company unless a tax code is named, so every
 * emitted line names its own `TaxCodeRef` (resolved by the caller, by rate) —
 * INCLUDING a zero-rated line, which names the '0.0% Z' code so it posts
 * ZERO-RATED, not out-of-scope.
 *
 * PER-RATE LINES. When the row carries `taxLines` (the push path) the body emits
 * ONE SalesItemLineDetail per rate bucket, each with its own `TaxCodeRef` from
 * `refs.taxCodeByRate`, and a header `TxnTaxDetail.TotalTax` = Σ bucket VAT — so a
 * mixed-rate invoice posts each line under the correct code and QBO's gross equals
 * the header gross. A row WITHOUT taxLines (a directly-built single line) keeps the
 * legacy single-code shape via `refs.taxCodeId` for backward compatibility.
 */
export function buildQboInvoiceBody(
  row: CanonicalAccountingRow,
  refs: {
    customerId: string;
    itemId: string;
    /** Legacy single-line path (no taxLines): the one resolved code, when VAT-bearing. */
    taxCodeId?: string | null;
    /** Push path: resolved QBO TaxCode id per whole-percent rate (incl. 0). */
    taxCodeByRate?: ReadonlyMap<number, string>;
  },
): Record<string, unknown> {
  const description = row.invoice_number ? `Invoice ${row.invoice_number}` : "Sales invoice";
  const multi = !!(row.taxLines && row.taxLines.length > 0);

  let Line: Record<string, unknown>[];
  let txnTaxDetail: Record<string, unknown> | undefined;

  if (multi) {
    const buckets = row.taxLines!;
    Line = buckets.map((bucket) => {
      const codeId = refs.taxCodeByRate?.get(bucket.rate) ?? null;
      return {
        DetailType: "SalesItemLineDetail",
        Amount: amount(bucket.net),
        Description: description,
        SalesItemLineDetail: {
          ItemRef: { value: refs.itemId },
          // Per-line code — resolved for EVERY rate incl. 0 so a zero-rated line
          // posts zero-rated (a code is named) rather than out-of-scope.
          ...(codeId ? { TaxCodeRef: { value: codeId } } : {}),
        },
      };
    });
    const totalTax = sumMoney(buckets.map((b) => b.vat));
    // Per-line codes drive QBO's calculation; the header TotalTax pins the exact
    // total. No single header TxnTaxCodeRef — the lines carry mixed rates.
    txnTaxDetail = totalTax > 0 ? { TotalTax: totalTax } : undefined;
  } else {
    const net = amount(row.net || row.gross);
    const vat = amount(row.vat);
    Line = [
      {
        DetailType: "SalesItemLineDetail",
        Amount: net,
        Description: description,
        SalesItemLineDetail: {
          ItemRef: { value: refs.itemId },
          ...(refs.taxCodeId ? { TaxCodeRef: { value: refs.taxCodeId } } : {}),
        },
      },
    ];
    txnTaxDetail =
      vat > 0 && refs.taxCodeId
        ? { TxnTaxCodeRef: { value: refs.taxCodeId }, TotalTax: vat }
        : undefined;
  }

  return {
    DocNumber: row.invoice_number,
    TxnDate: row.date,
    CustomerRef: { value: refs.customerId },
    // Canonical amounts are ex-VAT; tell QBO to add tax rather than derive it
    // as tax-inclusive (a UK company defaults otherwise).
    GlobalTaxCalculation: "TaxExcluded",
    Line,
    TxnTaxDetail: txnTaxDetail,
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

// ── Sage Business Cloud Accounting ────────────────────────────────────────────

/**
 * Sage `POST /sales_invoices` body for ONE canonical invoice row. Like QBO (and
 * unlike Xero), Sage cannot resolve a contact / ledger account / tax rate inline
 * by name — each must be an existing entity id — so the caller resolves them
 * first and passes them in. `reference` carries the CrewFlow invoice number so a
 * re-push is detectable and the payment link can find the invoice again.
 *
 * VAT. Canonical `net` is the ex-VAT unit price, and Sage computes the tax itself
 * from each line's `tax_rate_id`. So every emitted line names its own tax rate id
 * (resolved by the caller, by rate) — INCLUDING a zero-rated line, which names the
 * business's 0% rate id so it posts zero-rated rather than out-of-scope.
 *
 * PER-RATE LINES. When the row carries `taxLines` (the push path) the body emits
 * ONE `invoice_lines` entry per rate bucket, each with its own `tax_rate_id` from
 * `refs.taxRateByRate` — so a mixed-rate invoice posts each line under the correct
 * rate and Sage's gross equals the header gross. A row WITHOUT taxLines (a
 * directly-built single line) keeps the legacy single-rate shape via
 * `refs.taxRateId`.
 */
export function buildSageInvoiceBody(
  row: CanonicalAccountingRow,
  refs: {
    contactId: string;
    ledgerAccountId: string;
    /** Legacy single-line path (no taxLines): the one resolved tax rate id, when VAT-bearing. */
    taxRateId?: string | null;
    /** Push path: resolved Sage tax_rate_id per whole-percent rate (incl. 0). */
    taxRateByRate?: ReadonlyMap<number, string>;
  },
): Record<string, unknown> {
  const description = row.invoice_number ? `Invoice ${row.invoice_number}` : "Sales invoice";
  const multi = !!(row.taxLines && row.taxLines.length > 0);

  let invoiceLines: Record<string, unknown>[];
  if (multi) {
    invoiceLines = row.taxLines!.map((bucket) => {
      const rateId = refs.taxRateByRate?.get(bucket.rate) ?? null;
      return {
        description,
        ledger_account_id: refs.ledgerAccountId,
        quantity: 1,
        unit_price: amount(bucket.net),
        // Per-line rate — resolved for EVERY rate incl. 0 so a zero-rated line
        // posts zero-rated (a rate id is named) rather than out-of-scope.
        ...(rateId ? { tax_rate_id: rateId } : {}),
      };
    });
  } else {
    const net = amount(row.net || row.gross);
    invoiceLines = [
      {
        description,
        ledger_account_id: refs.ledgerAccountId,
        quantity: 1,
        unit_price: net,
        ...(refs.taxRateId ? { tax_rate_id: refs.taxRateId } : {}),
      },
    ];
  }

  return {
    sales_invoice: {
      contact_id: refs.contactId,
      date: row.date,
      reference: row.invoice_number,
      invoice_lines: invoiceLines,
    },
  };
}

/**
 * Sage `POST /contact_payments` body for ONE canonical payment row — a customer
 * receipt allocated against its sales invoice. Sage records a receipt as a
 * `contact_payment` of `transaction_type_id` CUSTOMER_RECEIPT, landing in a bank
 * account, with the invoice named in `allocated_artefacts` (the caller resolves
 * the Sage invoice id). Only ever emitted once the payment-link gate has proven
 * the invoice exists at Sage, so an allocation target is always present.
 */
export function buildSagePaymentBody(
  row: CanonicalAccountingRow,
  refs: {
    contactId: string;
    bankAccountId: string;
    transactionTypeId: string;
    invoiceId: string;
  },
): Record<string, unknown> {
  const total = amount(row.gross);
  return {
    contact_payment: {
      transaction_type_id: refs.transactionTypeId,
      contact_id: refs.contactId,
      bank_account_id: refs.bankAccountId,
      date: row.date,
      total_amount: total,
      allocated_artefacts: [{ artefact_id: refs.invoiceId, amount: total }],
    },
  };
}
