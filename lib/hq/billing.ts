/**
 * CrewFlow HQ — Billing OS pure compute.
 *
 * Server/client-safe. No Supabase imports.
 */

export const BILLING_INVOICE_KINDS = ["setup_fee", "subscription", "overage"] as const;
export type BillingInvoiceKind = (typeof BILLING_INVOICE_KINDS)[number];

export const BILLING_INVOICE_STATUSES = [
  "draft",
  "sent",
  "paid",
  "failed",
  "refunded",
  "void",
] as const;
export type BillingInvoiceStatus = (typeof BILLING_INVOICE_STATUSES)[number];

export const BILLING_KIND_LABELS: Record<BillingInvoiceKind, string> = {
  setup_fee: "Setup fee",
  subscription: "Subscription",
  overage: "Overage",
};

export const BILLING_STATUS_LABELS: Record<BillingInvoiceStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  failed: "Failed",
  refunded: "Refunded",
  void: "Void",
};

export const BILLING_STATUS_PILL: Record<BillingInvoiceStatus, string> = {
  draft: "bg-slate-100 text-slate-700 border-slate-200",
  sent: "bg-blue-100 text-blue-900 border-blue-200",
  paid: "bg-emerald-100 text-emerald-900 border-emerald-200",
  failed: "bg-red-100 text-red-800 border-red-200",
  refunded: "bg-amber-100 text-amber-900 border-amber-200",
  void: "bg-slate-200 text-slate-600 border-slate-300",
};

/** Statuses that count as "money is owed". */
export const OUTSTANDING_STATUSES: ReadonlyArray<BillingInvoiceStatus> = [
  "sent",
  "failed",
];

/** Statuses that count as "this payment attempt failed". */
export const FAILED_STATUSES: ReadonlyArray<BillingInvoiceStatus> = ["failed"];

export type BillingInvoiceRow = {
  id: string;
  kind: BillingInvoiceKind;
  status: BillingInvoiceStatus;
  amount_gbp: number | string;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  period_start: string | null;
  period_end: string | null;
  notes: string | null;
  stripe_invoice_id: string | null;
  created_at: string;
};

export type BillingSummary = {
  outstandingGbp: number;
  paidGbp: number;
  failedCount: number;
  invoiceCount: number;
  /** Latest paid invoice. Drives "Last payment" tile. */
  lastPaidAt: string | null;
  /** Most recent failed invoice. Drives the failed-payments badge. */
  lastFailedAt: string | null;
};

/**
 * Roll up a list of billing_invoices rows into the summary the
 * /admin/billing list view needs per customer.
 */
export function summariseBillingInvoices(
  rows: ReadonlyArray<BillingInvoiceRow>,
): BillingSummary {
  let outstandingGbp = 0;
  let paidGbp = 0;
  let failedCount = 0;
  let lastPaidAt: string | null = null;
  let lastFailedAt: string | null = null;
  for (const r of rows) {
    const amount = Number(r.amount_gbp);
    if (OUTSTANDING_STATUSES.includes(r.status)) outstandingGbp += amount;
    if (r.status === "paid") {
      paidGbp += amount;
      if (!lastPaidAt || (r.paid_at && r.paid_at > lastPaidAt)) {
        lastPaidAt = r.paid_at ?? lastPaidAt;
      }
    }
    if (FAILED_STATUSES.includes(r.status)) {
      failedCount++;
      if (!lastFailedAt || (r.failed_at && r.failed_at > lastFailedAt)) {
        lastFailedAt = r.failed_at ?? lastFailedAt;
      }
    }
  }
  return {
    outstandingGbp: Math.round(outstandingGbp * 100) / 100,
    paidGbp: Math.round(paidGbp * 100) / 100,
    failedCount,
    invoiceCount: rows.length,
    lastPaidAt,
    lastFailedAt,
  };
}

/**
 * Friendly "next renewal" label — "In 3 days", "Today", "5 days
 * overdue", "—" when null. Keeps the same shape as the Customers OS
 * `formatMigrationEta` so the UI patterns rhyme.
 */
export function formatRenewal(next: string | null): string {
  if (!next) return "—";
  const ts = new Date(next).getTime();
  if (!Number.isFinite(ts)) return next;
  // Compare on CALENDAR DAYS, not 24h windows — otherwise
  // "+1 day + 1 second" rolls into "In 2 days" instead of "Tomorrow".
  const nextDate = new Date(ts);
  const nextMid = Date.UTC(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth(),
    nextDate.getUTCDate(),
  );
  const now = new Date();
  const nowMid = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const days = Math.round((nextMid - nowMid) / 86_400_000);
  const day = next.slice(0, 10);
  if (days === 0) return `Today · ${day}`;
  if (days === 1) return `Tomorrow · ${day}`;
  if (days === -1) return `Yesterday · ${day}`;
  if (days > 0) return `In ${days} days · ${day}`;
  return `${-days} days overdue · ${day}`;
}

// Whole-pound money formatting lives once in customer-financials; re-exported
// here so billing's callers keep importing it from @/lib/hq/billing.
export { formatGbp } from "@/lib/hq/customer-financials";
