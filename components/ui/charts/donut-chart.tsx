import { SERIES, type ChartDatum, type ChartSeries, datumText } from "./series";
import { ChartFrame, svgA11y } from "./frame";
import { ChartLegend } from "./legend";

/**
 * DonutChart — part-of-whole shares. Use ONLY where the whole is meaningful
 * and the segments are few (≤ 6); a time series or a ranking belongs in a
 * bar chart. Segments are solid tone fills with native <title> tooltips; the
 * legend + sr-only table carry the names and numbers (colour never carries
 * meaning alone). Segments with value ≤ 0 are excluded from the ring (a donut
 * cannot honestly draw zero or negative shares) but stay in the table.
 */
/** Fallback segment tones, cycled when a datum doesn't pin its own. */
const SEGMENT_TONES = ["indigo", "emerald", "amber", "blue", "red", "slate"] as const;

export function DonutChart({
  title,
  desc,
  data,
  categoryHeader,
  centreLabel,
}: {
  title: string;
  desc: string;
  data: ChartDatum[];
  categoryHeader: string;
  /** Preformatted total shown in the middle of the ring (e.g. "£12,400"). */
  centreLabel?: string;
}) {
  const series: ChartSeries[] = [{ name: "Value", tone: "slate", data }];
  const positive = data
    .filter((d) => d.value > 0)
    .map((d, i) => ({
      ...d,
      tone: d.tone ?? SEGMENT_TONES[i % SEGMENT_TONES.length] ?? "slate",
    }));
  const total = positive.reduce((s, d) => s + d.value, 0);
  const a11y = svgA11y(title, desc);

  return (
    <ChartFrame series={total > 0 ? series : []} categoryHeader={categoryHeader}>
      <div className="flex flex-wrap items-center gap-4">
        <svg {...a11y.attrs} viewBox="0 0 120 120" className="h-auto w-full max-w-[9rem]">
          {a11y.children}
          {(() => {
            const cx = 60;
            const cy = 60;
            const r = 44;
            const width = 20;
            let angle = -Math.PI / 2; // start at 12 o'clock
            return positive.map((d, i) => {
              const frac = d.value / total;
              const sweep = frac * Math.PI * 2;
              const path =
                positive.length === 1
                  ? fullRing(cx, cy, r)
                  : arcPath(cx, cy, r, angle, angle + sweep);
              angle += sweep;
              return (
                <path
                  key={d.label + i}
                  d={path}
                  fill="none"
                  strokeWidth={width}
                  className={SERIES[d.tone].stroke}
                  data-chart-segment=""
                  data-value={d.value}
                >
                  <title>{`${d.label}: ${datumText(d)}`}</title>
                </path>
              );
            });
          })()}
          {centreLabel ? (
            <text
              x={60}
              y={64}
              textAnchor="middle"
              className="fill-slate-900 text-[11px] font-semibold"
            >
              {centreLabel}
            </text>
          ) : null}
        </svg>
        <ChartLegend
          className="mt-0 flex-col items-start"
          items={positive.map((d) => ({
            name: `${d.label} — ${datumText(d)}`,
            tone: d.tone,
          }))}
        />
      </div>
    </ChartFrame>
  );
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  // Tiny gap between segments for legibility.
  const gap = 0.02;
  const s = a0 + gap / 2;
  const e = Math.max(s, a1 - gap / 2);
  const large = e - s > Math.PI ? 1 : 0;
  return `M ${r2(cx + r * Math.cos(s))} ${r2(cy + r * Math.sin(s))} A ${r} ${r} 0 ${large} 1 ${r2(
    cx + r * Math.cos(e),
  )} ${r2(cy + r * Math.sin(e))}`;
}

function fullRing(cx: number, cy: number, r: number): string {
  return `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy}`;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
