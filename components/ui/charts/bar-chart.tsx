import { linearScale, niceTicks, extentWithZero, compactNumber } from "./scale";
import { SERIES, type ChartDatum, type ChartSeries, datumText } from "./series";
import { ChartFrame, svgA11y, AXIS } from "./frame";

/**
 * BarChart — server-rendered pure-SVG bars. Vertical (grouped when 2+ series)
 * or horizontal (single series, e.g. per-job margins with long labels).
 *
 * ZERO business calculation: the values arrive already computed by the pages'
 * canonical engines; the only maths here is scaling values to pixels.
 * Baseline is ALWAYS zero (extentWithZero), so bar length is proportional to
 * value — proven by the proportionality test in __tests__/ui/charts.test.ts.
 * Negative values draw below/left of the zero line. Native SVG <title>
 * tooltips on every bar; no client JS, no animation.
 */

const V = { w: 480, h: 200, mt: 8, mr: 8, mb: 22, ml: 44 };
const ROW_H = 24;

export function BarChart({
  title,
  desc,
  series,
  categoryHeader,
  orientation = "vertical",
  formatValue = compactNumber,
  showValues = false,
}: {
  /** Accessible name — required on every chart. */
  title: string;
  /** One-sentence description of what the chart shows. */
  desc: string;
  /** Aligned series (same category labels in the same order). */
  series: ChartSeries[];
  /** First column header of the accessible table (e.g. "Month"). */
  categoryHeader: string;
  /** Horizontal supports a SINGLE series (long category labels). */
  orientation?: "vertical" | "horizontal";
  /** Axis-tick / value-label formatter (pages pass their GBP formatter). */
  formatValue?: (n: number) => string;
  /** Horizontal only: print each bar's display value at the row end. */
  showValues?: boolean;
}) {
  return (
    <ChartFrame series={series} categoryHeader={categoryHeader} legend>
      {orientation === "horizontal" ? (
        <HorizontalBars
          title={title}
          desc={desc}
          data={series[0]?.data ?? []}
          tone={series[0]?.tone ?? "slate"}
          formatValue={formatValue}
          showValues={showValues}
        />
      ) : (
        <VerticalBars title={title} desc={desc} series={series} formatValue={formatValue} />
      )}
    </ChartFrame>
  );
}

function VerticalBars({
  title,
  desc,
  series,
  formatValue,
}: {
  title: string;
  desc: string;
  series: ChartSeries[];
  formatValue: (n: number) => string;
}) {
  const a11y = svgA11y(title, desc);
  const categories = (series.find((s) => s.data.length > 0)?.data ?? []).map((d) => d.label);
  const values = series.flatMap((s) => s.data.map((d) => d.value));
  const [lo, hi] = extentWithZero(values);
  // All-zero data is data (an axis from 0), not a fake ±1 spread.
  const ticks = niceTicks(lo, lo === 0 && hi === 0 ? 1 : hi, 5);
  const y = linearScale([ticks[0] ?? 0, ticks[ticks.length - 1] ?? 1], [V.h - V.mb, V.mt]);
  const innerW = V.w - V.ml - V.mr;
  const band = innerW / Math.max(1, categories.length);
  const groupW = band * 0.72;
  const barW = groupW / series.length;
  const zeroY = y(0);
  // Category labels: cap at ~8 so 12 months don't collide at phone scale.
  const labelStep = Math.ceil(categories.length / 8);

  return (
    <svg
      {...a11y.attrs}
      viewBox={`0 0 ${V.w} ${V.h}`}
      className="h-auto w-full"
    >
      {a11y.children}
      {/* gridlines + tick labels */}
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={V.ml}
            x2={V.w - V.mr}
            y1={y(t)}
            y2={y(t)}
            className={t === 0 ? AXIS.zero : AXIS.grid}
            strokeWidth={1}
          />
          <text
            x={V.ml - 6}
            y={y(t) + 3}
            textAnchor="end"
            className={`${AXIS.label} text-[9px]`}
          >
            {formatValue(t)}
          </text>
        </g>
      ))}
      {/* bars */}
      {series.map((s, si) =>
        s.data.map((d, di) => {
          if (d.value === 0) return null; // honest: zero has no mark; the table still lists it
          const x = V.ml + band * di + (band - groupW) / 2 + barW * si;
          const vy = y(d.value);
          const top = Math.min(vy, zeroY);
          const h = Math.max(1, Math.abs(vy - zeroY));
          const cls = SERIES[d.tone ?? s.tone].fill;
          return (
            <rect
              key={`${s.name}-${d.label}-${di}`}
              data-chart-bar=""
              data-value={d.value}
              x={round2(x)}
              y={round2(top)}
              width={round2(Math.max(1, barW - 1))}
              height={round2(h)}
              rx={1.5}
              className={cls}
            >
              <title>{`${d.label} · ${s.name}: ${datumText(d)}`}</title>
            </rect>
          );
        }),
      )}
      {/* category labels */}
      {categories.map((label, i) =>
        i % labelStep === 0 ? (
          <text
            key={label + i}
            x={V.ml + band * i + band / 2}
            y={V.h - 6}
            textAnchor="middle"
            className={`${AXIS.label} text-[9px]`}
          >
            {label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function HorizontalBars({
  title,
  desc,
  data,
  tone,
  formatValue,
  showValues,
}: {
  title: string;
  desc: string;
  data: ChartDatum[];
  tone: ChartSeries["tone"];
  formatValue: (n: number) => string;
  showValues: boolean;
}) {
  const a11y = svgA11y(title, desc);
  const mt = 6;
  const mb = 16;
  const ml = 132; // room for job / customer labels
  const mr = showValues ? 64 : 10;
  const w = 480;
  const h = mt + data.length * ROW_H + mb;
  const [lo, hi] = extentWithZero(data.map((d) => d.value));
  const ticks = niceTicks(lo, lo === 0 && hi === 0 ? 1 : hi, 4);
  const x = linearScale([ticks[0] ?? 0, ticks[ticks.length - 1] ?? 1], [ml, w - mr]);
  const zeroX = x(0);

  return (
    <svg {...a11y.attrs} viewBox={`0 0 ${w} ${h}`} className="h-auto w-full">
      {a11y.children}
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={x(t)}
            x2={x(t)}
            y1={mt}
            y2={h - mb}
            className={t === 0 ? AXIS.zero : AXIS.grid}
            strokeWidth={1}
          />
          <text x={x(t)} y={h - 4} textAnchor="middle" className={`${AXIS.label} text-[9px]`}>
            {formatValue(t)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const rowY = mt + i * ROW_H;
        const barY = rowY + (ROW_H - 12) / 2;
        const vx = x(d.value);
        const left = Math.min(vx, zeroX);
        const bw = d.value === 0 ? 0 : Math.max(1, Math.abs(vx - zeroX));
        return (
          <g key={d.label + i}>
            <text
              x={ml - 8}
              y={rowY + ROW_H / 2 + 3}
              textAnchor="end"
              className={`${AXIS.label} text-[9px]`}
            >
              {truncate(d.label, 24)}
            </text>
            {bw > 0 ? (
              <rect
                data-chart-bar=""
                data-value={d.value}
                x={round2(left)}
                y={round2(barY)}
                width={round2(bw)}
                height={12}
                rx={1.5}
                className={SERIES[d.tone ?? tone].fill}
              >
                <title>{`${d.label}: ${datumText(d)}`}</title>
              </rect>
            ) : null}
            {showValues ? (
              <text
                x={w - 4}
                y={rowY + ROW_H / 2 + 3}
                textAnchor="end"
                className="fill-slate-700 text-[9px] font-medium"
              >
                {datumText(d)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
