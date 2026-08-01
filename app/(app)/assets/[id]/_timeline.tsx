/**
 * Unified asset history (integration slice) — custody, inspections, overrides,
 * maintenance and QR-identity lifecycle interleaved chronologically. Composed
 * server-side by `composeAssetTimeline` from data the detail page already loads
 * plus two bounded reads (custody history + QR history); capped so the page
 * never grows unbounded (full per-domain history stays in each section).
 */

import type { TimelineEvent } from "@/lib/assets/timeline";

export type { TimelineEvent };

const KIND_STYLES: Record<TimelineEvent["kind"], string> = {
  custody: "bg-blue-50 text-blue-700",
  inspection: "bg-purple-50 text-purple-700",
  override: "bg-amber-50 text-amber-700",
  maintenance: "bg-slate-100 text-slate-600",
  qr: "bg-teal-50 text-teal-700",
};

const CAP = 30;

export function AssetTimelineSection({ events }: { events: TimelineEvent[] }) {
  const sorted = [...events].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, CAP);
  if (sorted.length === 0) return null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">History</h2>
        <span className="text-xs text-slate-500">latest {sorted.length}</span>
      </div>
      <ul className="mt-3 space-y-1.5 text-sm">
        {sorted.map((e, i) => (
          <li key={`${e.at}-${i}`} className="flex flex-wrap items-baseline gap-2">
            <span className="w-20 shrink-0 font-mono text-[11px] text-slate-500">{e.at.slice(0, 10)}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_STYLES[e.kind]}`}>
              {e.kind}
            </span>
            <span className="text-slate-700">{e.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
