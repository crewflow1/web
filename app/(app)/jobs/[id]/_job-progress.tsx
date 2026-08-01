import { StateForm } from "@/components/forms/StateForm";
import { Field } from "@/components/forms/Field";
import { formatDateShortUK, formatDayKeyUK } from "@/lib/time/format";
import {
  PROGRESS_TREND_LABELS,
  type ProgressCurve,
  type ProgressSummary,
  type ProgressTrend,
} from "@/lib/job-progress/series";
import type { PlannedCurve } from "@/lib/job-programme/planned";
import { loadJobProgress } from "@/server/services/job-progress";
import { recordJobProgress } from "./progress-actions";

/**
 * Job progress over time — the curve, the trend, and the way to add a reading.
 *
 * THE PLANNED LINE IS EARNED, NEVER INVENTED
 * ------------------------------------------
 * This panel long refused to draw a planned line, because CrewFlow held no
 * programme and a straight 0→100% line between invented endpoints would make
 * every variance figure a fabrication that looks like evidence. A programme
 * now exists (job_programme_baselines, 20261085) — and the refusal survives it
 * in sharper form: the dashed planned line renders ONLY when
 * lib/job-programme/planned.ts emits one, which it does only for a CURRENT
 * baseline whose milestones are ALL weighted and sum to 100. A dateless job,
 * an unweighted programme or a failed programme read all render exactly what
 * this panel rendered before — the actual line, with the honest on-screen
 * sentence about what is missing. See the migration headers (20261078,
 * 20261085).
 *
 * NO CHARTING DEPENDENCY. package.json carries no chart library (no recharts /
 * chart.js / d3 / visx / nivo / echarts / plotly), and the geometry is ~30
 * lines of coordinates computed in lib/job-progress/series.ts. Adding a
 * dependency to draw one polyline would repeat the 48 kB animation-library
 * rejection. The SVG below is ours: it has a viewBox and no fixed width, so it
 * scales cleanly at 375px.
 *
 * LOUD READ: a failed read renders an explicit error, never an empty curve —
 * "no readings yet" and "the query was rejected" must not look identical.
 */

const TREND_STYLES: Record<ProgressTrend, string> = {
  none: "bg-slate-100 text-slate-700",
  first: "bg-sky-100 text-sky-800",
  progressing: "bg-emerald-100 text-emerald-800",
  stalled: "bg-amber-100 text-amber-800",
  regressed: "bg-rose-100 text-rose-800",
};

const SOURCE_LABELS = {
  observation: "Site update",
  site_report: "From report",
} as const;

/** The actual-progress line (and, when one honestly exists, the planned line). */
function ProgressChart({
  curve,
  planned,
}: {
  curve: ProgressCurve;
  planned: PlannedCurve | null;
}) {
  if (curve.points.length === 0) return null;
  const single = curve.points.length === 1;

  return (
    <svg
      viewBox={`0 0 ${curve.width} ${curve.height}`}
      className="mt-4 h-auto w-full"
      role="img"
      aria-label={
        curve.domain
          ? `Progress from ${formatDateShortUK(curve.domain.from)} to ${formatDateShortUK(curve.domain.to)}, ` +
            `${curve.points.map((p) => `${p.percent}% on ${formatDateShortUK(p.day)}`).join("; ")}` +
            (planned ? ". A dashed planned line from the job programme is shown for comparison." : "")
          : "Progress chart"
      }
    >
      {curve.gridlines.map((g) => (
        <g key={g.percent}>
          <line
            x1={0}
            y1={g.y}
            x2={curve.width}
            y2={g.y}
            stroke="currentColor"
            strokeWidth={g.percent === 0 || g.percent === 100 ? 1 : 0.5}
            className="text-slate-200"
          />
          <text x={2} y={g.y - 2} className="fill-slate-400 text-[7px]">
            {g.percent}%
          </text>
        </g>
      ))}

      {curve.areaPath ? (
        <path d={curve.areaPath} className="fill-emerald-500/10" />
      ) : null}

      {/* PLANNED, under the actual line: dashed and muted so the record of
          what happened always reads above the statement of what was meant to. */}
      {planned && planned.points.length >= 2 ? (
        <polyline
          points={planned.polyline}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-slate-400"
        />
      ) : null}

      {!single ? (
        <polyline
          points={curve.polyline}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-emerald-600"
        />
      ) : null}

      {curve.points.map((p) => (
        <circle
          key={`${p.source}:${p.sourceId}`}
          cx={p.x}
          cy={p.y}
          r={single ? 4 : 2.5}
          className={
            p.source === "observation" ? "fill-emerald-600" : "fill-sky-600"
          }
        />
      ))}
    </svg>
  );
}

function TrendBadge({ summary }: { summary: ProgressSummary }) {
  const delta = summary.delta;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${TREND_STYLES[summary.trend]}`}
    >
      {/* The WORD carries the meaning — never the colour alone (WCAG 1.4.1). */}
      {PROGRESS_TREND_LABELS[summary.trend]}
      {typeof delta === "number" && delta !== 0
        ? ` ${delta > 0 ? "+" : ""}${delta} pts`
        : null}
    </span>
  );
}

export async function JobProgressSection({
  jobId,
  orgId,
}: {
  jobId: string;
  orgId: string;
}) {
  const now = new Date();
  const { summary, curve, planned, plannedRevision, failed } =
    await loadJobProgress(orgId, jobId, now);
  const today = formatDayKeyUK(now);

  if (failed) {
    return (
      <section
        id="progress"
        className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm"
      >
        <h2 className="text-base font-semibold text-red-800">Progress</h2>
        <p className="mt-1 text-sm text-red-700">
          Couldn&apos;t load this job&apos;s progress history. Refresh to try
          again — this is a failed read, not an empty one.
        </p>
      </section>
    );
  }

  const recent = [...summary.points].reverse().slice(0, 6);

  return (
    <section
      id="progress"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Progress</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Percent complete over time — the trend, not just today&apos;s number.
          </p>
        </div>
        <TrendBadge summary={summary} />
      </div>

      {summary.percent === null ? (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
          No progress recorded yet. Add the first reading below — after two,
          this shows whether the job is moving.
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-3xl font-bold tabular-nums text-slate-900">
              {summary.percent}%
            </span>
            <span className="text-xs text-slate-600">
              {summary.latest ? (
                <>
                  as at {formatDateShortUK(summary.latest.day)}
                  {summary.daysSinceUpdate !== null
                    ? summary.daysSinceUpdate === 0
                      ? " (today)"
                      : ` — ${summary.daysSinceUpdate} day${summary.daysSinceUpdate === 1 ? "" : "s"} ago`
                    : null}
                </>
              ) : null}
            </span>
          </div>

          {summary.stale ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              Nobody has updated progress for {summary.daysSinceUpdate} days.
              The figure above is what was last believed, not what is true now.
            </p>
          ) : null}

          <ProgressChart curve={curve} planned={planned} />

          {/*
            The honest sentence under the chart. Swapped ONLY when a planned
            line is actually drawn — anything less than a fully-weighted
            current baseline keeps the old copy, because without the dashed
            line a reader would reasonably assume the single plotted line had
            a plan behind it.
          */}
          {planned ? (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              The dashed line is the planned programme (baseline revision{" "}
              {plannedRevision ?? 1}, from the weighted milestones below in the
              programme panel). The solid line is what was actually recorded —
              the chart compares them; it draws no verdict.
            </p>
          ) : (
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              Actual progress only. A planned line appears once this job has a
              programme baseline with every milestone weighted — set one in the
              programme panel below. A straight line from 0% to 100% would look
              like a plan and measure nothing, so none is drawn.
            </p>
          )}

          {recent.length > 0 ? (
            <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
              {recent.map((p) => (
                <li
                  key={`${p.source}:${p.sourceId}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2"
                >
                  <span className="text-sm font-medium tabular-nums text-slate-900">
                    {p.percent}%
                  </span>
                  <span className="text-xs text-slate-500">
                    {formatDateShortUK(p.day)}
                  </span>
                  <span className="w-full text-[11px] text-slate-500">
                    {SOURCE_LABELS[p.source]}
                    {p.reference ? ` ${p.reference}` : ""}
                    {p.note ? ` · ${p.note}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      <StateForm
        action={recordJobProgress.bind(null, jobId)}
        className="mt-5 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-[7rem_10rem_1fr_auto] sm:items-end"
      >
        <Field name="percent" label="Progress %" required>
          <input
            id="percent"
            name="percent"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            required
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </Field>
        <Field name="observed_on" label="As at" help="Defaults to today">
          <input
            id="observed_on"
            name="observed_on"
            type="date"
            max={today}
            defaultValue={today}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </Field>
        <Field name="note" label="Note" optional help="Internal — never shown to the customer">
          <input
            id="note"
            name="note"
            type="text"
            maxLength={2000}
            placeholder="e.g. second fix started, waiting on glazing"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </Field>
        <button
          type="submit"
          className="h-10 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
        >
          Record
        </button>
      </StateForm>
    </section>
  );
}
