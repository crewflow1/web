import type { Tone } from "../tokens";
import { linearScale, extentWithZero } from "./scale";
import { SERIES, type ChartDatum, datumText } from "./series";
import { svgA11y } from "./frame";

/**
 * Sparkline — a tiny axis-less trend mark for KPI tiles. Same guarantees as
 * every chart in this system: honest empty state, sr-only data table,
 * role="img" + <title>/<desc>, zero baseline in the fill, no animation, no
 * client JS. The precise numbers belong to the surrounding tile / table —
 * the sparkline only shows shape.
 */
export function Sparkline({
  title,
  desc,
  data,
  tone = "indigo",
  categoryHeader = "Period",
  valueHeader = "Value",
}: {
  title: string;
  desc: string;
  data: ChartDatum[];
  tone?: Tone;
  categoryHeader?: string;
  valueHeader?: string;
}) {
  const last = data[data.length - 1];
  if (!last) {
    return <span className="text-xs text-slate-500">No data yet</span>;
  }
  const w = 160;
  const h = 40;
  const pad = 3;
  const [lo, hi] = extentWithZero(data.map((d) => d.value));
  const y = linearScale([lo, hi], [h - pad, pad]);
  const x = (i: number) =>
    data.length <= 1 ? w / 2 : pad + ((w - 2 * pad) * i) / (data.length - 1);
  const zeroY = y(0);
  const pts = data.map((d, i) => `${r2(x(i))},${r2(y(d.value))}`);
  const cls = SERIES[tone];
  const a11y = svgA11y(title, desc);

  return (
    <span className="block">
      <svg
        {...a11y.attrs}
        viewBox={`0 0 ${w} ${h}`}
        className="h-10 w-full max-w-[12rem]"
        preserveAspectRatio="none"
      >
        {a11y.children}
        {data.length > 1 ? (
          <polygon
            data-chart-area=""
            className={cls.area}
            points={`${r2(x(0))},${r2(zeroY)} ${pts.join(" ")} ${r2(x(data.length - 1))},${r2(zeroY)}`}
          />
        ) : null}
        {data.length > 1 ? (
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
        <circle cx={r2(x(data.length - 1))} cy={r2(y(last.value))} r={2.5} className={cls.fill}>
          <title>{`${last.label}: ${datumText(last)}`}</title>
        </circle>
      </svg>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{categoryHeader}</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={d.label + i}>
              <th scope="row">{d.label}</th>
              <td>{datumText(d)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </span>
  );
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
