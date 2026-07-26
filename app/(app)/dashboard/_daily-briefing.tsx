import Link from "next/link";
import { buildDailyBriefing } from "@/server/services/briefing";
import { isDismissibleBriefingKey } from "@/lib/briefing/compose";
import { dismissBriefingItem } from "./briefing-actions";
import type { BriefingCategory, BriefingSeverity } from "@/lib/briefing/types";

/**
 * The Daily Briefing — "what needs you today".
 *
 * The first thing an owner/manager sees on opening CrewFlow: a short, ranked,
 * deadline-aware list of the things that need attention, each with a real
 * number and a deep link. Additive server component — degrades to a calm
 * all-clear if the service returns nothing (it never throws).
 */

const SEVERITY: Record<BriefingSeverity, { chip: string; accent: string; label: string }> = {
  critical: { chip: "bg-red-100 text-red-800 ring-red-200", accent: "border-l-red-500", label: "Critical" },
  high: { chip: "bg-amber-100 text-amber-900 ring-amber-200", accent: "border-l-amber-500", label: "High" },
  medium: { chip: "bg-sky-100 text-sky-800 ring-sky-200", accent: "border-l-sky-400", label: "Attention" },
  low: { chip: "bg-slate-100 text-slate-700 ring-slate-200", accent: "border-l-slate-300", label: "Note" },
};

const CATEGORY_LABEL: Record<BriefingCategory, string> = {
  money: "Money",
  safety: "Safety",
  operations: "Operations",
  sales: "Sales",
};

export async function DailyBriefing({ orgId, userId }: { orgId: string; userId: string }) {
  const { items, summary } = await buildDailyBriefing(orgId, userId);
  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  return (
    <section
      aria-labelledby="briefing-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="briefing-heading" className="text-lg font-semibold text-slate-900">
          {summary.greeting}
        </h2>
        <span className="text-sm text-slate-500">{dateLabel}</span>
      </div>
      <p className="mt-0.5 text-sm text-slate-600">
        {summary.headline}
        {summary.lead ? <span className="text-slate-500"> {summary.lead}</span> : null}
      </p>

      {items.length === 0 ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
          <span aria-hidden className="text-emerald-500">
            ✓
          </span>
          Nothing needs your attention right now — you&rsquo;re all caught up.
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {items.map((it) => {
            const sev = SEVERITY[it.severity];
            return (
              <li
                key={it.key}
                className={`flex flex-col gap-3 rounded-lg border border-l-4 border-slate-200 bg-white p-3 sm:flex-row sm:items-start sm:justify-between ${sev.accent}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${sev.chip}`}
                    >
                      {sev.label}
                    </span>
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                      {CATEGORY_LABEL[it.category]}
                    </span>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{it.title}</p>
                  <p className="mt-0.5 text-sm text-slate-600">{it.detail}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-end">
                  <Link
                    href={it.href}
                    className="inline-flex min-h-[36px] items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    View
                  </Link>
                  {isDismissibleBriefingKey(it.key) ? (
                    <form action={dismissBriefingItem}>
                      <input type="hidden" name="item_key" value={it.key} />
                      <button
                        type="submit"
                        className="inline-flex min-h-[36px] items-center rounded-md px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-600"
                        aria-label={`Dismiss "${it.title}" for today`}
                      >
                        Done for today
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
