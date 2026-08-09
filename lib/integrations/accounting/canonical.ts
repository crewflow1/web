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
 * The whole-percent UK VAT rates CrewFlow emits (quotes/schema.ts QUOTE_VAT_RATES).
 * The provider push MUST map every posted line to one of these; a rate outside this
 * set has no honest Xero TaxType / QBO VAT code, so the push refuses rather than
 * silently posting it under an EXEMPT / out-of-scope code and mis-stating the VAT
 * return.
 */
export const KNOWN_VAT_RATES = [0, 5, 20] as const;
export type KnownVatRate = (typeof KNOWN_VAT_RATES)[number];

/**
 * Raised when a derived / per-line VAT rate is not one of {@link KNOWN_VAT_RATES}.
 * Thrown by the pure rate/tax-code functions so the push ABORTS with a clear
 * message instead of falling through to EXEMPTOUTPUT / 'Exempt (0%)' and mis-posting.
 * The adapters catch it and surface it as an `error` push result (the same posture
 * as the missing-Service-item / missing-VAT-code refusals).
 */
export class UnknownVatRateError extends Error {
  readonly rate: number;
  constructor(rate: number, context?: string) {
    super(
      `Unsupported VAT rate ${rate}% ${context ? `(${context}) ` : ""}` +
        `— CrewFlow only posts ${KNOWN_VAT_RATES.map((r) => `${r}%`).join(" / ")}. ` +
        "Refusing to push rather than mis-post under an exempt / out-of-scope tax code.",
    );
    this.name = "UnknownVatRateError";
    this.rate = rate;
  }
}

/** True for a rate in {@link KNOWN_VAT_RATES} (exact whole-percent match). */
export function isKnownVatRate(rate: number): rate is KnownVatRate {
  return (KNOWN_VAT_RATES as readonly number[]).includes(rate);
}

/**
 * Assert a rate is postable, else throw {@link UnknownVatRateError}. Returns the
 * rate so it can be used inline. The single fail-loud gate the tax-code mappers use.
 */
export function assertKnownVatRate(rate: number, context?: string): KnownVatRate {
  if (!isKnownVatRate(rate)) throw new UnknownVatRateError(rate, context);
  return rate;
}

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
  /**
   * INTERNAL push-tracking id — the CrewFlow primary key of the source row
   * (invoices.id / invoice_payments.id). Present only on the provider-push path
   * (buildAccountingExport threads it from the DB row); undefined for the CSV
   * path. It is the immutable identity the push-once ledger
   * (accounting_pushed_entities) records and excludes against, and the stable
   * seed for a per-entity provider idempotency key. Never serialised to CSV —
   * ACCOUNTING_CSV_COLUMNS does not name it — so it cannot leak into an export.
   */
  sourceId?: string;
  /**
   * INVOICE ONLY, PROVIDER-PUSH PATH ONLY — the per-VAT-rate breakdown of this
   * invoice, one entry per DISTINCT rate bucket (e.g. a 20%-line + a 5%-line
   * invoice yields two entries). This is what lets the push post ONE provider
   * document with MULTIPLE line items, each carrying its OWN rate's tax code
   * (Xero TaxType / QBO TxnTaxCodeRef) — the fix for the blended-header defect
   * where a mixed-rate invoice collapsed to a single wrong rate. The bucket nets
   * / vats SUM to the header `net` / `vat` (asserted at build). Undefined on the
   * CSV path and for payments; the CSV export keeps the single header-total row.
   * ONE canonical row per invoice regardless of bucket count — so the push-once
   * ledger, the payment-link gate, and the per-entity idempotency key (all keyed
   * on `sourceId` / `invoice_number`) are unchanged by bucketing.
   */
  taxLines?: CanonicalTaxLine[];
};

/**
 * One VAT-rate bucket of an invoice: its whole-percent rate plus the ex-VAT net
 * and the VAT for the lines at that rate. Amounts are fixed 2dp strings (the
 * canonical money representation); the provider builders coerce via `Number(...)`.
 */
export type CanonicalTaxLine = {
  /** Whole-percent VAT rate for this bucket (validated to {@link KNOWN_VAT_RATES} at push). */
  rate: number;
  /** Ex-VAT net for the lines at this rate, fixed 2dp. */
  net: string;
  /** VAT for the lines at this rate, fixed 2dp. */
  vat: string;
};

/**
 * A raw invoice line the push reads for per-rate bucketing — the immutable
 * snapshot columns from `invoice_line_items` (vat_rate + ex-VAT line_total).
 */
export type InvoiceLineForBucketing = {
  vat_rate: number | string | null;
  line_total: number | string | null;
};

/** What the mapper needs about one invoice. A pure projection of the DB row. */
export type CanonicalInvoiceInput = OverdueJudgeable & {
  /** CrewFlow invoices.id — threaded onto the row's `sourceId` (push path only). */
  source_id?: string | null;
  number: string | null;
  amount: number | string | null;
  vat_total: number | string | null;
  total: number | string | null;
  /** Tax point: `sent_at` preferred (when it was issued), else `created_at`. */
  sent_at: string | null;
  created_at: string | null;
  customer_name: string | null;
  /**
   * The invoice's `invoice_line_items` snapshot (vat_rate + ex-VAT line_total),
   * threaded on the PROVIDER-PUSH path only so the mapper can emit per-rate
   * `taxLines`. Absent / empty ⇒ no line data (CSV path, or a line-less invoice):
   * the mapper falls back to a single header-derived bucket. Never read on the CSV
   * path, so the CSV export is unchanged.
   */
  line_items?: readonly InvoiceLineForBucketing[] | null;
};

/** What the mapper needs about one payment (a money-in event). */
export type CanonicalPaymentInput = {
  /** CrewFlow invoice_payments.id — threaded onto the row's `sourceId` (push path only). */
  source_id?: string | null;
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

/**
 * The whole-percent VAT rate derived from a net + VAT, WITHOUT validation. Pure.
 * `round(vat / net * 100)`; a zero / missing net yields 0 (never NaN or Infinity).
 * This is the raw arithmetic used where the caller validates the result itself
 * (the mapper's header-fallback bucket defers validation to the provider push).
 */
export function derivedVatRate(net: number, vat: number): number {
  if (!Number.isFinite(net) || !Number.isFinite(vat) || net <= 0) return 0;
  return Math.round((vat / net) * 100);
}

/**
 * The effective whole-percent VAT rate of an invoice line, derived from its net
 * and VAT, VALIDATED to {@link KNOWN_VAT_RATES}. Pure. This is the SINGLE source
 * of the rate a header-only provider line reads to choose a tax code (Xero
 * TaxType / QBO TxnTaxCodeRef).
 *
 * FAIL LOUD. When the derived rate is not 0 / 5 / 20 (e.g. a mixed-rate invoice
 * whose blended `round(vat/net*100)` lands on 3, or a crafted 17.5% line) this
 * THROWS {@link UnknownVatRateError} instead of returning a bogus rate that would
 * fall through to EXEMPTOUTPUT / 'Exempt (0%)' and mis-state the VAT return. The
 * push is aborted with a clear message rather than posting the wrong tax code.
 * A zero / missing net yields 0 (a valid 0-VAT line), never a throw.
 */
export function effectiveVatRate(net: number, vat: number): number {
  return assertKnownVatRate(derivedVatRate(net, vat), "derived from invoice header net/vat");
}

/**
 * Split an invoice's `invoice_line_items` into per-VAT-rate buckets, PURE. One
 * bucket per distinct rate, its net = Σ line_total and its vat = Σ round2(line_total
 * × rate / 100) — the HMRC per-line VAT method quotes/totals.ts uses, so the
 * buckets reconcile to the header EXACTLY.
 *
 * RECONCILIATION IS ASSERTED. Σ bucket nets must equal the header net and Σ bucket
 * vats the header vat (compared in integer pence). A mismatch means the snapshot
 * lines disagree with the invoice totals — corrupt data that must NOT be posted, so
 * this THROWS rather than silently post a document whose gross differs from the
 * invoice. Rates are NOT validated here (a bad rate is carried through so the
 * provider tax-code mapper is the single fail-loud gate); reconciliation only.
 *
 * Buckets are returned sorted by rate ascending for deterministic output.
 */
export function bucketInvoiceTaxLines(
  lineItems: readonly InvoiceLineForBucketing[],
  header: { net: number; vat: number },
): CanonicalTaxLine[] {
  const byRate = new Map<number, { netPence: number; vatPence: number }>();
  for (const li of lineItems) {
    const rate = Number(li.vat_rate ?? 0);
    const lineNetRaw = Number(li.line_total ?? 0);
    const lineNet = Number.isFinite(lineNetRaw) ? lineNetRaw : 0;
    const netPence = Math.round(lineNet * 100);
    // round2(lineNet × rate / 100) in pence == round(lineNet × rate) — the exact
    // per-line rounding quotes/totals.ts applies before summing to the header.
    const vatPence = Number.isFinite(rate) ? Math.round(lineNet * rate) : 0;
    const cur = byRate.get(rate) ?? { netPence: 0, vatPence: 0 };
    cur.netPence += netPence;
    cur.vatPence += vatPence;
    byRate.set(rate, cur);
  }

  let sumNetPence = 0;
  let sumVatPence = 0;
  for (const b of byRate.values()) {
    sumNetPence += b.netPence;
    sumVatPence += b.vatPence;
  }
  const headerNetPence = Math.round((Number.isFinite(header.net) ? header.net : 0) * 100);
  const headerVatPence = Math.round((Number.isFinite(header.vat) ? header.vat : 0) * 100);
  if (sumNetPence !== headerNetPence || sumVatPence !== headerVatPence) {
    throw new Error(
      "accounting push: per-line VAT buckets do not reconcile to the invoice header " +
        `(lines net ${sumNetPence}p vat ${sumVatPence}p vs header net ${headerNetPence}p ` +
        `vat ${headerVatPence}p) — refusing to post an invoice whose line VAT disagrees ` +
        "with its totals.",
    );
  }

  return [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, b]) => ({
      rate,
      net: (b.netPence / 100).toFixed(2),
      vat: (b.vatPence / 100).toFixed(2),
    }));
}

/** A Postgres timestamp/date -> `YYYY-MM-DD`, or "" when absent. Pure. */
function dateOnly(value: string | null | undefined): string {
  if (!value) return "";
  // Both `2026-01-31` and `2026-01-31T09:15:00Z` slice to the calendar day.
  return value.slice(0, 10);
}

/**
 * THE canonical tax-point date of an invoice, `YYYY-MM-DD` (or "" when it has
 * neither timestamp): `sent_at` (when the invoice was ISSUED) preferred, else
 * `created_at`. Pure. This is the SINGLE definition of an invoice's tax point —
 * the mapper stamps it onto the row's `date` and the windowed export filters on
 * it — so the date an accountant books can never disagree with the date the
 * period filter uses.
 */
export function invoiceTaxPointDate(
  inv: Pick<CanonicalInvoiceInput, "sent_at" | "created_at">,
): string {
  return dateOnly(inv.sent_at) || dateOnly(inv.created_at);
}

/** True for a bare `YYYY-MM-DD` calendar day. */
function isDayString(v: string | null | undefined): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Keep only the invoices whose TAX POINT (`sent_at ?? created_at`) falls within
 * an inclusive `[from, to]` calendar-day window. Pure. Either bound may be
 * omitted, in which case only the provided side is applied; an invoice with no
 * derivable tax point is KEPT (it cannot be placed in a period, and silently
 * dropping it is the exact lie the windowed export must not tell).
 *
 * WHY THE TAX POINT, NOT `created_at`. Because `sent_at >= created_at`, an
 * invoice created 31 Mar but ISSUED 2 Apr has an April tax point: a `created_at`
 * window would drop it from a `from = 2 Apr` export (created_at < from) and, at
 * the upper bound, over-include one issued after `to`. The DB read is only a
 * COARSE `created_at <= to` superset (safe because the tax point can never be
 * earlier than `created_at`); THIS filter is the exact bound the accountant sees.
 */
export function filterInvoicesByTaxPoint(
  invoices: readonly CanonicalInvoiceInput[],
  window: { from?: string | null; to?: string | null },
): CanonicalInvoiceInput[] {
  const { from, to } = window;
  return invoices.filter((inv) => {
    const taxPoint = invoiceTaxPointDate(inv);
    if (!taxPoint) return true;
    if (isDayString(from) && taxPoint < from) return false;
    if (isDayString(to) && taxPoint > to) return false;
    return true;
  });
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
    const row: CanonicalAccountingRow = {
      date: invoiceTaxPointDate(inv),
      type: "invoice",
      customer: inv.customer_name ?? "",
      net: money2(net),
      vat: money2(vat),
      gross: money2(grossNum),
      invoice_number: inv.number ?? "",
      status: invoiceDisplayStatus(inv, opts.todayIso),
    };
    // Attach the push-tracking id only when the caller supplied one (the push
    // path). Omitting the key entirely on the CSV path keeps that row's shape
    // untouched — CSV never sees a sourceId, present or absent.
    if (inv.source_id) {
      row.sourceId = inv.source_id;
      // PROVIDER-PUSH PATH: emit the per-VAT-rate breakdown so the push posts one
      // document with one line PER RATE, each carrying its own tax code — the fix
      // for the blended-header rate that mis-posted mixed / zero-rated invoices.
      //   • line items present ⇒ bucket by their vat_rate (reconciled to header);
      //   • line-less invoice  ⇒ a single header-derived bucket. The rate is left
      //     RAW here (not validated) so the provider tax-code mapper is the single
      //     fail-loud gate — a bad header rate aborts the push, never mis-posts.
      const lines = inv.line_items ?? [];
      row.taxLines =
        lines.length > 0
          ? bucketInvoiceTaxLines(lines, { net, vat })
          : [{ rate: derivedVatRate(net, vat), net: money2(net), vat: money2(vat) }];
    }
    rows.push(row);
  }

  for (const pay of payments) {
    const row: CanonicalAccountingRow = {
      date: dateOnly(pay.paid_at),
      type: "payment",
      customer: pay.customer_name ?? "",
      net: "",
      vat: "",
      gross: money2(pay.amount),
      invoice_number: pay.invoice_number ?? "",
      status: "received",
    };
    if (pay.source_id) row.sourceId = pay.source_id;
    rows.push(row);
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
