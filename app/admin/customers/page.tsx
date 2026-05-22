import Link from "next/link";
import { listCustomersForHq } from "@/server/services/hq-customer-snapshot";
import {
  formatGbp,
  HEALTH_PILL,
  subscriptionStatusFromOrg,
  SUBSCRIPTION_PILL,
  type SetupFeeStatus,
} from "@/lib/hq/customer-financials";

/**
 * Customers OS — list view (HQ-3).
 *
 * One row per organisation with the headline numbers the CEO checks
 * at a glance:
 *
 *   - Identity (name + owner email + status pill)
 *   - Financials (MRR + LTV + setup-fee status)
 *   - Migration % + health score
 *   - Last login
 *
 * Click a row → /admin/customers/<id> for the full OS detail.
 *
 * URL params drive search + filter + sort so refresh and shared
 * links preserve state.
 */

type SP = Promise<{
  q?: string;
  status?: string;
  setup?: string;
  sort?: string;
}>;

export default async function HqCustomersListPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const allRows = await listCustomersForHq();

  const q = (sp.q ?? "").trim().toLowerCase();
  const statusFilter = (sp.status ?? "").trim();
  const setupFilter = (sp.setup ?? "").trim();
  const sort = sp.sort ?? "newest";

  const filtered = allRows
    .filter((r) =>
      !q
        ? true
        : r.name.toLowerCase().includes(q) ||
          (r.owner_email ?? "").toLowerCase().includes(q) ||
          (r.owner_name ?? "").toLowerCase().includes(q),
    )
    .filter((r) => (statusFilter ? r.status === statusFilter : true))
    .filter((r) => (setupFilter ? r.setup_fee_status === setupFilter : true));

  const sorted = [...filtered].sort((a, b) => {
    if (sort === "oldest") return a.created_at < b.created_at ? -1 : 1;
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "mrr") return Number(b.mrr_gbp) - Number(a.mrr_gbp);
    if (sort === "health") return a.health_score - b.health_score; // worst first
    if (sort === "ltv") return Number(b.ltv_gbp) - Number(a.ltv_gbp);
    return a.created_at < b.created_at ? 1 : -1; // newest default
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Customers OS</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every workspace, with the financials, onboarding state, and health
          signals you need to triage in one glance. Click a row for the full
          customer profile + actions.
        </p>
      </header>

      <Filters
        q={q}
        status={statusFilter}
        setup={setupFilter}
        sort={sort}
        count={filtered.length}
      />

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {/* Desktop table */}
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Company</th>
                <th className="px-4 py-2">Owner</th>
                <th className="px-4 py-2">Subscription</th>
                <th className="px-4 py-2">Setup fee</th>
                <th className="px-4 py-2 text-right">MRR</th>
                <th className="px-4 py-2 text-right">LTV</th>
                <th className="px-4 py-2 text-right">Migration</th>
                <th className="px-4 py-2 text-right">Health</th>
                <th className="px-4 py-2">Last login</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    className="px-4 py-10 text-center text-sm text-slate-500"
                  >
                    No customers match the current filters.
                  </td>
                </tr>
              ) : (
                sorted.map((r) => {
                  const subscription = subscriptionStatusFromOrg(
                    r.status,
                    r.setup_fee_status,
                  );
                  const healthRisk =
                    r.health_score < 40
                      ? "high"
                      : r.health_score < 70
                        ? "medium"
                        : "low";
                  return (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2">
                        <Link
                          href={`/admin/customers/${r.id}`}
                          className="font-semibold text-slate-900 hover:text-slate-700"
                        >
                          {r.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-slate-700">
                        <div className="truncate">{r.owner_name ?? "—"}</div>
                        <div className="truncate text-[11px] text-slate-500">
                          {r.owner_email ?? "—"}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${SUBSCRIPTION_PILL[subscription]}`}
                        >
                          {subscription}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-slate-700">
                        {labelForSetupFee(r.setup_fee_status)}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-900">
                        {formatGbp(Number(r.mrr_gbp))}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-900">
                        {formatGbp(Number(r.ltv_gbp))}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-700">
                        {r.migration_percent}%
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${HEALTH_PILL[healthRisk]}`}
                          title={`Risk: ${healthRisk}`}
                        >
                          {r.health_score}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-[11px] text-slate-600">
                        {r.last_login_at ? r.last_login_at.slice(0, 10) : "—"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Link
                          href={`/admin/customers/${r.id}`}
                          className="text-xs font-medium text-slate-700 hover:text-slate-900"
                        >
                          Open →
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile card stack */}
        <ul className="divide-y divide-slate-100 md:hidden">
          {sorted.length === 0 ? (
            <li className="p-6 text-center text-sm text-slate-500">
              No customers match the current filters.
            </li>
          ) : (
            sorted.map((r) => {
              const subscription = subscriptionStatusFromOrg(
                r.status,
                r.setup_fee_status,
              );
              const healthRisk =
                r.health_score < 40
                  ? "high"
                  : r.health_score < 70
                    ? "medium"
                    : "low";
              return (
                <li key={r.id}>
                  <Link href={`/admin/customers/${r.id}`} className="block px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">
                          {r.name}
                        </p>
                        <p className="truncate text-[11px] text-slate-500">
                          {r.owner_email ?? "—"}
                        </p>
                      </div>
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${HEALTH_PILL[healthRisk]}`}
                      >
                        {r.health_score}
                      </span>
                    </div>
                    <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                      <div>
                        <dt className="text-slate-500">Sub</dt>
                        <dd>
                          <span
                            className={`inline-flex rounded-full border px-1.5 py-0 text-[10px] ${SUBSCRIPTION_PILL[subscription]}`}
                          >
                            {subscription}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">MRR</dt>
                        <dd className="font-medium text-slate-900">
                          {formatGbp(Number(r.mrr_gbp))}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Migration</dt>
                        <dd className="font-medium text-slate-900">
                          {r.migration_percent}%
                        </dd>
                      </div>
                    </dl>
                  </Link>
                </li>
              );
            })
          )}
        </ul>
      </section>
    </div>
  );
}

function labelForSetupFee(s: SetupFeeStatus): string {
  switch (s) {
    case "paid":
      return "Paid";
    case "pending":
      return "Pending";
    case "sent":
      return "Sent";
    case "waived":
      return "Waived";
    case "refunded":
      return "Refunded";
    default:
      return s;
  }
}

function Filters({
  q,
  status,
  setup,
  sort,
  count,
}: {
  q: string;
  status: string;
  setup: string;
  sort: string;
  count: number;
}) {
  return (
    <form
      method="GET"
      action="/admin/customers"
      className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
    >
      <label className="min-w-[200px] flex-1 text-[11px] font-medium text-slate-600">
        Search
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Company, owner name, email…"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </label>
      <label className="text-[11px] font-medium text-slate-600">
        Subscription
        <select
          name="status"
          defaultValue={status}
          className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
        >
          <option value="">All</option>
          <option value="pending">Pending</option>
          <option value="trial">Trial</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="cancelled">Cancelled</option>
          <option value="rejected">Rejected</option>
        </select>
      </label>
      <label className="text-[11px] font-medium text-slate-600">
        Setup fee
        <select
          name="setup"
          defaultValue={setup}
          className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
        >
          <option value="">All</option>
          <option value="pending">Pending</option>
          <option value="sent">Sent</option>
          <option value="paid">Paid</option>
          <option value="waived">Waived</option>
          <option value="refunded">Refunded</option>
        </select>
      </label>
      <label className="text-[11px] font-medium text-slate-600">
        Sort
        <select
          name="sort"
          defaultValue={sort}
          className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="name">Name A→Z</option>
          <option value="mrr">MRR ↓</option>
          <option value="ltv">LTV ↓</option>
          <option value="health">Health ↑ (worst first)</option>
        </select>
      </label>
      <button
        type="submit"
        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
      >
        Apply
      </button>
      <p className="text-[11px] text-slate-500">{count} customers</p>
    </form>
  );
}
