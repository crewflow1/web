import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { buildScheduleIntegrity } from "@/server/services/schedule-integrity";
import {
  SCHEDULE_CONFLICT_KINDS,
  SCHEDULE_CONFLICT_META,
  formatConflictDay,
  groupConflictsByDay,
  type ScheduleConflict,
} from "@/lib/schedule/conflicts";
import { SCHEDULE_WINDOW_DAYS } from "@/lib/schedule/window";
import type { BriefingSeverity } from "@/lib/briefing/types";

/**
 * Schedule check — the read-only conflict detector.
 *
 * Sits under the rota because `rota_entries` is the canonical record of who is
 * working when; everything here is a disagreement between that record and some
 * other scheduling fact (a second shift, approved leave, a job's assignee, an
 * asset's custody).
 *
 * STRICTLY READ-ONLY. There is no form, no server action and no mutation on this
 * page: every row explains a conflict in a sentence, cites the evidence, and
 * links to the surface where a human decides. Nothing is moved automatically.
 */

export const metadata = {
  title: "Schedule check · CrewFlow",
};

const SEVERITY: Record<BriefingSeverity, { chip: string; accent: string; label: string }> = {
  critical: { chip: "bg-red-100 text-red-800 ring-red-200", accent: "border-l-red-500", label: "Critical" },
  high: { chip: "bg-amber-100 text-amber-900 ring-amber-200", accent: "border-l-amber-500", label: "High" },
  medium: { chip: "bg-sky-100 text-sky-800 ring-sky-200", accent: "border-l-sky-400", label: "Attention" },
  low: { chip: "bg-slate-100 text-slate-700 ring-slate-200", accent: "border-l-slate-300", label: "Note" },
};

function whenLabel(c: ScheduleConflict): string {
  if (c.daysAway <= 0) return "Today";
  if (c.daysAway === 1) return "Tomorrow";
  return `In ${c.daysAway} days`;
}

export default async function ScheduleConflictsPage() {
  const { ctx } = await requireOrgContext();
  const report = await buildScheduleIntegrity(ctx.org.id);
  const { conflicts, total, summary, window } = report;
  const days = groupConflictsByDay(conflicts);
  const shown = conflicts.length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Schedule check</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Conflicts found in your rota, jobs, approved leave and plant custody for the next{" "}
            {SCHEDULE_WINDOW_DAYS} days ({formatConflictDay(window.fromDay)} –{" "}
            {formatConflictDay(window.toDay)}). Nothing here is changed for you — each line
            explains what disagrees and links to where you fix it.
          </p>
        </div>
        <Link
          href="/staff/rota"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          ← Back to rota
        </Link>
      </header>

      <section
        aria-label="What is checked"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <h2 className="text-sm font-semibold text-slate-900">
          {total === 0
            ? "No conflicts found"
            : `${total} ${total === 1 ? "conflict" : "conflicts"} found`}
        </h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {SCHEDULE_CONFLICT_KINDS.map((kind) => {
            const meta = SCHEDULE_CONFLICT_META[kind];
            const roll = summary.byKind[kind];
            return (
              <li
                key={kind}
                className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
              >
                <span
                  className={`mt-0.5 inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.tone}`}
                >
                  {meta.label}
                </span>
                <span className="min-w-0 text-[11px] text-slate-600">
                  <strong className="text-slate-900">
                    {roll.count === 0 ? "None" : roll.count}
                  </strong>{" "}
                  · {meta.blurb}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {conflicts.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
          <span aria-hidden className="text-emerald-500">
            ✓
          </span>
          Nothing clashes in the next {SCHEDULE_WINDOW_DAYS} days. Conflicts beyond that window
          appear here as the dates come closer.
        </div>
      ) : (
        <div className="space-y-5">
          {shown < total ? (
            <p className="text-xs text-slate-500">
              Showing the {shown} most urgent of {total}.
            </p>
          ) : null}
          {days.map((group) => (
            <section key={group.day} aria-label={formatConflictDay(group.day)}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {formatConflictDay(group.day)}
              </h2>
              <ul className="mt-2 space-y-2">
                {group.conflicts.map((c) => {
                  const sev = SEVERITY[c.severity];
                  const meta = SCHEDULE_CONFLICT_META[c.kind];
                  return (
                    <li
                      key={c.key}
                      className={`flex flex-col gap-3 rounded-lg border border-l-4 border-slate-200 bg-white p-3 shadow-sm sm:flex-row sm:items-start sm:justify-between ${sev.accent}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${sev.chip}`}
                          >
                            {sev.label}
                          </span>
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${meta.tone}`}
                          >
                            {meta.label}
                          </span>
                          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                            {whenLabel(c)}
                          </span>
                        </div>
                        <p className="mt-1 text-sm font-semibold text-slate-900">{c.title}</p>
                        <p className="mt-0.5 text-sm text-slate-600">{c.detail}</p>
                      </div>
                      <div className="shrink-0">
                        <Link
                          href={c.href}
                          className="inline-flex min-h-[36px] items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Open
                        </Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-slate-500">
        Detection is deterministic: it compares stored times only, treats a shift ending exactly
        when another begins as a handover rather than a clash, and uses UK calendar days
        (so British Summer Time is handled). It reports what it can see and nothing more —
        an empty list means no conflict was detected, not a guarantee that the week is fine.
      </p>
    </div>
  );
}
