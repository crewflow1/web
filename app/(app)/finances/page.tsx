import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext, requireManagementRole } from "@/server/auth/session";
import {
  FINANCE_CATEGORIES,
  FINANCE_VAT_RATES,
} from "@/lib/finances/schema";
import { EmptyState } from "../_components/empty-state";

/**
 * Finances list — server component.
 *
 * Filters come in via search params (category, vat_rate, from, to). The
 * list query and the monthly-summary query both run under user JWT;
 * RLS scopes to caller's org.
 */

const PAGE_SIZE = 50;

type SP = Promise<{
  category?: string;
  vat_rate?: string;
  from?: string;
  to?: string;
  page?: string;
}>;

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

function fmt(amount: number | string | null) {
  if (amount === null) return "—";
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  return GBP.format(n);
}

function monthKey(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}

export default async function FinancesPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  // Costs/finances is owner/admin only (nav ADMIN_ROLES); enforce server-side.
  requireManagementRole(ctx);
  const sp = await searchParams;
  const page = Math.max(parseInt(sp.page ?? "1", 10) || 1, 1);
  const offset = (page - 1) * PAGE_SIZE;
  const category = sp.category;
  const vatRate = sp.vat_rate;
  const from = sp.from;
  const to = sp.to;

  const supabase = await createClient();

  let q = supabase
    .from("finances")
    .select(
      "id, amount, currency, vat_rate, vat_total, category, receipt_url, job_id, created_at",
      { count: "exact" },
    )
    // ACTIVE-org pin — expenses (and the exact count that paginates them) must
    // come from ONE company; RLS admits every org the viewer belongs to.
    .eq("org_id", ctx.org.id)
    // Unique `id` tiebreaker so entries sharing a `created_at` cannot be skipped
    // or repeated at a `.range()` page boundary — the monthly summary read below
    // already does this; the main paged list did not.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (category && (FINANCE_CATEGORIES as readonly string[]).includes(category)) {
    q = q.eq("category", category);
  }
  if (vatRate !== undefined) {
    const r = Number(vatRate);
    if ((FINANCE_VAT_RATES as readonly number[]).includes(r)) {
      q = q.eq("vat_rate", r);
    }
  }
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    q = q.gte("created_at", `${from}T00:00:00Z`);
  }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    q = q.lte("created_at", `${to}T23:59:59Z`);
  }

  const { data: rows, count } = await q;

  // Monthly summary. We render the most recent 6 months (see the slice below),
  // so we only need rows from that window — and we page through it in chunks
  // BELOW the PostgREST max-rows cap (1000) so the totals can't be silently
  // truncated. The old fixed 5000-row fetch *exceeded* that cap, so a busy
  // org's chart quietly dropped every entry past the most recent 1000 rows. The
  // `id`
  // tiebreaker keeps paging stable across rows that share a created_at.
  type SummaryRow = {
    amount: number | string | null;
    vat_total: number | string | null;
    created_at: string;
  };
  const now = new Date();
  const summaryFloor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1),
  ).toISOString();
  const SUMMARY_PAGE = 500;
  const MAX_SUMMARY_PAGES = 200; // 100k six-month rows ≫ any single org
  const summaryRows: SummaryRow[] = [];
  for (let p = 0; p < MAX_SUMMARY_PAGES; p++) {
    const start = p * SUMMARY_PAGE;
    const { data: chunk, error: summaryError } = await supabase
      .from("finances")
      .select("amount, vat_total, created_at")
      .eq("org_id", ctx.org.id)
      .gte("created_at", summaryFloor)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(start, start + SUMMARY_PAGE - 1);
    if (summaryError) {
      console.error("[finances] monthly summary page failed", summaryError);
      break;
    }
    const batch = chunk ?? [];
    summaryRows.push(...batch);
    if (batch.length < SUMMARY_PAGE) break;
  }

  const monthly = new Map<string, { net: number; vat: number; count: number }>();
  for (const r of summaryRows ?? []) {
    const k = monthKey(r.created_at);
    const prev = monthly.get(k) ?? { net: 0, vat: 0, count: 0 };
    prev.net += Number(r.amount ?? 0);
    prev.vat += Number(r.vat_total ?? 0);
    prev.count += 1;
    monthly.set(k, prev);
  }
  const monthlySorted = Array.from(monthly.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 6);

  const exportHref = (() => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const s = qs.toString();
    return `/api/finances/export${s ? `?${s}` : ""}`;
  })();

  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Costs</h1>
          <p className="mt-1 text-sm text-slate-600">
            Your cost log — every expense with its category, VAT and receipt.
            Approved receipts land here.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={exportHref}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Export CSV
          </a>
          <Link
            href="/finances/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            + New entry
          </Link>
        </div>
      </header>

      {/* Monthly summary */}
      {monthlySorted.length > 0 ? (
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {monthlySorted.map(([month, agg]) => (
            <div
              key={month}
              className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {month}
              </div>
              <div className="mt-2 flex items-baseline justify-between">
                <div>
                  <div className="text-xs text-slate-500">Net</div>
                  <div className="text-lg font-semibold text-slate-900">
                    {fmt(agg.net)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-slate-500">VAT</div>
                  <div className="text-lg font-semibold text-slate-900">
                    {fmt(agg.vat)}
                  </div>
                </div>
              </div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="text-xs text-slate-500">
                  {agg.count} {agg.count === 1 ? "entry" : "entries"}
                </span>
                <span className="text-xs text-slate-700">
                  Total {fmt(agg.net + agg.vat)}
                </span>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {/* Filters */}
      <form
        method="GET"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <div>
          <label className="block text-xs font-medium text-slate-700">Category</label>
          <select
            name="category"
            defaultValue={category ?? ""}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {FINANCE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">VAT %</label>
          <select
            name="vat_rate"
            defaultValue={vatRate ?? ""}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {FINANCE_VAT_RATES.map((r) => (
              <option key={r} value={r}>
                {r}%
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">From</label>
          <input
            type="date"
            name="from"
            defaultValue={from ?? ""}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">To</label>
          <input
            type="date"
            name="to"
            defaultValue={to ?? ""}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
        <Link
          href="/finances"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Clear
        </Link>
      </form>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        {!rows || rows.length === 0 ? (
          <EmptyState
            icon="🧾"
            title="No costs yet"
            body="Log receipts, expenses, and earnings. VAT is computed automatically; you can export the lot to CSV at quarter-end."
            primary={{ href: "/finances/new", label: "Add first cost" }}
          />
        ) : (
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-right">VAT %</th>
                <th className="px-4 py-3 text-right">VAT</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Receipt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-sm">
              {rows.map((r) => {
                const amt = Number(r.amount ?? 0);
                const vat = Number(r.vat_total ?? 0);
                return (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-600">
                      {r.created_at.slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {r.category ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-slate-900">
                      {fmt(amt)}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600">
                      {r.vat_rate}%
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600">
                      {fmt(vat)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-slate-900">
                      {fmt(amt + vat)}
                    </td>
                    <td className="px-4 py-3">
                      {r.receipt_url ? (
                        <span className="text-xs text-slate-600">✓ uploaded</span>
                      ) : (
                        <span className="text-xs text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {totalPages > 1 ? (
        <nav
          aria-label="Pagination"
          className="flex items-center justify-between text-sm text-slate-600"
        >
          <span>
            Page {page} of {totalPages} · {totalCount} entries
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={{ pathname: "/finances", query: { ...sp, page: page - 1 } }}
                className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
              >
                ← Previous
              </Link>
            ) : null}
            {page < totalPages ? (
              <Link
                href={{ pathname: "/finances", query: { ...sp, page: page + 1 } }}
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
