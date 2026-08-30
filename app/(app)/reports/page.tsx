import Link from "next/link";
import {
  jobsPerWeek,
  revenuePerMonth,
  vatPerQuarter,
  topCustomersByRevenue,
} from "@/lib/reports/aggregates";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { AccountingExportPanel } from "./accounting/AccountingExportPanel";
import { AccountingConnectionsPanel } from "./accounting/AccountingConnectionsPanel";
import { ReportSubscriptionsPanel } from "./ReportSubscriptionsPanel";
import { listAccountingConnections } from "@/server/services/accounting-connections";
import {
  listReportSubscriptions,
  type SubscriptionsClient,
} from "@/lib/reports/subscriptions";
import { REPORTS } from "@/lib/reports/registry";
import { BarChart, compactNumber, type ChartSeries } from "@/components/ui/charts";
import {
  isXeroConnectable,
  isQuickbooksConnectable,
  isSageConnectable,
} from "@/lib/integrations/accounting/oauth";

/**
 * /reports — owner-facing time-series aggregates.
 *
 * Four cards on one page:
 *   - Jobs per week (last 8)
 *   - Revenue per month (last 12, from paid invoices)
 *   - VAT per quarter (last 4; output − input)
 *   - Top customers by revenue (all-time, top 10)
 *
 * Charts render through the canonical chart system (components/ui/charts) —
 * server-rendered pure SVG, no chart library, no client JS, no bundle cost.
 * Each chart carries its own scale so a thin month doesn't shrink everything
 * else to invisible, plus an sr-only data table and native <title> tooltips.
 * The aggregates stay computed by lib/reports/aggregates; the page only maps
 * them to chart series (labels + preformatted display values).
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 0,
});

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  timeZone: "UTC",
});

const QUARTER_LABEL = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} ${d.getUTCFullYear()}`;
};

const WEEK_LABEL = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
};

/**
 * Accounting OAuth return banner. The connect callback
 * (app/api/integrations/accounting/[provider]/callback/route.ts) lands the admin
 * back here with ?connect=<outcome>. `connected` is the success path; the rest are
 * the callback's failure exits. Keep these keys in lock-step with the statuses
 * backToReports() emits. (`encryption_not_configured` is a JSON exit today rather
 * than a redirect, but is mapped defensively so activation can surface it here.)
 */
const CONNECT_SUCCESS: Record<string, string> = {
  connected: "Accounting account connected.",
};
const CONNECT_ERROR: Record<string, string> = {
  error: "Couldn't complete the connection. Please try again.",
  state_mismatch:
    "The connection request expired or didn't match. Please start again.",
  no_account:
    "Connected, but no accounting organisation was found on that account.",
  encryption_not_configured:
    "Accounting connections aren't fully configured yet. No account was connected.",
};

type SP = Promise<{ connect?: string }>;

export default async function ReportsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const connectSuccess = sp.connect ? (CONNECT_SUCCESS[sp.connect] ?? null) : null;
  const connectError = sp.connect ? (CONNECT_ERROR[sp.connect] ?? null) : null;
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const supabase = await createClient();
  const [jobs, revenue, vat, top, connections, subscriptions] = await Promise.all([
    jobsPerWeek(ctx.org.id, 8),
    revenuePerMonth(ctx.org.id, 12),
    vatPerQuarter(ctx.org.id, 4),
    topCustomersByRevenue(ctx.org.id, 10),
    isAdmin
      ? listAccountingConnections(ctx.org.id)
      : Promise.resolve([]),
    isAdmin
      ? listReportSubscriptions(supabase as unknown as SubscriptionsClient, ctx.org.id)
      : Promise.resolve([]),
  ]);

  const totalJobs = jobs.reduce((s, r) => s + r.total, 0);
  const totalCompleted = jobs.reduce((s, r) => s + r.completed, 0);
  const totalRevenue = revenue.reduce((s, r) => s + r.revenue, 0);
  const totalNetVat = vat.reduce((s, r) => s + r.net_vat, 0);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Reports</h1>
          <p className="mt-1 text-sm text-slate-600">
            Weekly throughput, monthly revenue, quarterly VAT, top customers.
            All data scoped to your current organisation.
          </p>
        </div>
        <a
          href="/api/reports/export"
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          target="_blank"
          rel="noopener noreferrer"
        >
          Export CSV
        </a>
      </header>

      {/* Accounting OAuth return — outcome banner keyed off ?connect= set by the
          connect callback. */}
      {connectError ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {connectError}
        </div>
      ) : null}
      {connectSuccess ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {connectSuccess}
        </div>
      ) : null}

      {/* Ledger reports ------------------------------------------------
          The four cards below are time-series aggregates. These two are
          ledger listings — the documents an accountant or a client meeting
          asks for by name — so they get their own routes rather than being
          squeezed into a bar chart. */}
      <nav aria-label="Ledger reports" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[
          {
            href: "/reports/retention",
            title: "Retention register",
            body: "Every retention holdback across every job, with the completion and defects dates that entitle release.",
          },
          {
            href: "/reports/ageing",
            title: "Aged debtors & creditors",
            body: "Who owes you and who you owe, in current / 30 / 60 / 90+ day columns.",
          },
        ].map((r) => (
          <Link
            key={r.href}
            href={r.href}
            className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow"
          >
            <p className="text-sm font-semibold text-slate-900">{r.title}</p>
            <p className="mt-1 text-xs text-slate-600">{r.body}</p>
          </Link>
        ))}
      </nav>

      {/* Report library ------------------------------------------------
          The composed reports — each reuses an existing compute authority
          (profitability, cash timeline, utilisation, pipeline) and offers a
          shared PDF/CSV export. Cashflow is admin-only (it exposes VAT/CIS/
          payables), so it is hidden from a non-admin's library. */}
      <nav aria-label="Report library" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(["profit", "cashflow", "utilisation", "pipeline"] as const)
          .map((k) => REPORTS[k])
          .filter((r) => isAdmin || !r.managementOnly)
          .map((r) => (
            <Link
              key={r.key}
              href={r.href ?? "/reports"}
              className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow"
            >
              <p className="text-sm font-semibold text-slate-900">{r.title}</p>
              <p className="mt-1 text-xs text-slate-600">{r.description}</p>
            </Link>
          ))}
      </nav>

      {/* Scheduled delivery — admin-only. Emails a report on a cadence; dark
          until email is configured (the cron skips cleanly with no key). */}
      {isAdmin ? (
        <ReportSubscriptionsPanel subscriptions={subscriptions} />
      ) : null}

      {/* Accounting export — CSV works now; Xero/QuickBooks are dark seams.
          Admin-only: generating a bookkeeping export is an admin act, doubled
          by the admin-write RLS on accounting_export_log. */}
      {isAdmin ? <AccountingExportPanel /> : null}

      {/* Accounting connections — connect a Xero / QuickBooks account. DARK:
          the OAuth flow is credential-gated, so the connect buttons render
          disabled ("configure credentials") until activation. Admin-only. */}
      {isAdmin ? (
        <AccountingConnectionsPanel
          connections={connections}
          connectable={{
            xero: isXeroConnectable(),
            quickbooks: isQuickbooksConnectable(),
            sage: isSageConnectable(),
          }}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Jobs per week ----------------------------------------------- */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <header className="flex items-baseline justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Jobs per week
              </h2>
              <p className="text-xs text-slate-500">Last 8 weeks</p>
            </div>
            <div className="text-right">
              <div className="text-xl font-bold text-slate-900">{totalJobs}</div>
              <div className="text-[11px] text-slate-500">
                {totalCompleted} completed
              </div>
            </div>
          </header>
          <JobsBars data={jobs} />
        </section>

        {/* Revenue per month ------------------------------------------- */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <header className="flex items-baseline justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Revenue per month
              </h2>
              <p className="text-xs text-slate-500">
                Last 12 months · paid invoices only
              </p>
            </div>
            <div className="text-right">
              <div className="text-xl font-bold text-slate-900">
                {GBP.format(totalRevenue)}
              </div>
              <div className="text-[11px] text-slate-500">total</div>
            </div>
          </header>
          <RevenueBars data={revenue} />
        </section>

        {/* VAT per quarter --------------------------------------------- */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <header className="flex items-baseline justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                VAT per quarter
              </h2>
              <p className="text-xs text-slate-500">
                Output − input · last 4 quarters
              </p>
            </div>
            <div className="text-right">
              <div className="text-xl font-bold text-slate-900">
                {GBP.format(totalNetVat)}
              </div>
              <div className="text-[11px] text-slate-500">net</div>
            </div>
          </header>
          <VatBars data={vat} />
        </section>

        {/* Top customers ----------------------------------------------- */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <header className="flex items-baseline justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Top customers
              </h2>
              <p className="text-xs text-slate-500">
                All-time, by paid-invoice revenue
              </p>
            </div>
            <div className="text-right">
              <div className="text-xl font-bold text-slate-900">
                {top.length}
              </div>
              <div className="text-[11px] text-slate-500">paying customers</div>
            </div>
          </header>
          <TopCustomersList data={top} />
        </section>
      </div>

      <p className="text-xs text-slate-500">
        All aggregates run under your user JWT — same RLS rules as the
        rest of the app. Numbers reflect paid invoices and the
        organisation you&apos;re currently signed into; switch
        organisations via the top-bar dropdown to see a different
        tenant.
      </p>
    </div>
  );
}

/** £-prefixed compact axis ticks ("£1.2k"). Datum tooltips/tables use full GBP. */
const gbpTick = (n: number): string => `£${compactNumber(n)}`;

function JobsBars({ data }: { data: Awaited<ReturnType<typeof jobsPerWeek>> }) {
  // Two aligned series — total (neutral) and completed (good) — grouped bars.
  const series: ChartSeries[] = [
    {
      name: "Total",
      tone: "slate",
      data: data.map((row) => ({
        label: WEEK_LABEL(row.week_start),
        value: row.total,
        text: `${row.total} ${row.total === 1 ? "job" : "jobs"}`,
      })),
    },
    {
      name: "Completed",
      tone: "emerald",
      data: data.map((row) => ({
        label: WEEK_LABEL(row.week_start),
        value: row.completed,
        text: `${row.completed} completed`,
      })),
    },
  ];
  return (
    <BarChart
      title="Jobs per week, last 8 weeks"
      desc="Grouped bars of total and completed jobs for each of the last 8 weeks."
      series={series}
      categoryHeader="Week starting"
    />
  );
}

function RevenueBars({
  data,
}: {
  data: Awaited<ReturnType<typeof revenuePerMonth>>;
}) {
  const series: ChartSeries[] = [
    {
      name: "Revenue",
      tone: "indigo",
      data: data.map((row) => ({
        label: MONTH_LABEL.format(new Date(`${row.month}T00:00:00Z`)),
        value: row.revenue,
        text: GBP.format(row.revenue),
      })),
    },
  ];
  return (
    <BarChart
      title="Revenue per month, last 12 months"
      desc="Monthly revenue from paid invoices over the last 12 months."
      series={series}
      categoryHeader="Month"
      formatValue={gbpTick}
    />
  );
}

function VatBars({ data }: { data: Awaited<ReturnType<typeof vatPerQuarter>> }) {
  const series: ChartSeries[] = [
    {
      name: "Output (collected)",
      tone: "emerald",
      data: data.map((row) => ({
        label: QUARTER_LABEL(row.quarter),
        value: row.output_vat,
        text: GBP.format(row.output_vat),
      })),
    },
    {
      name: "Input (paid)",
      tone: "amber",
      data: data.map((row) => ({
        label: QUARTER_LABEL(row.quarter),
        value: row.input_vat,
        text: GBP.format(row.input_vat),
      })),
    },
  ];
  return (
    <div>
      <BarChart
        title="VAT per quarter, last 4 quarters"
        desc="Grouped bars of output VAT collected and input VAT paid for each of the last 4 quarters."
        series={series}
        categoryHeader="Quarter"
        formatValue={gbpTick}
      />
      {/* Keep the per-quarter NET figures visible — the chart shows the two
          sides; this line shows what's actually owed. */}
      {data.length > 0 ? (
        <ol className="mt-3 space-y-1">
          {data.map((row) => (
            <li
              key={row.quarter}
              className="flex items-center justify-between text-xs"
            >
              <span className="text-slate-600">{QUARTER_LABEL(row.quarter)}</span>
              <span className="font-medium text-slate-900">
                {GBP.format(row.net_vat)} net
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function TopCustomersList({
  data,
}: {
  data: Awaited<ReturnType<typeof topCustomersByRevenue>>;
}) {
  if (data.length === 0) {
    return (
      <p className="mt-4 text-sm text-slate-500">
        No paid invoices yet. Top customers will appear here as invoices get
        paid.
      </p>
    );
  }
  const max = Math.max(...data.map((c) => c.revenue));
  return (
    <ol className="mt-4 space-y-1.5">
      {data.map((c, i) => {
        const pct = (c.revenue / max) * 100;
        return (
          <li key={c.id} className="flex items-center gap-3 text-sm">
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-medium text-slate-700">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-slate-700">
              {c.name}
            </span>
            <span className="hidden sm:block w-32">
              <span
                className="block h-1.5 rounded bg-slate-900"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="shrink-0 text-right font-medium text-slate-900">
              {GBP.format(c.revenue)}
            </span>
            <span className="shrink-0 text-[11px] text-slate-500">
              {c.invoice_count}×
            </span>
          </li>
        );
      })}
    </ol>
  );
}
