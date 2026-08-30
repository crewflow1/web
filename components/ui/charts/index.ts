/**
 * CrewFlow canonical chart system (roadmap G4) — hand-rolled, server-rendered
 * pure SVG. ZERO dependencies (see the dependency decision in ./scale.ts):
 * no "use client" anywhere in this directory, no chart library, no CSP
 * surface, no bundle cost — tooltips are native SVG <title> elements.
 *
 * Every chart guarantees, by construction (ChartFrame / svgA11y):
 *   - role="img" + aria-label, <title>/<desc> inside the SVG;
 *   - a visually-hidden (sr-only) <table> of the plotted data — the
 *     accessible tabular alternative;
 *   - an honest "No data yet" panel when the series are empty — never a
 *     fake axis;
 *   - zero baseline, so mark size is proportional to value (unit-proven);
 *   - NO animation (nothing to gate on prefers-reduced-motion);
 *   - width-responsive via viewBox — scales to any container, 320px up;
 *   - light slate axes/gridlines + tone-token series colours
 *     (components/ui/tokens.ts vocabulary, spelled for SVG in ./series.ts).
 *
 * Charts NEVER compute business numbers: pages pass series already produced
 * by the canonical engines (lib/reports/aggregates, buildReportDocument
 * output, profitByMonth, …). The only maths in this directory is coordinate
 * scaling and UTC month bucketing (./scale.ts, pure + unit-tested).
 */

export { BarChart } from "./bar-chart";
export { LineChart, AreaChart } from "./line-chart";
export { DonutChart } from "./donut-chart";
export { Sparkline } from "./sparkline";
export { ChartLegend } from "./legend";
export {
  linearScale,
  niceNum,
  niceTicks,
  extentWithZero,
  compactNumber,
  monthKeyUTC,
  lastNMonthKeysUTC,
  bucketByMonthUTC,
  type MonthBucketPoint,
} from "./scale";
export { SERIES, type ChartDatum, type ChartSeries, type SeriesClasses } from "./series";
