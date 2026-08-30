import { linearScale, niceTicks, extentWithZero, compactNumber } from "./scale";
import { SERIES, type ChartSeries, datumText } from "./series";
import { ChartFrame, svgA11y, AXIS } from "./frame";

/**
 * LineChart / AreaChart — server-rendered pure-SVG time series.
 *
 * AreaChart is a single-series line with a SOLID `-100` fill between the line
 * and the ZERO baseline (never an opacity blend — tokens.ts doctrine), so a
 * negative stretch (e.g. cumulative cash dipping below zero) fills below the
 * axis instead of lying with a clipped floor. LineChart draws 2+ series with
 * a legend. Points carry native SVG <title> tooltips. No client JS, no
 * animation, zero business calculation — scaling only.
 */

const V = { w: 480, h: 200, mt: 8, mr: 10, mb: 22, ml: 44 };

export function LineChart(props: {
  title: string;
  desc: string;
  series: ChartSeries[];
  categoryHeader: string;
  formatValue?: (n: number) => string;
}) {
  return <LineArea {...props} area={false} />;
}

export function AreaChart(props: {
  title: string;
  desc: string;
  /** Single series — the area reads as ONE quantity over time. */
  series: ChartSeries[];
  categoryHeader: string;
  formatValue?: (n: number) => string;
}) {
  return <LineArea {...props} area />;
}

function LineArea({
  title,
  desc,
  series,
  categoryHeader,
  formatValue = compactNumber,
  area,
}: {
  title: string;
  desc: string;
  series: ChartSeries[];
  categoryHeader: string;
  formatValue?: (n: number) => string;
  area: boolean;
}) {
  return (
    <ChartFrame series={series} categoryHeader={categoryHeader} legend>
      <LineAreaSvg
        title={title}
        desc={desc}
        series={series}
        formatValue={formatValue}
        area={area}
      />
    </ChartFrame>
  );
}

function LineAreaSvg({
  title,
  desc,
  series,
  formatValue,
  area,
}: {
  title: string;
  desc: string;
  series: ChartSeries[];
  formatValue: (n: number) => string;
  area: boolean;
}) {
  const a11y = svgA11y(title, desc);
  const base = series.find((s) => s.data.length > 0)?.data ?? [];
  const values = series.flatMap((s) => s.data.map((d) => d.value));
  const [lo, hi] = extentWithZero(values);
  // All-zero data is data (an axis from 0), not a fake ±1 spread.
  const ticks = niceTicks(lo, lo === 0 && hi === 0 ? 1 : hi, 5);
  const y = linearScale([ticks[0] ?? 0, ticks[ticks.length - 1] ?? 1], [V.h - V.mb, V.mt]);
  const innerW = V.w - V.ml - V.mr;
  const xAt = (i: number) =>
    base.length <= 1 ? V.ml + innerW / 2 : V.ml + (innerW * i) / (base.length - 1);
  const zeroY = y(0);
  const labelStep = Math.ceil(base.length / 8);

  return (
    <svg {...a11y.attrs} viewBox={`0 0 ${V.w} ${V.h}`} className="h-auto w-full">
      {a11y.children}
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
          <text x={V.ml - 6} y={y(t) + 3} textAnchor="end" className={`${AXIS.label} text-[9px]`}>
            {formatValue(t)}
          </text>
        </g>
      ))}
      {series.map((s) => {
        const pts = s.data.map((d, i) => `${r2(xAt(i))},${r2(y(d.value))}`);
        const cls = SERIES[s.tone];
        return (
          <g key={s.name}>
            {area && s.data.length > 1 ? (
              <polygon
                data-chart-area=""
                className={cls.area}
                points={`${r2(xAt(0))},${r2(zeroY)} ${pts.join(" ")} ${r2(
                  xAt(s.data.length - 1),
                )},${r2(zeroY)}`}
              />
            ) : null}
            {s.data.length > 1 ? (
              <polyline
                data-chart-line=""
                points={pts.join(" ")}
                fill="none"
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                className={cls.stroke}
              />
            ) : null}
            {s.data.map((d, i) => (
              <circle
                key={d.label + i}
                cx={r2(xAt(i))}
                cy={r2(y(d.value))}
                r={2.5}
                className={cls.fill}
              >
                <title>{`${d.label} · ${s.name}: ${datumText(d)}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
      {base.map((d, i) =>
        i % labelStep === 0 ? (
          <text
            key={d.label + i}
            x={xAt(i)}
            y={V.h - 6}
            textAnchor="middle"
            className={`${AXIS.label} text-[9px]`}
          >
            {d.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
