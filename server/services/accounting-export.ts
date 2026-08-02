import "server-only";

import { createClient } from "@/lib/supabase/server";
import { readFailure, reportReadFailure } from "@/lib/supabase/read-failure";
import {
  toCanonicalRows,
  type CanonicalAccountingRow,
  type CanonicalInvoiceInput,
  type CanonicalPaymentInput,
} from "@/lib/integrations/accounting/canonical";
import { invoiceBusinessToday } from "@/lib/invoices/overdue";

/**
 * Accounting export service — org-pinned, loud-read data gathering + the write
 * of an audit-log row.
 *
 * ORG PINNING IS LOAD-BEARING. `current_org_ids()` (the RLS boundary) returns
 * EVERY org the caller belongs to, so a multi-org admin's unpinned read would
 * blend two companies' ledgers into one accounting export — exactly the bug the
 * active-org read slices closed. Every query here `.eq("org_id", orgId)` on the
 * caller-supplied active org, so the export contains exactly one company.
 *
 * LOUD READS. A failed read throws via `readFailure` rather than degrading to
 * an empty export — an accounting export that silently omits rows because a
 * query errored is the precise lie loud reads exist to stop. Truncation at the
 * row cap is the same class of lie: a partial export must never be silent, so a
 * read that hits the cap sets `truncated` on the result, is reported loudly, and
 * is surfaced by the route (headers + audit-log note). See `capRows`.
 *
 * DRAFT INVOICES ARE NOT ACCOUNTING ROWS. A `draft` invoice is a work in
 * progress, not a real sale — it carries no tax point an accountant should book
 * and, once the provider push is live, would post as a genuine Xero / QuickBooks
 * sales invoice. The invoice read therefore EXCLUDES `draft` and keeps every
 * real status (sent / awaiting_payment / partially_paid / paid / overdue).
 */

export const MAX_ROWS = 50_000;

/**
 * Cap a read result and report whether it was truncated at the cap. Pure.
 *
 * The reads request `MAX_ROWS + 1` rows, so a returned length exceeding the cap
 * is the signal that MORE rows existed than were exported. The extra probe row
 * is sliced off; `truncated` is the loud flag the caller must surface rather
 * than silently drop the tail.
 */
export function capRows<T>(
  data: readonly T[],
  cap = MAX_ROWS,
): { rows: T[]; truncated: boolean } {
  const truncated = data.length > cap;
  return { rows: truncated ? data.slice(0, cap) : data.slice(), truncated };
}

/** Customer name from a joined `customer` / `quote.customer` (denormalised first). */
type NameJoin = { customer?: { name?: string | null } | null } & {
  quote?: { customer?: { name?: string | null } | null } | null;
};
function joinedCustomerName(row: NameJoin): string | null {
  return row.customer?.name ?? row.quote?.customer?.name ?? null;
}

export type AccountingExport = {
  rows: CanonicalAccountingRow[];
  invoiceCount: number;
  paymentCount: number;
  /**
   * True when EITHER read hit the `MAX_ROWS` cap, so the export omits rows the
   * org holds. Never silent: the caller surfaces this (route headers + audit
   * note) and the service already reported it loudly.
   */
  truncated: boolean;
};

/**
 * Gather one org's invoices + payments and map them to canonical accounting
 * rows. Optionally bounded to a `[from, to]` calendar-day window (inclusive),
 * applied to the invoice tax point and the payment date.
 *
 * `todayIso` is injected (defaults to the UK business day) so the overdue
 * display derivation is deterministic and the pure mapper never reads a clock.
 */
export async function buildAccountingExport(params: {
  orgId: string;
  from?: string | null;
  to?: string | null;
  todayIso?: string;
}): Promise<AccountingExport> {
  const { orgId, from, to } = params;
  const todayIso = params.todayIso ?? invoiceBusinessToday();
  const supabase = await createClient();

  const dayOk = (v: string | null | undefined): v is string =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

  // ── Invoices ───────────────────────────────────────────────────────────────
  let invQ = supabase
    .from("invoices")
    .select(
      "number, status, amount, vat_total, total, due_date, sent_at, created_at, " +
        "customer:customers(name), quote:quotes(customer:customers(name))",
    )
    .eq("org_id", orgId)
    // Exclude drafts: a draft invoice is not a real sale and must never become
    // an accounting row (it would post as a genuine sales invoice on the future
    // provider push). Keep every real status (sent / awaiting_payment /
    // partially_paid / paid / overdue).
    .neq("status", "draft")
    .order("created_at", { ascending: true })
    // Request one past the cap so a full result reveals truncation (capRows).
    .limit(MAX_ROWS + 1);
  // Window on the tax point (sent_at when issued, else created_at). We can only
  // range one column in PostgREST, so bound created_at and let the exact tax
  // point fall out of the mapper — a conservative superset the accountant filters.
  if (dayOk(from)) invQ = invQ.gte("created_at", `${from}T00:00:00Z`);
  if (dayOk(to)) invQ = invQ.lte("created_at", `${to}T23:59:59Z`);

  const invRes = await invQ;
  if (invRes.error) {
    throw readFailure("accounting export: invoices", invRes.error);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────
  let payQ = supabase
    .from("invoice_payments")
    .select(
      // Disambiguate the embed: invoice_payments has TWO FKs to invoices (the
      // simple invoice_id and the composite (invoice_id, org_id)), so a bare
      // `invoices(...)` is a PGRST201 ambiguous-embed. Pin the composite FK,
      // which is the tenant-safe one.
      "amount, paid_at, " +
        "invoice:invoices!invoice_payments_invoice_org_fkey(number, " +
        "customer:customers(name), quote:quotes(customer:customers(name)))",
    )
    .eq("org_id", orgId)
    .order("paid_at", { ascending: true })
    // Request one past the cap so a full result reveals truncation (capRows).
    .limit(MAX_ROWS + 1);
  if (dayOk(from)) payQ = payQ.gte("paid_at", from);
  if (dayOk(to)) payQ = payQ.lte("paid_at", to);

  const payRes = await payQ;
  if (payRes.error) {
    throw readFailure("accounting export: payments", payRes.error);
  }

  // Cap each read at MAX_ROWS and detect truncation. A partial export must never
  // be silent (the loud-reads doctrine): if either read hit the cap, report it
  // loudly here and hand `truncated` back for the route to surface.
  const invCap = capRows(invRes.data ?? []);
  const payCap = capRows(payRes.data ?? []);
  const truncated = invCap.truncated || payCap.truncated;
  if (truncated) {
    reportReadFailure("accounting export: row cap reached", {
      message:
        `export truncated at MAX_ROWS=${MAX_ROWS} — ` +
        `invoices${invCap.truncated ? " CAPPED" : ""}, ` +
        `payments${payCap.truncated ? " CAPPED" : ""}; ` +
        `org=${orgId} narrow the [from,to] window to export the tail`,
      code: "EXPORT_TRUNCATED",
    });
  }

  const invoices: CanonicalInvoiceInput[] = invCap.rows.map((r) => {
    const row = r as unknown as NameJoin & {
      number: string | null;
      status: string | null;
      amount: number | string | null;
      vat_total: number | string | null;
      total: number | string | null;
      due_date: string | null;
      sent_at: string | null;
      created_at: string | null;
    };
    return {
      number: row.number,
      status: row.status,
      amount: row.amount,
      vat_total: row.vat_total,
      total: row.total,
      due_date: row.due_date,
      sent_at: row.sent_at,
      created_at: row.created_at,
      customer_name: joinedCustomerName(row),
    };
  });

  const payments: CanonicalPaymentInput[] = payCap.rows.map((r) => {
    const row = r as unknown as {
      amount: number | string | null;
      paid_at: string | null;
      invoice?: (NameJoin & { number?: string | null }) | null;
    };
    return {
      invoice_number: row.invoice?.number ?? null,
      customer_name: row.invoice ? joinedCustomerName(row.invoice) : null,
      amount: row.amount,
      paid_at: row.paid_at,
    };
  });

  const rows = toCanonicalRows(invoices, payments, { todayIso });
  return {
    rows,
    invoiceCount: invoices.length,
    paymentCount: payments.length,
    truncated,
  };
}

export type AccountingExportLogInput = {
  orgId: string;
  createdBy: string;
  format: "csv" | "xero" | "quickbooks";
  status: "generated" | "pushed" | "skipped_dark";
  rowCount: number;
  periodStart?: string | null;
  periodEnd?: string | null;
  /**
   * Free-text outcome note — e.g. the truncation signal when a read hit the row
   * cap, so the audit history records that the export was partial. Optional.
   */
  note?: string | null;
};

/**
 * Append one row to the export audit log. Runs under the caller's JWT, so the
 * admin-write RLS policy on accounting_export_log is the real authorisation —
 * a non-admin's insert is refused by the database, not merely by this code.
 * Org-pinned. Best-effort: a log failure is reported but never sinks an export
 * the caller has already produced.
 */
export async function recordAccountingExport(
  input: AccountingExportLogInput,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  // accounting_export_log post-dates the generated types.ts, so the strict
  // `.from()` overload doesn't know it yet (the expense_budgets idiom). Cast to
  // a minimal insert builder — RLS is the real authorisation for this write.
  const loose = supabase as unknown as {
    from: (t: string) => {
      insert: (row: Record<string, unknown>) => PromiseLike<{
        error: { message: string } | null;
      }>;
    };
  };
  const { error } = await loose.from("accounting_export_log").insert({
    org_id: input.orgId,
    created_by: input.createdBy,
    format: input.format,
    status: input.status,
    row_count: input.rowCount,
    period_start: input.periodStart ?? null,
    period_end: input.periodEnd ?? null,
    note: input.note ?? null,
  });
  if (error) {
    console.error("[accounting] export-log insert failed", error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
