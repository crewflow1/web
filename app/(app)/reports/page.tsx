import Link from "next/link";
import {
  jobsPerWeek,
  revenuePerMonth,
  vatPerQuarter,
  topCustomersByRevenue,
} from "@/lib/reports/aggregates";
import { requireOrgContext } from "@/server/auth/session";

/**
 * /reports — owner-facing time-series aggregates.
 *
 * Four cards on one page:
 *   - Jobs per week (last 8)
 *   - Revenue per month (last 12, from paid invoices)
 *   - VAT per quarter (last 4; output − input)
 *   - Top customers by revenue (all-time, top 10)
 *
 * Bars are pure CSS — no chart library, no bundle cost. Each card
 * carries its own scale so a thin month doesn't shrink everything
 * else to invisible.
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

export default async function ReportsPage() {
  const { ctx } = await requireOrgContext();
  const [jobs, revenue, vat, top] = await Promise.all([
    jobsPerWeek(ctx.org.id, 8),
    revenuePerMonth(ctx.org.id, 12),
    vatPerQuarter(ctx.org.id, 4),
    topCustomersByRevenue(ctx.org.id, 10),
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

function JobsBars({ data }: { data: Awaited<ReturnType<typeof jobsPerWeek>> }) {
  const max = Math.max(1, ...data.map((d) => d.total));
  return (
    <ol className="mt-4 flex items-end gap-1.5 h-32">
      {data.map((row) => {
        const totalPct = (row.total / max) * 100;
        const completedPct = (row.completed / max) * 100;
        return (
          <li
            key={row.week_start}
            className="flex flex-1 flex-col items-center justify-end"
            title={`${WEEK_LABEL(row.week_start)} · ${row.total} jobs (${row.completed} completed)`}
          >
            <div className="relative w-full max-w-[28px]">
              <div
                className="rounded-t bg-slate-300"
                style={{ height: `${Math.max(2, totalPct)}%` }}
              />
              <div
                className="absolute inset-x-0 bottom-0 rounded-t bg-green-500"
                style={{ height: `${completedPct}%` }}
              />
            </div>
            <span className="mt-1 text-[10px] text-slate-500">
              {WEEK_LABEL(row.week_start)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function RevenueBars({
  data,
}: {
  data: Awaited<ReturnType<typeof revenuePerMonth>>;
}) {
  const max = Math.max(1, ...data.map((d) => d.revenue));
  return (
    <ol className="mt-4 flex items-end gap-1.5 h-32">
      {data.map((row) => {
        const pct = (row.revenue / max) * 100;
        const label = MONTH_LABEL.format(new Date(`${row.month}T00:00:00Z`));
        return (
          <li
            key={row.month}
            className="flex flex-1 flex-col items-center justify-end"
            title={`${label} · ${GBP.format(row.revenue)}`}
          >
            <div className="w-full max-w-[28px]">
              <div
                className="rounded-t bg-slate-900"
                style={{ height: `${Math.max(2, pct)}%` }}
              />
            </div>
            <span className="mt-1 text-[10px] text-slate-500">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function VatBars({ data }: { data: Awaited<ReturnType<typeof vatPerQuarter>> }) {
  const allValues = data.flatMap((d) => [d.output_vat, d.input_vat]);
  const max = Math.max(1, ...allValues);
  return (
    <div className="mt-4 space-y-3">
      <ol className="space-y-2">
        {data.map((row) => {
          const outputPct = (row.output_vat / max) * 100;
          const inputPct = (row.input_vat / max) * 100;
          return (
            <li key={row.quarter} className="text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">{QUARTER_LABEL(row.quarter)}</span>
                <span className="font-medium text-slate-900">
                  {GBP.format(row.net_vat)} net
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div className="flex-1">
                  <div
                    className="h-1.5 rounded bg-emerald-500"
                    style={{ width: `${outputPct}%` }}
                    title={`Output VAT ${GBP.format(row.output_vat)}`}
                  />
                  <div
                    className="mt-0.5 h-1.5 rounded bg-amber-500"
                    style={{ width: `${inputPct}%` }}
                    title={`Input VAT ${GBP.format(row.input_vat)}`}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-3 text-[11px] text-slate-500">
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-1.5 w-2.5 rounded bg-emerald-500" />
          Output (collected)
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-1.5 w-2.5 rounded bg-amber-500" />
          Input (paid)
        </span>
      </div>
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
