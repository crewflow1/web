import type { ReactNode } from "react";
import { type ChartSeries, datumText } from "./series";
import { ChartLegend } from "./legend";

/**
 * ChartFrame — the shared shell every chart renders through. Server-only
 * (no "use client" anywhere in components/ui/charts): the SVG, the legend
 * and the accessible table are all static markup.
 *
 * Guarantees every chart makes by construction:
 *   - EMPTY STATE: no data → an honest "No data yet" panel. Never a fake
 *     axis, never a zeroed chart pretending to be a measurement.
 *   - ACCESSIBLE TABULAR ALTERNATIVE: a visually-hidden (sr-only) <table>
 *     of the exact plotted data renders alongside the SVG, so a screen-reader
 *     user gets the numbers, not a picture description.
 *   - The SVG itself carries role="img" + aria-label and <title>/<desc>
 *     (built by the chart component via `svgA11y`).
 *   - NO ANIMATION, ever — nothing to gate on prefers-reduced-motion.
 */

export function ChartFrame({
  series,
  categoryHeader,
  legend,
  children,
  emptyText = "No data yet",
}: {
  /** The plotted series — drives both the empty check and the sr-only table. */
  series: ChartSeries[];
  /** First column header of the accessible table (e.g. "Month", "Week"). */
  categoryHeader: string;
  /** Show a visible legend (only useful with 2+ series). */
  legend?: boolean;
  children: ReactNode;
  emptyText?: string;
}) {
  const hasData = series.some((s) => s.data.length > 0);
  if (!hasData) {
    return (
      <p className="mt-4 rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
        {emptyText}
      </p>
    );
  }
  // Categories come from the first non-empty series; every series must be
  // aligned on the same category labels (the pages pass aligned engine output).
  const base = series.find((s) => s.data.length > 0)!;
  return (
    <div className="mt-4">
      {children}
      {legend && series.length > 1 ? (
        <ChartLegend items={series.map((s) => ({ name: s.name, tone: s.tone }))} />
      ) : null}
      <table className="sr-only">
        <thead>
          <tr>
            <th scope="col">{categoryHeader}</th>
            {series.map((s) => (
              <th key={s.name} scope="col">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {base.data.map((d, i) => (
            <tr key={d.label + i}>
              <th scope="row">{d.label}</th>
              {series.map((s) => (
                <td key={s.name}>{s.data[i] ? datumText(s.data[i]) : "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The a11y attributes + children every chart SVG carries: role="img" with an
 * aria-label, and <title>/<desc> as the first children. The first <title>
 * child is the SVG's native accessible name; aria-label doubles it for
 * mappings that ignore SVG titles.
 */
export function svgA11y(title: string, desc: string) {
  return {
    attrs: { role: "img" as const, "aria-label": title },
    children: (
      <>
        <title>{title}</title>
        <desc>{desc}</desc>
      </>
    ),
  };
}

/** Shared axis/grid classes — slate, matching the light design system. */
export const AXIS = {
  grid: "stroke-slate-200",
  zero: "stroke-slate-300",
  label: "fill-slate-500",
} as const;
