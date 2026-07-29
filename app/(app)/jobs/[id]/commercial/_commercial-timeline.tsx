"use client";

import { useState } from "react";
import Link from "next/link";
import { formatGbp } from "@/lib/money";
import type { CommercialEvent, CommercialFlow } from "@/lib/commercial/timeline";

/**
 * Commercial lifecycle timeline (Programme D). Presentational only — it renders
 * the pre-computed, serialisable event stream from `buildCommercialTimeline`
 * (aggregated server-side). The only client concern is collapse-to-recent.
 */

const FLOW_STYLE: Record<CommercialFlow, string> = {
  in: "text-emerald-700",
  out: "text-slate-500",
  neutral: "text-slate-500",
};

const DOT: Record<CommercialFlow, string> = {
  in: "bg-emerald-400",
  out: "bg-slate-300",
  neutral: "bg-blue-300",
};

const RECENT = 12;

export function CommercialTimeline({ events }: { events: CommercialEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  if (events.length === 0) return null;

  const shown = expanded ? events : events.slice(0, RECENT);
  const hasMore = events.length > RECENT;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Commercial timeline</h2>
        <span className="text-xs text-slate-500">{events.length} events</span>
      </div>

      <ul className="mt-4 space-y-2.5">
        {shown.map((e, i) => (
          <li key={`${e.occurredAt}-${e.kind}-${i}`} className="flex items-baseline gap-3 text-sm">
            <span className="w-[68px] shrink-0 font-mono text-[11px] text-slate-500">{e.date}</span>
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[e.flow]}`} aria-hidden />
            <span className="min-w-0 flex-1 text-slate-700">
              {e.href ? (
                <Link href={e.href} className="hover:text-slate-900 hover:underline">
                  {e.label}
                </Link>
              ) : (
                e.label
              )}
            </span>
            {e.amount != null ? (
              <span className={`shrink-0 font-medium tabular-nums ${FLOW_STYLE[e.flow]}`}>
                {e.flow === "out" ? "−" : e.flow === "in" ? "+" : ""}
                {formatGbp(e.amount)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      {hasMore ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-4 text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          {expanded ? "Show recent only" : `Show all ${events.length} events`}
        </button>
      ) : null}
    </section>
  );
}
