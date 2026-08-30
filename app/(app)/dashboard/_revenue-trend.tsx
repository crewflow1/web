import { AreaChart, bucketByMonthUTC, compactNumber, type ChartSeries } from "@/components/ui/charts";

/**
 * Revenue trend — last 6 months of PAID revenue as an area chart, mounted in
 * the dashboard's money section.
 *
 * NO NEW QUERIES. The dashboard already fetches the org's WHOLE invoice
 * ledger (paged + loud) for the receivables/VAT/profitability tiles; this
 * component derives its series from those SAME rows. The basis matches
 * lib/reports/aggregates.revenuePerMonth exactly — `status === "paid"`
 * invoices, bucketed by `paid_at` into UTC months (bucketByMonthUTC uses the
 * same first-of-month keying) — so this trend and the /reports revenue chart
 * can never disagree. This is CASH-BASIS paid revenue, deliberately distinct
 * from the accrual "Invoiced this month" tile and the issued-date profit
 * charts below it.
 *
 * Chart via the canonical chart system (components/ui/charts): server-
 * rendered SVG, sr-only data table, honest empty state, no client JS.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  timeZone: "UTC",
});

export function RevenueTrend({
  invoices,
}: {
  /** The dashboard's already-fetched invoice rows (structural subset). */
  invoices: ReadonlyArray<{
    status: string;
    amount: number | string | null;
    paid_at: string | null;
  }>;
}) {
  const buckets = bucketByMonthUTC(
    invoices.filter((inv) => inv.status === "paid"),
    {
      date: (inv) => inv.paid_at,
      value: (inv) => Number(inv.amount ?? 0),
      months: 6,
      now: new Date(),
    },
  );
  const total = buckets.reduce((s, b) => s + b.value, 0);
  const hasAny = total !== 0 || buckets.some((b) => b.value !== 0);

  const series: ChartSeries[] = hasAny
    ? [
        {
          name: "Paid revenue",
          tone: "emerald",
          data: buckets.map((b) => ({
            label: MONTH_LABEL.format(new Date(`${b.month}T00:00:00Z`)),
            value: b.value,
            text: GBP.format(b.value),
          })),
        },
      ]
    : [];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900">
          Paid revenue (last 6 months)
        </h3>
        <span className="text-xs text-slate-500 tabular-nums">
          {GBP.format(total)} total
        </span>
      </div>
      {series.length > 0 ? (
        <AreaChart
          title="Paid revenue per month, last 6 months"
          desc="Area chart of revenue from paid invoices, bucketed by the month each invoice was paid."
          series={series}
          categoryHeader="Month"
          formatValue={(n) => `£${compactNumber(n)}`}
        />
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          No paid invoices in the last 6 months yet. The trend appears as
          invoices get paid.
        </p>
      )}
    </div>
  );
}
