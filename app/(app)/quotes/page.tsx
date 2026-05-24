import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import { QUOTE_STATUSES, type QuoteStatus } from "@/lib/quotes/schema";

/**
 * Quotes list page.
 *
 * Filter by status via search params. RLS scopes to caller's org.
 */

const PAGE_SIZE = 50;

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const STATUS_STYLES: Record<QuoteStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  pending_approval: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-700",
  sent: "bg-blue-100 text-blue-700",
  viewed: "bg-indigo-100 text-indigo-700",
  accepted: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  expired: "bg-slate-200 text-slate-600",
};

type SP = Promise<{ status?: string; page?: string; customer?: string }>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function QuotesPage({ searchParams }: { searchParams: SP }) {
  await requireOrgContext();
  const sp = await searchParams;
  const page = Math.max(parseInt(sp.page ?? "1", 10) || 1, 1);
  const offset = (page - 1) * PAGE_SIZE;
  const status = sp.status;
  // Optional customer filter — drives the "All quotes" link from the
  // customer detail page. UUID-validated so a crafted URL can't smuggle
  // arbitrary SQL into the eq() predicate. RLS still gates the read.
  const customerFilter =
    sp.customer && UUID_RE.test(sp.customer) ? sp.customer : null;

  const supabase = await createClient();
  let q = supabase
    .from("quotes")
    .select(
      "id, number, status, total, valid_until, created_at, customer:customers ( id, name )",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (status && (QUOTE_STATUSES as readonly string[]).includes(status)) {
    q = q.eq("status", status);
  }
  if (customerFilter) {
    q = q.eq("customer_id", customerFilter);
  }

  const { data: rows, count } = await q;
  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // For the filter banner — resolve the customer name once.
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
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Quotes</h1>
          <p className="mt-1 text-sm text-slate-600">
            {totalCount} {totalCount === 1 ? "quote" : "quotes"}
          </p>
        </div>
        <Link
          href="/quotes/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
        >
          + New quote
        </Link>
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
            href="/quotes"
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
            {QUOTE_STATUSES.map((s) => (
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
          href="/quotes"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Clear
        </Link>
      </form>

      {!rows || rows.length === 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="📝"
            title="No quotes yet"
            body="Send your first priced proposal. Builder lets you add line items, terms, and a customer-facing link they can accept online."
            primary={{ href: "/quotes/new", label: "Create first quote" }}
            secondary={{ href: "/customers/new", label: "Add a customer first" }}
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
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Valid until</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-sm">
                {rows.map((q) => (
                  <tr key={q.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">{q.number}</td>
                    <td className="px-4 py-3 text-slate-700">
                      {q.customer?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[q.status as QuoteStatus] ?? "bg-slate-100 text-slate-700"}`}
                      >
                        {q.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{q.valid_until ?? "—"}</td>
                    <td className="px-4 py-3 text-right font-medium text-slate-900">
                      {GBP.format(Number(q.total ?? 0))}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/quotes/${q.id}`}
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
            {rows.map((q) => (
              <li key={q.id}>
                <Link
                  href={`/quotes/${q.id}`}
                  className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition active:bg-slate-50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-slate-900">{q.number}</div>
                      <div className="mt-0.5 truncate text-xs text-slate-500">
                        {q.customer?.name ?? "—"}
                        {q.valid_until ? ` · valid ${q.valid_until}` : ""}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold text-slate-900">
                        {GBP.format(Number(q.total ?? 0))}
                      </div>
                      <span
                        className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[q.status as QuoteStatus] ?? "bg-slate-100 text-slate-700"}`}
                      >
                        {q.status}
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
                href={{ pathname: "/quotes", query: { ...sp, page: page - 1 } }}
                className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
              >
                ← Previous
              </Link>
            ) : null}
            {page < totalPages ? (
              <Link
                href={{ pathname: "/quotes", query: { ...sp, page: page + 1 } }}
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
