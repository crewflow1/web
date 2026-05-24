import Link from "next/link";
import {
  buildNudges,
  buildWeeklySummary,
  computeCustomerHealth,
  unseenMilestones,
  type RetentionSignals,
} from "@/lib/retention/signals";
import { dismissMilestone, dismissNudge } from "./_retention-actions";

/**
 * Dashboard retention + experience block.
 *
 * Five widgets per CEO directive, all rendered inline above the
 * existing KPI grid:
 *
 *   1. Milestone celebrations (one card per unseen)
 *   2. Inactivity nudge (or onboarding top-nudge) banner
 *   3. Company health score
 *   4. This-week summary
 *   5. Priority-ordered nudge list (rest of the top-nudge stack)
 *
 * No client JS — every form is a server-action POST. The widgets
 * coexist with the existing SetupChecklist (which still renders
 * above this block while setup is incomplete).
 */

const GBP_NOFRAC = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

const BAND_PILL = {
  green: "bg-emerald-100 text-emerald-800 border-emerald-200",
  amber: "bg-amber-100 text-amber-900 border-amber-200",
  red: "bg-red-100 text-red-800 border-red-200",
} as const;

const BAND_BAR = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
} as const;

export function RetentionPanel({ signals }: { signals: RetentionSignals }) {
  const nudges = buildNudges(signals);
  const top = nudges[0] ?? null;
  const rest = nudges.slice(1, 4); // surface up to 3 more
  const health = computeCustomerHealth(signals);
  const week = buildWeeklySummary(signals);
  const milestones = unseenMilestones(signals);

  return (
    <section className="space-y-5">
      {/* Milestones — celebrate unseen */}
      {milestones.length > 0 ? (
        <div className="space-y-2">
          {milestones.map((m) => (
            <div
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-300 bg-emerald-50 px-5 py-4 shadow-sm"
              role="status"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span aria-hidden className="text-2xl">
                  {m.emoji}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-emerald-900">
                    {m.title}
                  </p>
                  <p className="mt-0.5 text-xs text-emerald-800">{m.body}</p>
                </div>
              </div>
              <form action={dismissMilestone}>
                <input type="hidden" name="milestone_id" value={m.id} />
                <button
                  type="submit"
                  className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                >
                  Got it
                </button>
              </form>
            </div>
          ))}
        </div>
      ) : null}

      {/* Top nudge banner + health + weekly summary in a 3-up row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Top nudge (spans 2 on lg+) */}
        <div className="lg:col-span-2">
          {top ? (
            <div className="flex h-full flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Next best action
                </p>
                <p className="mt-1 text-base font-semibold text-slate-900">
                  {top.title}
                </p>
                <p className="mt-1 text-xs text-slate-600">{top.body}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5">
                    impact: {top.impact}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5">
                    urgency: {top.urgency}
                  </span>
                </div>
              </div>
              <Link
                href={top.cta.href}
                className="shrink-0 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
              >
                {top.cta.label} →
              </Link>
            </div>
          ) : (
            <div className="flex h-full items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm">
              <div>
                <p className="text-sm font-semibold text-emerald-900">
                  Everything caught up.
                </p>
                <p className="mt-0.5 text-xs text-emerald-800">
                  No nudges right now. Keep the pipeline moving.
                </p>
              </div>
              <Link
                href="/quotes/new"
                className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
              >
                New quote →
              </Link>
            </div>
          )}
        </div>

        {/* Health */}
        <div
          className={`rounded-xl border bg-white p-5 shadow-sm ${BAND_PILL[health.band].split(" ").filter((c) => c.startsWith("border-")).join(" ") || ""}`}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Company health
          </p>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-slate-900">
              {health.score}
            </span>
            <span className="text-xs text-slate-500">/ 100</span>
            <span
              className={`ml-auto inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${BAND_PILL[health.band]}`}
            >
              {health.band}
            </span>
          </div>
          <div
            className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100"
            aria-hidden
          >
            <div
              className={`h-full ${BAND_BAR[health.band]} transition-all`}
              style={{ width: `${health.score}%` }}
            />
          </div>
          <p className="mt-3 text-[11px] text-slate-600">
            Onboarding {health.drivers.onboarding_pct}% ·{" "}
            {health.drivers.customers} customers · {health.drivers.quotes}{" "}
            quotes
            {health.drivers.overdue > 0
              ? ` · ${health.drivers.overdue} overdue`
              : ""}
            {health.drivers.support_open > 0
              ? ` · ${health.drivers.support_open} support`
              : ""}
            {health.drivers.days_since_activity !== null
              ? ` · ${health.drivers.days_since_activity}d since activity`
              : " · no activity yet"}
          </p>

          {/* Phase 2 — "3 reasons why" + "3 actions to improve" */}
          {health.reasons.length > 0 ? (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Why
              </p>
              <ul className="mt-1 space-y-1 text-xs text-slate-700">
                {health.reasons.map((r) => (
                  <li key={r}>· {r}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {health.actions.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {health.actions.map((a) => (
                <a
                  key={a.href}
                  href={a.href}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                >
                  {a.label} →
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* Weekly summary */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">This week</h3>
          <p className="text-[11px] text-slate-500">last 7 days</p>
        </div>
        {week.hasSignal ? (
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <WeekStat label="Customers" value={`+${week.customers_added}`} />
            <WeekStat label="Quotes" value={`+${week.quotes_created}`} />
            <WeekStat
              label="Invoiced"
              value={GBP_NOFRAC.format(week.invoiced_gbp)}
            />
            <WeekStat
              label="Paid"
              value={GBP_NOFRAC.format(week.payments_received_gbp)}
            />
          </dl>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            Nothing yet this week. The pipeline starts with one quote.
          </p>
        )}
      </div>

      {/* Other nudges */}
      {rest.length > 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900">Also worth doing</h3>
          <ul className="mt-3 space-y-2">
            {rest.map((n) => (
              <li
                key={n.id}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">{n.title}</p>
                  <p className="mt-0.5 text-xs text-slate-600">{n.body}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Link
                    href={n.cta.href}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {n.cta.label} →
                  </Link>
                  {/* Phase 2 — dismissible (persistent via onboarding_state). */}
                  <form action={dismissNudge}>
                    <input type="hidden" name="nudge_id" value={n.id} />
                    <button
                      type="submit"
                      className="rounded-md px-2 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
                      aria-label={`Dismiss ${n.title}`}
                    >
                      ✕
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function WeekStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 text-lg font-semibold text-slate-900">{value}</dd>
    </div>
  );
}
