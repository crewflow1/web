/**
 * CrewFlow chart system — pure scale / axis / bucketing maths.
 *
 * DEPENDENCY DECISION (canonical chart system, roadmap G4).
 * Evaluated: recharts, visx, hand-rolled SVG.
 *   - recharts (~100KB min+gz + d3 transitive tree) is CLIENT-ONLY — every
 *     chart would drag a "use client" boundary plus its bundle into pages that
 *     are 100% server-rendered today, and its default styling fights the
 *     light slate design system.
 *   - visx is tree-shakeable but still a client-oriented d3 wrapper family
 *     (~15-40KB per chart type once scales/shapes/axis packages are pulled in),
 *     and the repo has a deliberate zero-chart-lib posture (see the /reports
 *     header: "Bars are pure CSS — no chart library, no bundle cost").
 *   - hand-rolled pure-SVG: zero dependencies, fully server-renderable (no
 *     "use client" anywhere in components/ui/charts), no CSP surface, nothing
 *     to tree-shake because there is nothing to ship to the client, and the
 *     scale maths lives HERE as pure exported functions the unit tier proves.
 * VERDICT: hand-rolled SVG. The smallest appropriate dependency is none —
 * the charts we draw (bars, lines, areas, donut, sparkline) need ~200 lines
 * of linear algebra, not a charting runtime. Native SVG <title> elements give
 * hover tooltips with zero client JS, so even interactivity costs nothing.
 *
 * Everything in this file is PURE: no Date.now() defaults hidden from
 * callers' control (callers may pass `now`), no I/O, no mutation of inputs —
 * __tests__/ui/charts.test.ts proves purity and the tick/scale contracts.
 *
 * CHARTS NEVER COMPUTE BUSINESS NUMBERS. These helpers scale and bucket
 * ALREADY-COMPUTED series (lib/reports/aggregates, buildReportDocument
 * output, profitByMonth, …); the only arithmetic here is coordinate maths.
 */

/**
 * Linear scale: maps `domain` onto `range`. A degenerate domain (min === max)
 * maps every value to the middle of the range rather than dividing by zero.
 */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Round `x` to a "nice" number (1/2/5 × 10^k). `round` picks nearest vs ceil. */
export function niceNum(x: number, round: boolean): number {
  if (x === 0) return 0;
  const exp = Math.floor(Math.log10(Math.abs(x)));
  const f = Math.abs(x) / 10 ** exp; // fraction in [1, 10)
  let nf: number;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return Math.sign(x) * nf * 10 ** exp;
}

/**
 * Nice axis ticks covering [min, max]: ascending, evenly spaced at a 1/2/5
 * step, first tick ≤ min and last tick ≥ max, so plotting to
 * [ticks[0], ticks[last]] never clips a datum. Degenerate input (min === max)
 * widens by ±1 so an axis always has extent. Always ≥ 2 ticks.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const step = niceNum(niceNum(hi - lo, false) / Math.max(1, count - 1), true);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  // Guard float drift: half-step epsilon keeps the final tick included.
  for (let v = start; v <= end + step / 2; v += step) {
    // Snap floating point noise (0.30000000000000004 → 0.3).
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  }
  return ticks;
}

/**
 * The plotting domain for magnitude data: [min(0, data), max(0, data)] — a
 * bar/area baseline must sit at zero or the mark's SIZE lies about the value.
 */
export function extentWithZero(values: readonly number[]): [number, number] {
  let min = 0;
  let max = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/**
 * Compact tick label: 1200 → "1.2k", 3_400_000 → "3.4m", -950 → "-950".
 * Presentation only — pages pass their own currency formatter where the axis
 * is money.
 */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${trimZero(abs / 1_000_000)}m`;
  if (abs >= 1_000) return `${sign}${trimZero(abs / 1_000)}k`;
  return `${sign}${trimZero(abs)}`;
}

function trimZero(v: number): string {
  const s = (Math.round(v * 10) / 10).toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

// ---------------------------------------------------------------------------
// Date bucketing — UTC month buckets, the SAME keying as
// lib/reports/aggregates.revenuePerMonth (isoDate(startOfMonth)) so a series
// bucketed here lines up with the reports engine's month keys.
// ---------------------------------------------------------------------------

/** "YYYY-MM-01" for the UTC month containing the instant. */
export function monthKeyUTC(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/** The last `n` UTC month keys ending at `now`'s month, oldest first. */
export function lastNMonthKeysUTC(n: number, now: Date): string[] {
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(monthKeyUTC(d));
  }
  return keys;
}

export type MonthBucketPoint = { month: string; value: number };

/**
 * Sum `value(row)` into the last `months` UTC month buckets by `date(row)`.
 * Rows with a null/invalid date or a date outside the window are skipped.
 * Pure: does not mutate `rows`, and `now` is an explicit input.
 */
export function bucketByMonthUTC<T>(
  rows: readonly T[],
  opts: {
    date: (row: T) => string | null;
    value: (row: T) => number;
    months: number;
    now: Date;
  },
): MonthBucketPoint[] {
  const keys = lastNMonthKeysUTC(opts.months, opts.now);
  const sums = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const row of rows) {
    const iso = opts.date(row);
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const key = monthKeyUTC(d);
    if (!sums.has(key)) continue; // outside the window
    const v = opts.value(row);
    if (!Number.isFinite(v)) continue;
    sums.set(key, (sums.get(key) ?? 0) + v);
  }
  return keys.map((month) => ({
    month,
    value: Math.round(((sums.get(month) ?? 0) + Number.EPSILON) * 100) / 100,
  }));
}
