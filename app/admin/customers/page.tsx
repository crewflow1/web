import { listCustomersForHq } from "@/server/services/hq-customer-snapshot";
import {
  formatGbp,
  subscriptionStatusFromOrg,
  type SetupFeeStatus,
  type SubscriptionStatus,
  type HealthRisk,
} from "@/lib/hq/customer-financials";
import {
  Button,
  GlowHeader,
  Input,
  Panel,
  Select,
  Surface,
} from "@/components/ui";
import Link from "next/link";

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

// Dark-surface status pills. The shared *_PILL maps in
// lib/hq/customer-financials are light-themed and consumed by other
// (light) views, so HQ's dark surfaces resolve their own token idioms
// locally — presentation only, no behaviour change.
const SUBSCRIPTION_PILL_DARK: Record<SubscriptionStatus, string> = {
  trial: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  active:
    "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  past_due: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  suspended: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-400/30",
  cancelled:
    "bg-slate-700/40 text-slate-300 ring-1 ring-inset ring-slate-600/40",
  pending: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
};

const HEALTH_PILL_DARK: Record<HealthRisk, string> = {
  high: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-400/30",
  medium: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  low: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
};

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
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title="Customers OS"
        subtitle="Every workspace, with the financials, onboarding state, and health signals you need to triage in one glance. Click a row for the full customer profile + actions."
      />

      <div className="space-y-6 p-5 sm:p-7">
        <Filters
          q={q}
          status={statusFilter}
          setup={setupFilter}
          sort={sort}
          count={filtered.length}
        />

        <Panel className="p-0">
          {/* Desktop table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full divide-y divide-slate-800 text-sm">
              <thead className="text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
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
              <tbody className="divide-y divide-slate-800">
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
                      <tr key={r.id} className="hover:bg-slate-900/50">
                        <td className="px-4 py-2">
                          <Link
                            href={`/admin/customers/${r.id}`}
                            className="font-semibold text-slate-100 hover:text-white"
                          >
                            {r.name}
                          </Link>
                        </td>
                        <td className="px-4 py-2 text-slate-300">
                          <div className="truncate">{r.owner_name ?? "—"}</div>
                          <div className="truncate text-[11px] text-slate-500">
                            {r.owner_email ?? "—"}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${SUBSCRIPTION_PILL_DARK[subscription]}`}
                          >
                            {subscription}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-slate-300">
                          {labelForSetupFee(r.setup_fee_status)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-100">
                          {formatGbp(Number(r.mrr_gbp))}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-100">
                          {formatGbp(Number(r.ltv_gbp))}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-300">
                          {r.migration_percent}%
                        </td>
                        <td className="px-4 py-2 text-right">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${HEALTH_PILL_DARK[healthRisk]}`}
                            title={`Risk: ${healthRisk}`}
                          >
                            {r.health_score}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-[11px] text-slate-400">
                          {r.last_login_at ? r.last_login_at.slice(0, 10) : "—"}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Link
                            href={`/admin/customers/${r.id}`}
                            className="text-xs font-medium text-indigo-300 hover:text-indigo-200"
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
          <ul className="divide-y divide-slate-800 md:hidden">
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
                    <Link
                      href={`/admin/customers/${r.id}`}
                      className="block px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-100">
                            {r.name}
                          </p>
                          <p className="truncate text-[11px] text-slate-500">
                            {r.owner_email ?? "—"}
                          </p>
                        </div>
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${HEALTH_PILL_DARK[healthRisk]}`}
                        >
                          {r.health_score}
                        </span>
                      </div>
                      <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                        <div>
                          <dt className="text-slate-500">Sub</dt>
                          <dd>
                            <span
                              className={`inline-flex rounded-full px-1.5 py-0 text-[10px] ${SUBSCRIPTION_PILL_DARK[subscription]}`}
                            >
                              {subscription}
                            </span>
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">MRR</dt>
                          <dd className="font-medium tabular-nums text-slate-100">
                            {formatGbp(Number(r.mrr_gbp))}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">Migration</dt>
                          <dd className="font-medium tabular-nums text-slate-100">
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
        </Panel>
      </div>
    </Surface>
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
      className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 px-4 py-3"
    >
      <label className="min-w-[200px] flex-1 text-[11px] font-medium text-slate-400">
        Search
        <Input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Company, owner name, email…"
          className="mt-1 py-1.5"
        />
      </label>
      <label className="text-[11px] font-medium text-slate-400">
        Subscription
        <Select name="status" defaultValue={status} className="mt-1 py-1.5">
          <option value="">All</option>
          <option value="pending">Pending</option>
          <option value="trial">Trial</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="cancelled">Cancelled</option>
          <option value="rejected">Rejected</option>
        </Select>
      </label>
      <label className="text-[11px] font-medium text-slate-400">
        Setup fee
        <Select name="setup" defaultValue={setup} className="mt-1 py-1.5">
          <option value="">All</option>
          <option value="pending">Pending</option>
          <option value="sent">Sent</option>
          <option value="paid">Paid</option>
          <option value="waived">Waived</option>
          <option value="refunded">Refunded</option>
        </Select>
      </label>
      <label className="text-[11px] font-medium text-slate-400">
        Sort
        <Select name="sort" defaultValue={sort} className="mt-1 py-1.5">
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="name">Name A→Z</option>
          <option value="mrr">MRR ↓</option>
          <option value="ltv">LTV ↓</option>
          <option value="health">Health ↑ (worst first)</option>
        </Select>
      </label>
      <Button type="submit" variant="accent" size="sm">
        Apply
      </Button>
      <p className="text-[11px] text-slate-500">{count} customers</p>
    </form>
  );
}
