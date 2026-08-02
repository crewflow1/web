/**
 * Accounting export — the provider-agnostic CANONICAL row + the PURE mapper.
 *
 * THE GAP THIS CLOSES. Phase 5 / integrations lists "Xero / QuickBooks /
 * accounting export" and it has never existed: CrewFlow's finance truth
 * (invoices + the money-in events in `invoice_payments`) has no way out into a
 * bookkeeping package. This module is the deterministic HEART of that export —
 * one canonical shape every provider (CSV now; Xero / QuickBooks when their
 * OAuth is configured) is projected from, and one pure function that turns
 * CrewFlow rows into it.
 *
 * WHY A CANONICAL SHAPE, NOT PER-PROVIDER MAPPERS. Xero, QuickBooks and a plain
 * CSV all want the same handful of facts about an accounting line: its date,
 * whether it is a sale (invoice) or a receipt (payment), who the customer is,
 * the net / VAT / gross split, the invoice number it belongs to, and its
 * status. Mapping CrewFlow -> {each provider} directly would triplicate the
 * money arithmetic that MUST be identical across them. Instead CrewFlow -> ONE
 * canonical row (here), then canonical -> {csv | xero | quickbooks} at the
 * edge. The arithmetic lives once.
 *
 * PURITY IS STRUCTURAL. `toCanonicalRows` takes its "today" as an argument and
 * imports nothing with I/O — no `Date.now()`, no clock, no SDK, no
 * `server-only`. The same inputs always produce byte-identical output, so the
 * mapper is exhaustively unit-testable and the CSV it feeds is reproducible.
 * The overdue-display derivation (which DOES depend on "today") is handled the
 * one authoritative way, via lib/invoices/overdue.ts, with the date injected.
 *
 * MONEY. Amounts arrive as Postgres `numeric` — a number OR a decimal string
 * ("1234.56") depending on the driver. `money2()` normalises either to a fixed
 * 2-decimal string ("1234.56", "0.10", "0.00"), the exact-pence representation
 * an accounting import expects, with no locale, no thousands separator and no
 * currency symbol. A non-finite / missing amount becomes "0.00" rather than
 * "NaN" so a single bad row can never poison a whole export.
 *
 *   - INVOICE row: net = `amount` (ex-VAT subtotal), vat = `vat_total`,
 *     gross = `total` when present (the DB generated column amount+vat_total)
 *     else net+vat. status = the DISPLAYED status (overdue layered on when the
 *     due date has passed and a balance is owed — lib/invoices/overdue.ts).
 *   - PAYMENT row: a cash receipt against an invoice. CrewFlow does not split
 *     VAT on a receipt (VAT lives on the invoice), so net and vat are BLANK and
 *     gross = the amount received. status = "received". reference = the invoice
 *     number the payment settles.
 */

import {
  invoiceDisplayStatus,
  type OverdueJudgeable,
} from "@/lib/invoices/overdue";

/** A canonical accounting line is either a sale (invoice) or a receipt (payment). */
export type AccountingRowType = "invoice" | "payment";

/**
 * The provider-agnostic accounting row. Every field is a plain string so the
 * serialisers (CSV now, Xero / QuickBooks later) never re-derive a value — the
 * money split and the status are decided ONCE, here.
 */
export type CanonicalAccountingRow = {
  /** Tax-point / receipt date, `YYYY-MM-DD`. Empty only when the source has none. */
  date: string;
  type: AccountingRowType;
  /** Customer name, or "" when it could not be resolved. */
  customer: string;
  /** Ex-VAT amount, fixed 2dp. Blank for a payment (a receipt carries no split). */
  net: string;
  /** VAT amount, fixed 2dp. Blank for a payment. */
  vat: string;
  /** Gross amount, fixed 2dp. Always present. */
  gross: string;
  /** The invoice number this row belongs to. */
  invoice_number: string;
  /** Displayed status: an invoice's derived status, or "received" for a payment. */
  status: string;
};

/** What the mapper needs about one invoice. A pure projection of the DB row. */
export type CanonicalInvoiceInput = OverdueJudgeable & {
  number: string | null;
  amount: number | string | null;
  vat_total: number | string | null;
  total: number | string | null;
  /** Tax point: `sent_at` preferred (when it was issued), else `created_at`. */
  sent_at: string | null;
  created_at: string | null;
  customer_name: string | null;
};

/** What the mapper needs about one payment (a money-in event). */
export type CanonicalPaymentInput = {
  invoice_number: string | null;
  customer_name: string | null;
  amount: number | string | null;
  /** `invoice_payments.paid_at` — a Postgres `date`. */
  paid_at: string | null;
};

export type ToCanonicalOptions = {
  /**
   * Today as `YYYY-MM-DD`, INJECTED so the mapper stays pure. Drives the
   * overdue-display derivation for invoice status. Never read a clock here.
   */
  todayIso: string;
};

/** Fixed 2-decimal string from a numeric | decimal-string | null. Never "NaN". */
export function money2(value: number | string | null | undefined): string {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n)) return "0.00";
  // -0 -> "0.00"; toFixed rounds half-away-from-zero at this precision, which
  // is exact for numeric(12,2) values that already carry at most 2 decimals.
  return (n === 0 ? 0 : n).toFixed(2);
}

/** A Postgres timestamp/date -> `YYYY-MM-DD`, or "" when absent. Pure. */
function dateOnly(value: string | null | undefined): string {
  if (!value) return "";
  // Both `2026-01-31` and `2026-01-31T09:15:00Z` slice to the calendar day.
  return value.slice(0, 10);
}

/**
 * THE mapper. CrewFlow invoices + payments -> canonical accounting rows,
 * deterministically.
 *
 * Ordering is STABLE and content-derived (no insertion-order dependence): by
 * date ascending, then invoice number, then type (invoice before its
 * payments), then gross. Two runs over the same data emit identical bytes.
 */
export function toCanonicalRows(
  invoices: readonly CanonicalInvoiceInput[],
  payments: readonly CanonicalPaymentInput[],
  opts: ToCanonicalOptions,
): CanonicalAccountingRow[] {
  const rows: CanonicalAccountingRow[] = [];

  for (const inv of invoices) {
    const net = Number(inv.amount ?? 0);
    const vat = Number(inv.vat_total ?? 0);
    const grossNum =
      inv.total !== null && inv.total !== undefined && inv.total !== ""
        ? Number(inv.total)
        : net + vat;
    rows.push({
      date: dateOnly(inv.sent_at) || dateOnly(inv.created_at),
      type: "invoice",
      customer: inv.customer_name ?? "",
      net: money2(net),
      vat: money2(vat),
      gross: money2(grossNum),
      invoice_number: inv.number ?? "",
      status: invoiceDisplayStatus(inv, opts.todayIso),
    });
  }

  for (const pay of payments) {
    rows.push({
      date: dateOnly(pay.paid_at),
      type: "payment",
      customer: pay.customer_name ?? "",
      net: "",
      vat: "",
      gross: money2(pay.amount),
      invoice_number: pay.invoice_number ?? "",
      status: "received",
    });
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.invoice_number !== b.invoice_number)
      return a.invoice_number < b.invoice_number ? -1 : 1;
    if (a.type !== b.type) return a.type === "invoice" ? -1 : 1;
    if (a.gross !== b.gross) return a.gross < b.gross ? -1 : 1;
    return 0;
  });

  return rows;
}
