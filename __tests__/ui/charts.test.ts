import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  linearScale,
  niceNum,
  niceTicks,
  extentWithZero,
  compactNumber,
  monthKeyUTC,
  lastNMonthKeysUTC,
  bucketByMonthUTC,
} from "@/components/ui/charts/scale";
import { BarChart } from "@/components/ui/charts/bar-chart";
import { AreaChart } from "@/components/ui/charts/line-chart";
import { Sparkline } from "@/components/ui/charts/sparkline";
import type { ChartSeries } from "@/components/ui/charts/series";

/**
 * Canonical chart system (components/ui/charts) — the three contracts that
 * keep a chart honest:
 *
 *   1. The scale/bucketing utils are PURE functions with provable behaviour
 *      (nice ticks cover the data, linear scale maps endpoints, month
 *      bucketing doesn't mutate or invent rows).
 *   2. A rendered bar's SIZE is PROPORTIONAL to its value — zero baseline,
 *      linear scale, no truncated axis. Proven by rendering a BarChart to
 *      string and parsing the actual rect geometry.
 *   3. Every chart ships its accessibility contract: role="img" +
 *      <title>/<desc> on the SVG and an sr-only <table> of the data; empty
 *      data renders an honest "No data yet" panel, never a fake axis.
 *
 * Plus a SOURCE CONTRACT: the four adoption surfaces (reports home, cashflow,
 * profit, dashboard revenue trend) render through components/ui/charts — if
 * one regresses to a bespoke bar renderer, this fails.
 */

// ---------------------------------------------------------------------------
// 1. Scale utils — pure and correct
// ---------------------------------------------------------------------------

describe("linearScale", () => {
  it("maps domain endpoints to range endpoints and interpolates linearly", () => {
    const s = linearScale([0, 100], [200, 0]);
    expect(s(0)).toBe(200);
    expect(s(100)).toBe(0);
    expect(s(50)).toBe(100);
    expect(s(25)).toBe(150);
  });

  it("handles a degenerate domain without dividing by zero", () => {
    const s = linearScale([5, 5], [0, 100]);
    expect(s(5)).toBe(50);
    expect(Number.isFinite(s(999))).toBe(true);
  });

  it("is pure: same inputs, same outputs", () => {
    const a = linearScale([0, 10], [0, 1]);
    const b = linearScale([0, 10], [0, 1]);
    for (const v of [-3, 0, 2.5, 10, 17]) expect(a(v)).toBe(b(v));
  });
});

describe("niceNum", () => {
  it("rounds to 1/2/5 × 10^k", () => {
    expect(niceNum(0.7, true)).toBe(0.5);
    expect(niceNum(2.4, true)).toBe(2);
    expect(niceNum(3.4, true)).toBe(5); // Heckbert rounding: f < 3 → 2, else 5
    expect(niceNum(6, true)).toBe(5);
    expect(niceNum(8, true)).toBe(10);
    expect(niceNum(1234, false)).toBe(2000);
    expect(niceNum(0, true)).toBe(0);
  });
});

describe("niceTicks", () => {
  it("covers [min, max]: first tick ≤ min, last tick ≥ max", () => {
    for (const [min, max] of [
      [0, 97],
      [-45, 130],
      [3, 3.2],
      [-1000, -10],
      [0.001, 0.009],
    ] as const) {
      const ticks = niceTicks(min, max);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks[0]).toBeLessThanOrEqual(min);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
    }
  });

  it("is ascending and evenly spaced", () => {
    const ticks = niceTicks(-45, 130, 5);
    const step = (ticks[1] ?? 0) - (ticks[0] ?? 0);
    for (let i = 1; i < ticks.length; i++) {
      expect((ticks[i] ?? 0) - (ticks[i - 1] ?? 0)).toBeCloseTo(step, 9);
    }
  });

  it("widens a degenerate domain instead of collapsing", () => {
    const ticks = niceTicks(7, 7);
    expect(ticks[0]).toBeLessThan(7);
    expect(ticks[ticks.length - 1]).toBeGreaterThan(7);
  });

  it("snaps the zero tick to exactly 0", () => {
    const ticks = niceTicks(-0.3, 0.7, 5);
    expect(ticks).toContain(0);
  });
});

describe("extentWithZero", () => {
  it("always includes zero so bar/area baselines are honest", () => {
    expect(extentWithZero([5, 20])).toEqual([0, 20]);
    expect(extentWithZero([-8, -2])).toEqual([-8, 0]);
    expect(extentWithZero([-3, 9])).toEqual([-3, 9]);
    expect(extentWithZero([])).toEqual([0, 0]);
  });

  it("ignores non-finite values", () => {
    expect(extentWithZero([NaN, Infinity, 4])).toEqual([0, 4]);
  });
});

describe("compactNumber", () => {
  it("formats thousands/millions compactly", () => {
    expect(compactNumber(0)).toBe("0");
    expect(compactNumber(950)).toBe("950");
    expect(compactNumber(1200)).toBe("1.2k");
    expect(compactNumber(20000)).toBe("20k");
    expect(compactNumber(3_400_000)).toBe("3.4m");
    expect(compactNumber(-1500)).toBe("-1.5k");
  });
});

describe("month bucketing (UTC, aggregates-aligned keys)", () => {
  const now = new Date("2026-08-29T10:00:00Z");

  it("keys months as YYYY-MM-01, matching lib/reports/aggregates", () => {
    expect(monthKeyUTC("2026-08-29T23:59:59Z")).toBe("2026-08-01");
    expect(monthKeyUTC("2026-01-01T00:00:00Z")).toBe("2026-01-01");
  });

  it("produces the last N month keys oldest-first, crossing year boundaries", () => {
    expect(lastNMonthKeysUTC(6, now)).toEqual([
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
    ]);
    expect(lastNMonthKeysUTC(3, new Date("2026-01-15T00:00:00Z"))).toEqual([
      "2025-11-01",
      "2025-12-01",
      "2026-01-01",
    ]);
  });

  it("sums into the right buckets and skips null / out-of-window / bad rows", () => {
    const rows = [
      { paid_at: "2026-08-05T12:00:00Z", amount: 100.5 },
      { paid_at: "2026-08-20T12:00:00Z", amount: 49.5 },
      { paid_at: "2026-06-01T00:00:00Z", amount: 25 },
      { paid_at: null, amount: 999 }, // undated → skipped
      { paid_at: "2020-01-01T00:00:00Z", amount: 999 }, // out of window → skipped
      { paid_at: "not-a-date", amount: 999 }, // invalid → skipped
      { paid_at: "2026-08-21T12:00:00Z", amount: NaN }, // non-finite → skipped
    ];
    const out = bucketByMonthUTC(rows, {
      date: (r) => r.paid_at,
      value: (r) => r.amount,
      months: 6,
      now,
    });
    expect(out).toEqual([
      { month: "2026-03-01", value: 0 },
      { month: "2026-04-01", value: 0 },
      { month: "2026-05-01", value: 0 },
      { month: "2026-06-01", value: 25 },
      { month: "2026-07-01", value: 0 },
      { month: "2026-08-01", value: 150 },
    ]);
  });

  it("is pure: does not mutate its input and is deterministic for a fixed now", () => {
    const rows = [{ paid_at: "2026-07-01T00:00:00Z", amount: 10 }];
    const snapshot = JSON.stringify(rows);
    const a = bucketByMonthUTC(rows, { date: (r) => r.paid_at, value: (r) => r.amount, months: 2, now });
    const b = bucketByMonthUTC(rows, { date: (r) => r.paid_at, value: (r) => r.amount, months: 2, now });
    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// 2. Rendered proportionality — bar geometry vs input values
// ---------------------------------------------------------------------------

/** Parse every data-chart-bar rect's {value, height, width} out of rendered SVG markup. */
function parseBars(html: string): Array<{ value: number; height: number; width: number }> {
  const bars: Array<{ value: number; height: number; width: number }> = [];
  for (const tag of html.match(/<rect\b[^>]*data-chart-bar[^>]*>/g) ?? []) {
    const value = Number(/data-value="(-?[\d.]+)"/.exec(tag)?.[1]);
    const height = Number(/height="(-?[\d.]+)"/.exec(tag)?.[1]);
    const width = Number(/width="(-?[\d.]+)"/.exec(tag)?.[1]);
    bars.push({ value, height, width });
  }
  return bars;
}

const singleSeries = (values: number[]): ChartSeries[] => [
  {
    name: "Revenue",
    tone: "indigo",
    data: values.map((value, i) => ({ label: `M${i + 1}`, value, text: `£${value}` })),
  },
];

describe("BarChart proportionality", () => {
  it("vertical bar heights are proportional to the input values", () => {
    const html = renderToStaticMarkup(
      createElement(BarChart, {
        title: "Revenue per month",
        desc: "Test chart",
        series: singleSeries([100, 200, 400]),
        categoryHeader: "Month",
      }),
    );
    const bars = parseBars(html);
    expect(bars.map((b) => b.value)).toEqual([100, 200, 400]);
    const h100 = bars[0]!.height;
    expect(bars[1]!.height / h100).toBeCloseTo(2, 1);
    expect(bars[2]!.height / h100).toBeCloseTo(4, 1);
  });

  it("horizontal bar widths are proportional too, including a negative bar", () => {
    const html = renderToStaticMarkup(
      createElement(BarChart, {
        title: "Margin by job",
        desc: "Test chart",
        series: singleSeries([30, -15, 60]),
        categoryHeader: "Job",
        orientation: "horizontal" as const,
      }),
    );
    const bars = parseBars(html);
    expect(bars.map((b) => b.value)).toEqual([30, -15, 60]);
    expect(bars[2]!.width / bars[0]!.width).toBeCloseTo(2, 1);
    expect(bars[1]!.width / bars[0]!.width).toBeCloseTo(0.5, 1);
  });
});

describe("chart geometry stays inside the viewBox", () => {
  const nums = (html: string, attr: string): number[] =>
    [...html.matchAll(new RegExp(`\\b${attr}="(-?[\\d.]+)"`, "g"))].map((m) => Number(m[1]));

  it("grouped bars and a negative-dipping area never overflow 480×200", () => {
    const grouped = renderToStaticMarkup(
      createElement(BarChart, {
        title: "VAT per quarter",
        desc: "Test",
        series: [
          {
            name: "Output",
            tone: "emerald" as const,
            data: [1000, 2500, 0, 1800].map((v, i) => ({ label: `Q${i + 1}`, value: v, text: `£${v}` })),
          },
          {
            name: "Input",
            tone: "amber" as const,
            data: [400, 900, 0, 2200].map((v, i) => ({ label: `Q${i + 1}`, value: v, text: `£${v}` })),
          },
        ],
        categoryHeader: "Quarter",
      }),
    );
    const area = renderToStaticMarkup(
      createElement(AreaChart, {
        title: "Cumulative cash",
        desc: "Test",
        series: [
          {
            name: "Cumulative",
            tone: "indigo" as const,
            data: [500, -300, -900, 200, 1200].map((v, i) => ({ label: `W${i + 1}`, value: v, text: `£${v}` })),
          },
        ],
        categoryHeader: "Week",
      }),
    );
    for (const html of [grouped, area]) {
      const xs = [...nums(html, "x"), ...nums(html, "cx"), ...nums(html, "x1"), ...nums(html, "x2")];
      const ys = [...nums(html, "y"), ...nums(html, "cy"), ...nums(html, "y1"), ...nums(html, "y2")];
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...xs)).toBeLessThanOrEqual(480);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...ys)).toBeLessThanOrEqual(200);
    }
    // Zeros draw no bar (honest), so 2 series × 4 quarters − 2 zeros = 6 bars.
    expect((grouped.match(/data-chart-bar/g) ?? []).length).toBe(6);
    // The negative dip still renders: area polygon + line + a zero gridline.
    expect(area).toContain("data-chart-area");
    expect(area).toContain("data-chart-line");
    expect(area).toContain("stroke-slate-300");
  });
});

// ---------------------------------------------------------------------------
// 3. Accessibility contract + honest empty state
// ---------------------------------------------------------------------------

describe("chart accessibility contract", () => {
  const html = renderToStaticMarkup(
    createElement(BarChart, {
      title: "Revenue per month",
      desc: "Monthly revenue from paid invoices.",
      series: singleSeries([100, 200]),
      categoryHeader: "Month",
    }),
  );

  it("SVG carries role=img, aria-label and <title>/<desc>", () => {
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Revenue per month"');
    expect(html).toContain("<title>Revenue per month</title>");
    expect(html).toContain("<desc>Monthly revenue from paid invoices.</desc>");
  });

  it("renders an sr-only table of the plotted data", () => {
    expect(html).toMatch(/<table class="sr-only"/);
    expect(html).toContain("<th scope=\"col\">Month</th>");
    expect(html).toContain("£100");
    expect(html).toContain("£200");
  });

  it("per-bar native tooltips carry label and preformatted value", () => {
    expect(html).toContain("<title>M1 · Revenue: £100</title>");
  });

  it("empty data renders an honest panel, never a fake axis", () => {
    const empty = renderToStaticMarkup(
      createElement(BarChart, {
        title: "Revenue per month",
        desc: "Test",
        series: [{ name: "Revenue", tone: "indigo" as const, data: [] }],
        categoryHeader: "Month",
      }),
    );
    expect(empty).toContain("No data yet");
    expect(empty).not.toContain("<svg");
  });

  it("AreaChart and Sparkline honour the same table + a11y contract", () => {
    const area = renderToStaticMarkup(
      createElement(AreaChart, {
        title: "Cumulative cash",
        desc: "Test",
        series: [
          {
            name: "Cumulative",
            tone: "indigo" as const,
            data: [
              { label: "W1", value: 10, text: "£10" },
              { label: "W2", value: -5, text: "-£5" },
            ],
          },
        ],
        categoryHeader: "Week",
      }),
    );
    expect(area).toContain('role="img"');
    expect(area).toMatch(/<table class="sr-only"/);
    expect(area).toContain("data-chart-area");

    const spark = renderToStaticMarkup(
      createElement(Sparkline, {
        title: "Paid revenue trend",
        desc: "Test",
        data: [
          { label: "Jul", value: 5, text: "£5" },
          { label: "Aug", value: 9, text: "£9" },
        ],
      }),
    );
    expect(spark).toContain('role="img"');
    expect(spark).toMatch(/<table class="sr-only"/);
    expect(spark).toContain("£9");
    expect(
      renderToStaticMarkup(createElement(Sparkline, { title: "t", desc: "d", data: [] })),
    ).toContain("No data yet");
  });
});

// ---------------------------------------------------------------------------
// 4. Source contract — the adoption sites render through the chart system
// ---------------------------------------------------------------------------

describe("chart system adoption (source contract)", () => {
  const ROOT = resolve(__dirname, "../..");
  const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

  const ADOPTERS = [
    "app/(app)/reports/page.tsx",
    "app/(app)/reports/cashflow/page.tsx",
    "app/(app)/reports/profit/page.tsx",
    "app/(app)/dashboard/_revenue-trend.tsx",
  ];

  it.each(ADOPTERS)("%s imports from components/ui/charts", (file) => {
    expect(read(file)).toMatch(/from "@\/components\/ui\/charts"/);
  });

  it("dashboard mounts the revenue trend from the page's already-fetched invoices", () => {
    const page = read("app/(app)/dashboard/page.tsx");
    expect(page).toMatch(/from "\.\/_revenue-trend"/);
    expect(page).toMatch(/<RevenueTrend invoices=\{invoices\}/);
  });
});
