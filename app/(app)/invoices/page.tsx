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

type SP = Promise<{ status?: string; page?: string }>;

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
};

export default async function InvoicesPage({ searchParams }: { searchParams: SP }) {
  await requireOrgContext();
  const sp = await searchParams;
  const page = Math.max(parseInt(sp.page ?? "1", 10) || 1, 1);
  const offset = (page - 1) * PAGE_SIZE;
  const status = sp.status;

  const supabase = await createClient();
  let q = supabase
    .from("invoices")
    .select(
      "id, number, status, amount, vat_total, total, due_date, created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (status && (INVOICE_STATUSES as readonly string[]).includes(status)) {
    q = q.eq("status", status as InvoiceStatus);
  }

  const { data: rows, count } = await q;
  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Invoices</h1>
          <p className="mt-1 text-sm text-slate-600">
            {totalCount} {totalCount === 1 ? "invoice" : "invoices"}
          </p>
        </div>
        <Link
          href="/invoices/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
        >
          + Generate from quote
        </Link>
      </header>

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

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {!rows || rows.length === 0 ? (
          <EmptyState
            icon="💷"
            title="No invoices yet"
            body="Once a quote is accepted, generate a sequential HMRC-compliant invoice from it. Status transitions stamp sent/paid timestamps for the audit trail."
            primary={{ href: "/invoices/new", label: "Generate first invoice" }}
          />
        ) : (
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
        )}
      </div>

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
