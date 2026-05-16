import Link from "next/link";
import type {
  ActivitySummaryResponse,
  LeadInsightsResponse,
} from "@/lib/ai/types";

/**
 * Dashboard "Insights" panel — deterministic aggregates only.
 *
 * Three blocks:
 *   1. Quote pipeline funnel + conversion + median view→accept latency
 *   2. Warning chips for stalled actions (unviewed 7d, overdue 30d)
 *   3. Staff leaderboard (most completed jobs)
 *
 * Renders nothing when there's no signal at all (fresh org).
 *
 * `summary` from the API is intentionally ignored until the LLM lands —
 * the prose slot will replace the placeholder line at the top of this
 * card in a follow-up PR.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 0,
});

function formatDuration(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} h`;
  return `${(sec / 86400).toFixed(1)} d`;
}

export function InsightsSection({
  activity,
  leads,
}: {
  activity: ActivitySummaryResponse;
  leads: LeadInsightsResponse;
}) {
  const { quote_funnel, staff_leaders } = activity.key_metrics;
  const { quotes_unviewed_7d, invoices_overdue_30d } = activity.stalled_actions;
  const hasWarnings =
    quotes_unviewed_7d.length > 0 || invoices_overdue_30d.length > 0;
  const hasSignal =
    activity.key_metrics.total_events > 0 ||
    quote_funnel.sent > 0 ||
    leads.funnel.new + leads.funnel.contacted > 0;

  if (!hasSignal) {
    return null;
  }

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">
          Insights
        </h2>
        <span className="text-xs text-slate-500">
          Past {activity.window_days} days
        </span>
      </header>

      {/* Prose summary placeholder — LLM fills this in once a key is set. */}
      {activity.summary ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
          {activity.summary}
        </div>
      ) : null}

      {/* Row 0 — activity volume sparkline (per-day, last window) */}
      {activity.daily_volume.length > 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              Activity volume
            </h3>
            <span className="text-xs text-slate-500">
              {activity.key_metrics.total_events} events ·{" "}
              {activity.window_days}d window
            </span>
          </div>
          <DailySparkline data={activity.daily_volume} />
        </div>
      ) : null}

      {/* Row 1 — quote pipeline + lead conversion */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Quote pipeline</h3>
            <Link
              href="/quotes"
              className="text-xs font-medium text-slate-500 hover:text-slate-900"
            >
              View all →
            </Link>
          </div>
          <dl className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
            <Stat label="Sent" value={quote_funnel.sent} />
            <Stat label="Viewed" value={quote_funnel.viewed} />
            <Stat label="Accepted" value={quote_funnel.accepted} />
            <Stat label="Declined" value={quote_funnel.declined} />
          </dl>
          <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-600">
            <span>
              Conversion:{" "}
              <span className="font-semibold text-slate-900">
                {quote_funnel.conversion_pct === null
                  ? "—"
                  : `${quote_funnel.conversion_pct}%`}
              </span>
            </span>
            <span>
              Median view → accept:{" "}
              <span className="font-semibold text-slate-900">
                {formatDuration(quote_funnel.median_view_to_accept_sec)}
              </span>
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Lead conversion</h3>
            <Link
              href="/leads"
              className="text-xs font-medium text-slate-500 hover:text-slate-900"
            >
              Pipeline →
            </Link>
          </div>
          <dl className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
            <Stat label="New" value={leads.funnel.new} />
            <Stat label="Qualified" value={leads.funnel.qualified} />
            <Stat label="Quoted" value={leads.funnel.quoted} />
            <Stat label="Won" value={leads.funnel.won + leads.funnel.job_booked} />
          </dl>
          <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-600">
            <span>
              Conversion:{" "}
              <span className="font-semibold text-slate-900">
                {leads.conversion_pct === null ? "—" : `${leads.conversion_pct}%`}
              </span>
            </span>
            <span>
              Open forecast:{" "}
              <span className="font-semibold text-slate-900">
                {GBP.format(leads.pipeline_forecast)}
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* Row 2 — warnings (stalled actions) */}
      {hasWarnings ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-amber-900">
            Needs attention
          </h3>
          <p className="mt-1 text-xs text-amber-800">
            Things that look stuck. Each row links to the source.
          </p>

          {quotes_unviewed_7d.length > 0 ? (
            <div className="mt-3">
              <div className="text-xs font-medium uppercase tracking-wide text-amber-900">
                Quotes sent &gt; 7d, never viewed
              </div>
              <ul className="mt-1 space-y-1">
                {quotes_unviewed_7d.slice(0, 5).map((q) => (
                  <li
                    key={q.id}
                    className="flex items-center justify-between text-xs"
                  >
                    <Link
                      href={q.href}
                      className="text-amber-900 underline decoration-dotted hover:text-amber-700"
                    >
                      {q.number}{" "}
                      <span className="text-amber-700">
                        · {q.customer_name ?? "—"}
                      </span>
                    </Link>
                    <span className="font-medium text-amber-900">
                      {GBP.format(q.total)} ·{" "}
                      <span className="font-normal">{q.days_stale}d</span>
                    </span>
                  </li>
                ))}
                {quotes_unviewed_7d.length > 5 ? (
                  <li className="text-[11px] text-amber-700">
                    +{quotes_unviewed_7d.length - 5} more
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}

          {invoices_overdue_30d.length > 0 ? (
            <div className="mt-3">
              <div className="text-xs font-medium uppercase tracking-wide text-amber-900">
                Invoices sent &gt; 30d, unpaid
              </div>
              <ul className="mt-1 space-y-1">
                {invoices_overdue_30d.slice(0, 5).map((inv) => (
                  <li
                    key={inv.id}
                    className="flex items-center justify-between text-xs"
                  >
                    <Link
                      href={inv.href}
                      className="text-amber-900 underline decoration-dotted hover:text-amber-700"
                    >
                      {inv.number}
                    </Link>
                    <span className="font-medium text-amber-900">
                      {GBP.format(inv.total)} ·{" "}
                      <span className="font-normal">{inv.days_overdue}d</span>
                    </span>
                  </li>
                ))}
                {invoices_overdue_30d.length > 5 ? (
                  <li className="text-[11px] text-amber-700">
                    +{invoices_overdue_30d.length - 5} more
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Row 3 — staff leaderboard */}
      {staff_leaders.length > 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900">
            Most completed jobs
          </h3>
          <ol className="mt-3 space-y-1.5">
            {staff_leaders.map((s, i) => (
              <li
                key={s.user_id ?? `slot-${i}`}
                className="flex items-center justify-between text-sm"
              >
                <span className="flex items-center gap-2 text-slate-700">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-[11px] font-medium text-slate-700">
                    {i + 1}
                  </span>
                  <span className="truncate">{s.name}</span>
                </span>
                <span className="text-xs font-semibold text-slate-900">
                  {s.completed_jobs}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 text-base font-semibold text-slate-900">
        {value}
      </div>
    </div>
  );
}

const PREFIX_COLOURS: Record<string, string> = {
  lead: "bg-cyan-500",
  quote: "bg-blue-500",
  invoice: "bg-emerald-500",
  job: "bg-amber-500",
  finance: "bg-violet-500",
  other: "bg-slate-400",
};

function DailySparkline({
  data,
}: {
  data: ActivitySummaryResponse["daily_volume"];
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const total = data.reduce((s, d) => s + d.count, 0);

  // Determine which prefixes actually appear so the legend isn't lying.
  const presentPrefixes = new Set<string>();
  for (const d of data)
    for (const p of Object.keys(d.by_prefix)) presentPrefixes.add(p);

  function dayLabel(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  }

  if (total === 0) {
    return (
      <p className="mt-3 text-sm text-slate-500">
        No activity in this window.
      </p>
    );
  }

  return (
    <div>
      <ol
        className="mt-3 flex items-end gap-0.5"
        style={{ height: "80px" }}
        aria-label="Daily activity volume bar chart"
      >
        {data.map((d) => {
          const heightPct = (d.count / max) * 100;
          // Stacked segments per prefix so the bar shows composition.
          const prefixes = Object.keys(d.by_prefix);
          return (
            <li
              key={d.date}
              className="flex flex-1 flex-col justify-end"
              title={`${dayLabel(d.date)} · ${d.count} events`}
            >
              <div
                className="relative w-full overflow-hidden rounded-t bg-slate-100"
                style={{ height: `${Math.max(2, heightPct)}%` }}
              >
                {prefixes.length === 0 ? null : (
                  <div className="absolute inset-0 flex flex-col-reverse">
                    {prefixes.map((p) => {
                      const segPct = (d.by_prefix[p]! / d.count) * 100;
                      return (
                        <div
                          key={p}
                          className={PREFIX_COLOURS[p] ?? PREFIX_COLOURS.other}
                          style={{ height: `${segPct}%` }}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span>{dayLabel(data[0]?.date ?? "")}</span>
        <span>{dayLabel(data[data.length - 1]?.date ?? "")}</span>
      </div>
      {presentPrefixes.size > 1 ? (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600">
          {Array.from(presentPrefixes)
            .sort()
            .map((p) => (
              <li key={p} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`inline-block h-2 w-2 rounded-sm ${PREFIX_COLOURS[p] ?? PREFIX_COLOURS.other}`}
                />
                {p}
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
