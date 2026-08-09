import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { computeReceivables } from "@/lib/invoices/receivables";

/**
 * The customer's financial standing — invoiced / paid / outstanding / lifetime.
 *
 * THE BUG THIS FIXES (customer_id-is-canonical class). The customer detail page
 * used to gather a customer's invoices by walking quote -> invoice:
 *
 *     const quoteIds = quotes.map(q => q.id);
 *     if (quoteIds.length > 0)
 *       supabase.from("invoices").select(...).in("quote_id", quoteIds)
 *
 * But `invoices.quote_id` is ON DELETE SET NULL, and — more importantly — the
 * LIVE manager-gated stage/progress-billing path
 * (`generate_stage_invoice`, migration 20261039000000) inserts invoices with
 * `quote_id = NULL` and `customer_id` set from the job. Those invoices have NO
 * quote to join through, so a customer on stage billing had EVERY stage invoice
 * silently omitted from Total invoiced / Paid / Outstanding / Lifetime revenue —
 * their money was under-reported with no error.
 *
 * The durable anchor is `invoices.customer_id` (migration 20260915000000,
 * composite FK (customer_id, org_id) -> customers, backfilled from the quote and
 * set at creation for every writer). The rest of the codebase already treats it
 * as canonical: `lib/reports/aggregates.ts` (top-customers, C38) reads
 * `customer_id` first, the customer portal invoice list scopes by
 * `.eq("customer_id", ...)`, and `app/api/invoices/route.ts` stamps it at
 * creation. This resolver brings the detail page's rollup onto the same anchor.
 *
 * PAGED (F-1): these are per-customer money sums with no cap. `fetchAllRows`
 * pages the full set on a stable `created_at`+`id` order so a big customer's
 * later invoices/payments can't be silently clipped by the 1000-row PostgREST
 * cap and under-report the totals. LOUD on error (throw `readFailure`) — a
 * transient read failure must never masquerade as "no invoices".
 *
 * Takes the Supabase client as an argument (the `lib/jobs/load.ts` idiom) so it
 * is a pure, hermetically testable seam.
 */

export type CustomerInvoiceRow = {
  id: string;
  number: string;
  status: string;
  total: number | string | null;
  due_date: string | null;
  paid_at: string | null;
  created_at: string;
};

export type CustomerPaymentRow = {
  id: string;
  invoice_id: string;
  amount: number | string | null;
  paid_at: string;
  reference: string | null;
};

export type CustomerFinancials = {
  invoiceRows: CustomerInvoiceRow[];
  paymentRows: CustomerPaymentRow[];
  totalInvoiced: number;
  totalPaid: number;
  outstanding: number;
  lifetimeRevenue: number;
};

type FinancialsClient = SupabaseClient<Database>;

/**
 * Load and total a customer's invoices + payments, anchored on the durable
 * `invoices.customer_id` (NOT the nullable `quote_id`), paged and loud.
 *
 * `customerId` is expected to already be the ACTIVE-org-pinned subject (the
 * detail page pins the customer read to `ctx.org.id`); the composite FK on
 * `invoices` guarantees any matched invoice is that customer's own-org invoice.
 */
export async function loadCustomerFinancials(
  supabase: FinancialsClient,
  customerId: string,
): Promise<CustomerFinancials> {
  const { data: invoiceRows, error: invsError } = await fetchAllRows<CustomerInvoiceRow>(
    (from, to) =>
      supabase
        .from("invoices")
        .select("id, number, status, total, due_date, paid_at, created_at")
        // Durable anchor. A quote-less stage invoice (quote_id NULL) still
        // carries customer_id, so it is counted here instead of vanishing.
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<CustomerInvoiceRow>>,
  );
  if (invsError) throw readFailure("customer detail: invoices", invsError);

  let paymentRows: CustomerPaymentRow[] = [];
  if (invoiceRows.length > 0) {
    const { data: pays, error: paysError } = await fetchAllRows<CustomerPaymentRow>(
      (from, to) =>
        supabase
          .from("invoice_payments")
          .select("id, invoice_id, amount, paid_at, reference")
          .in(
            "invoice_id",
            invoiceRows.map((i) => i.id),
          )
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<CustomerPaymentRow>>,
    );
    if (paysError) throw readFailure("customer detail: payments", paysError);
    paymentRows = pays;
  }

  const totalInvoiced = invoiceRows.reduce((s, i) => s + Number(i.total ?? 0), 0);
  const totalPaid = paymentRows.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  // Outstanding is a RECEIVABLE, so it goes through the shared authority: per-
  // invoice netting (max(0, total − Σ payments)) over the canonical OUTSTANDING
  // statuses. The old `max(0, totalInvoiced − totalPaid)` netted at the AGGREGATE,
  // which (a) counted DRAFT invoice totals as owed and (b) let an overpayment on
  // one invoice silently pay down another — the exact cross-subsidy defect the
  // ledger-truthful surfaces exist to avoid. totalInvoiced / totalPaid /
  // lifetimeRevenue stay as-is; they answer different questions.
  const paidByInvoice = new Map<string, number>();
  for (const p of paymentRows) {
    paidByInvoice.set(p.invoice_id, (paidByInvoice.get(p.invoice_id) ?? 0) + Number(p.amount ?? 0));
  }
  const { outstandingTotal: outstanding } = computeReceivables(
    invoiceRows.map((i) => ({
      status: i.status,
      total: i.total,
      due_date: i.due_date,
      paid: paidByInvoice.get(i.id) ?? 0,
    })),
  );
  // Lifetime revenue = sum of paid invoice totals.
  const lifetimeRevenue = invoiceRows
    .filter((i) => i.status === "paid")
    .reduce((s, i) => s + Number(i.total ?? 0), 0);

  return {
    invoiceRows,
    paymentRows,
    totalInvoiced,
    totalPaid,
    outstanding,
    lifetimeRevenue,
  };
}
