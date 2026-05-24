import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { INVOICE_STATUSES, type InvoiceStatus } from "@/lib/invoices/schema";
import { EmptyState } from "../_components/empty-state";

/**
 * Invoices list.
 *
 * RLS scopes to caller's org. Status filter via search params.
 */

const PAGE_SIZE = 50;

type SP = Promise<{ status?: string; page?: string; customer?: string }>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  awaiting_payment: "bg-amber-100 text-amber-800",
  partially_paid: "bg-indigo-100 text-indigo-800",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
};

export default async function InvoicesPage({ searchParams }: { searchParams: SP }) {
  await requireOrgContext();
  const sp = await searchParams;
  const page = Math.max(parseInt(sp.page ?? "1", 10) || 1, 1);
  const offset = (page - 1) * PAGE_SIZE;
  const status = sp.status;
  // Invoices link to customers via their source quote (quotes.customer_id).
  // The filter joins through quote:quotes!inner so the eq() applies to the
  // join's customer_id without exposing it as a column on invoices itself.
  const customerFilter =
    sp.customer && UUID_RE.test(sp.customer) ? sp.customer : null;

  const supabase = await createClient();
  // The customer filter has to walk through quotes (invoices has no
  // direct customer_id). Generated supabase types reject the
  // `quote:quotes!inner (...)` join inside a typed .select(), so we
  // cast past the typed client for this query only. RLS still scopes
  // the read; cross-tenant rows are unreachable regardless of cast.
  type UntypedQ = {
    select: (cols: string, opts?: unknown) => UntypedQ;
    eq: (k: string, v: unknown) => UntypedQ;
    order: (k: string, opts: { ascending: boolean }) => UntypedQ;
    range: (
      from: number,
      to: number,
    ) => Promise<{
      data: Array<{
        id: string;
        number: string;
        status: InvoiceStatus;
        amount: number | string | null;
        vat_total: number | string | null;
        total: number | string | null;
        due_date: string | null;
        created_at: string;
      }> | null;
      count: number | null;
      error: { message: string } | null;
    }>;
  };
  const cols = customerFilter
    ? "id, number, status, amount, vat_total, total, due_date, created_at, quote:quotes!inner ( customer_id )"
    : "id, number, status, amount, vat_total, total, due_date, created_at";
  let q = (supabase.from("invoices" as never) as unknown as UntypedQ)
    .select(cols, { count: "exact" })
    .order("created_at", { ascending: false });

  if (status && (INVOICE_STATUSES as readonly string[]).includes(status)) {
    q = q.eq("status", status as InvoiceStatus);
  }
  if (customerFilter) {
    q = q.eq("quote.customer_id", customerFilter);
  }

  const finalQuery = q.range(offset, offset + PAGE_SIZE - 1);

  const { data: rows, count } = await finalQuery;
  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  let filteredCustomerName: string | null = null;
  if (customerFilter) {
    const { data: c } = await supabase
      .from("customers")
      .select("name")
      .eq("id", customerFilter)
      .maybeSingle();
    filteredCustomerName = (c as { name?: string } | null)?.name ?? null;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Invoices</h1>
          <p className="mt-1 text-sm text-slate-600">
            {totalCount} {totalCount === 1 ? "invoice" : "invoices"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/api/invoices/export?format=simple${status ? `&status=${status}` : ""}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            target="_blank"
            rel="noopener noreferrer"
          >
            Export CSV
          </a>
          <a
            href={`/api/invoices/export?format=xero${status ? `&status=${status}` : ""}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            target="_blank"
            rel="noopener noreferrer"
            title="One row per line item, mapped to Xero's sales-invoice import schema"
          >
            Export Xero
          </a>
          <a
            href={`/api/invoices/export?format=sage${status ? `&status=${status}` : ""}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            target="_blank"
            rel="noopener noreferrer"
            title="One row per line item, mapped to Sage Business Cloud's sales-invoice import schema"
          >
            Export Sage
          </a>
          <Link
            href="/invoices/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            + Generate from quote
          </Link>
        </div>
      </header>

      {customerFilter ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <span>
            Filtered to{" "}
            <strong>{filteredCustomerName ?? "customer"}</strong>{" "}
            ·{" "}
            <Link
              href={`/customers/${customerFilter}`}
              className="font-medium underline hover:text-indigo-800"
            >
              Back to customer
            </Link>
          </span>
          <Link
            href="/invoices"
            className="rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-indigo-800 hover:bg-indigo-50"
          >
            Clear customer filter
          </Link>
        </div>
      ) : null}

      <form
        method="GET"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <div>
          <label className="block text-xs font-medium text-slate-700">Status</label>
          <select
            name="status"
            defaultValue={status ?? ""}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {INVOICE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {customerFilter ? (
          <input type="hidden" name="customer" value={customerFilter} />
        ) : null}
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
        <Link
          href="/invoices"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Clear
        </Link>
      </form>

      {!rows || rows.length === 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="💷"
            title="No invoices yet"
            body="Once a quote is accepted, generate a sequential HMRC-compliant invoice from it. Status transitions stamp sent/paid timestamps for the audit trail."
            primary={{ href: "/invoices/new", label: "Generate first invoice" }}
          />
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm md:block">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Number</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Due</th>
                  <th className="px-4 py-3 text-right">Net</th>
                  <th className="px-4 py-3 text-right">VAT</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-sm">
                {rows.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">{inv.number}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[inv.status]}`}
                      >
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {inv.due_date ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-slate-900">
                      {GBP.format(Number(inv.amount ?? 0))}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600">
                      {GBP.format(Number(inv.vat_total ?? 0))}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-slate-900">
                      {GBP.format(Number(inv.total ?? 0))}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/invoices/${inv.id}`}
                        className="text-sm font-medium text-slate-700 hover:text-slate-900"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-2 md:hidden">
            {rows.map((inv) => (
              <li key={inv.id}>
                <Link
                  href={`/invoices/${inv.id}`}
                  className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition active:bg-slate-50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-slate-900">{inv.number}</div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {inv.due_date ? `Due ${inv.due_date}` : "No due date"}
                        {" · VAT "}
                        {GBP.format(Number(inv.vat_total ?? 0))}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold text-slate-900">
                        {GBP.format(Number(inv.total ?? 0))}
                      </div>
                      <span
                        className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[inv.status]}`}
                      >
                        {inv.status}
                      </span>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {totalPages > 1 ? (
        <nav className="flex items-center justify-between text-sm text-slate-600">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={{ pathname: "/invoices", query: { ...sp, page: page - 1 } }}
                className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
              >
                ← Previous
              </Link>
            ) : null}
            {page < totalPages ? (
              <Link
                href={{ pathname: "/invoices", query: { ...sp, page: page + 1 } }}
                className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
              >
                Next →
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
