import { describe, expect, it } from "vitest";
import {
  buildProgressCurve,
  buildProgressSeries,
  readPercent,
  readReportPercent,
  summariseProgress,
  PROGRESS_STALE_AFTER_DAYS,
  PROGRESS_TREND_LABELS,
  REPORTED_PROGRESS_STATUSES,
  type ProgressObservationRow,
  type ProgressPoint,
  type SiteReportProgressRow,
} from "@/lib/job-progress/series";
import {
  PORTAL_MOVEMENT_LABELS,
  toPortalProgress,
} from "@/lib/job-progress/portal";

/**
 * Job progress — the pure series, trend and curve.
 *
 * Everything here runs without a database: the lib takes rows in and returns a
 * series, a verdict and coordinates. `now` is always injected, so no assertion
 * depends on the day the suite runs.
 */

const obs = (
  id: string,
  observed_on: string,
  percent: number | string,
  extra: Partial<ProgressObservationRow> = {},
): ProgressObservationRow => ({
  id,
  observed_on,
  percent,
  note: null,
  recorded_by: null,
  ...extra,
});

const report = (
  id: string,
  period_end: string,
  progress_percent: unknown,
  status = "issued",
): SiteReportProgressRow => ({
  id,
  status,
  period_end,
  report_number: `SR-${id}`,
  content: { progress_percent, summary: "internal commentary" },
});

describe("readPercent", () => {
  it("accepts integers, numeric strings and rounds in-range decimals", () => {
    expect(readPercent(0)).toBe(0);
    expect(readPercent(100)).toBe(100);
    expect(readPercent("62")).toBe(62);
    expect(readPercent(62.5)).toBe(63);
  });

  it("DROPS out-of-range and unparseable values rather than clamping them", () => {
    // Clamping 400% to 100% would invent a fact; the point is skipped instead.
    expect(readPercent(400)).toBeNull();
    expect(readPercent(-1)).toBeNull();
    expect(readPercent("about half")).toBeNull();
    expect(readPercent(null)).toBeNull();
    expect(readPercent(undefined)).toBeNull();
    expect(readPercent("")).toBeNull();
    expect(readPercent(true)).toBeNull();
  });

  it("reads progress_percent out of a site report's content jsonb", () => {
    expect(readReportPercent({ progress_percent: 40 })).toBe(40);
    expect(readReportPercent({})).toBeNull();
    expect(readReportPercent(null)).toBeNull();
    expect(readReportPercent([1, 2])).toBeNull();
    expect(readReportPercent("nope")).toBeNull();
  });
});

describe("buildProgressSeries — one source of truth", () => {
  it("merges observations and qualifying site reports, oldest first", () => {
    const points = buildProgressSeries({
      observations: [obs("o1", "2026-03-10", 20)],
      reports: [report("r1", "2026-03-20", 35)],
    });
    expect(points.map((p) => [p.day, p.percent, p.source])).toEqual([
      ["2026-03-10", 20, "observation"],
      ["2026-03-20", 35, "site_report"],
    ]);
  });

  it("reads report figures rather than requiring them to be copied in", () => {
    // The whole point of the design: with NO observations at all, a job that
    // has only ever been reported on still has a series.
    const points = buildProgressSeries({
      reports: [report("r1", "2026-03-01", 10), report("r2", "2026-04-01", 45)],
    });
    expect(points.map((p) => p.percent)).toEqual([10, 45]);
    expect(points.every((p) => p.source === "site_report")).toBe(true);
    expect(points[0]?.reference).toBe("SR-r1");
  });

  it("only admits reports whose figure has been put forward", () => {
    const statuses = [
      "draft",
      "ready_for_review",
      "approved",
      "issued",
      "superseded",
      "archived",
    ];
    const admitted = statuses.filter(
      (status) =>
        buildProgressSeries({ reports: [report("r", "2026-05-01", 50, status)] })
          .length === 1,
    );
    expect(admitted).toEqual([...REPORTED_PROGRESS_STATUSES]);
    // Named explicitly so a widening is a deliberate edit, not a drift.
    expect(admitted).toEqual(["ready_for_review", "approved", "issued"]);
  });

  it("a manual observation BEATS a report on the same day", () => {
    const points = buildProgressSeries({
      observations: [obs("o1", "2026-06-01", 55, { note: "measured on site" })],
      reports: [report("r1", "2026-06-01", 70)],
    });
    expect(points).toHaveLength(1);
    expect(points[0]?.percent).toBe(55);
    expect(points[0]?.source).toBe("observation");
  });

  it("is permutation-independent (row arrival order cannot change output)", () => {
    const observations = [
      obs("o3", "2026-03-03", 30),
      obs("o1", "2026-03-01", 10),
      obs("o2", "2026-03-02", 20),
    ];
    const reports = [report("rB", "2026-03-05", 50), report("rA", "2026-03-04", 40)];
    const forward = buildProgressSeries({ observations, reports });
    const reversed = buildProgressSeries({
      observations: [...observations].reverse(),
      reports: [...reports].reverse(),
    });
    expect(reversed).toEqual(forward);
    expect(forward.map((p) => p.day)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
    ]);
  });

  it("skips malformed rows instead of blanking the curve or inventing a zero", () => {
    const points = buildProgressSeries({
      observations: [obs("good", "2026-03-01", 40), obs("bad", "not-a-date", 50)],
      reports: [report("r-bad", "2026-03-09", "unknown")],
    });
    expect(points.map((p) => p.percent)).toEqual([40]);
  });

  it("buckets a timestamp under its LONDON day, not the UTC day", () => {
    // 23:30 UTC on 30 June is 00:30 BST on 1 July — the UK day is the 1st.
    const points = buildProgressSeries({
      reports: [
        {
          id: "r1",
          status: "issued",
          period_end: "2026-06-30T23:30:00.000Z",
          report_number: "SR-1",
          content: { progress_percent: 50 },
        },
      ],
    });
    expect(points[0]?.day).toBe("2026-07-01");
  });
});

describe("summariseProgress — the trend model", () => {
  const now = new Date("2026-06-10T09:00:00Z");
  const series = (...rows: Array<[string, number]>): ProgressPoint[] =>
    buildProgressSeries({
      observations: rows.map(([day, pct], i) => obs(`o${i}`, day, pct)),
    });

  it("reports nothing recorded", () => {
    const s = summariseProgress([], now);
    expect(s.trend).toBe("none");
    expect(s.percent).toBeNull();
    expect(s.delta).toBeNull();
    expect(s.daysSinceUpdate).toBeNull();
    expect(s.stale).toBe(false);
  });

  it("a single reading is a starting point, not a direction", () => {
    const s = summariseProgress(series(["2026-06-08", 30]), now);
    expect(s.trend).toBe("first");
    expect(s.percent).toBe(30);
    expect(s.delta).toBeNull();
    expect(s.daysSinceUpdate).toBe(2);
  });

  it("progressing when the last move was up and the series is fresh", () => {
    const s = summariseProgress(series(["2026-06-01", 30], ["2026-06-09", 45]), now);
    expect(s.trend).toBe("progressing");
    expect(s.delta).toBe(15);
    expect(s.stale).toBe(false);
  });

  it("stalled when the last move was flat", () => {
    const s = summariseProgress(series(["2026-06-01", 45], ["2026-06-09", 45]), now);
    expect(s.trend).toBe("stalled");
    expect(s.delta).toBe(0);
  });

  it("stalled when the figure went UP but the series has gone quiet", () => {
    // Advanced three months ago and silent since: calling that "progressing"
    // would be a lie the badge tells every time the page renders.
    const s = summariseProgress(series(["2026-03-01", 30], ["2026-03-08", 60]), now);
    expect(s.trend).toBe("stalled");
    expect(s.delta).toBe(30);
    expect(s.stale).toBe(true);
    expect(s.daysSinceUpdate).toBeGreaterThan(PROGRESS_STALE_AFTER_DAYS);
  });

  it("the stale threshold is exclusive at the boundary", () => {
    const at = summariseProgress(series(["2026-05-20", 10], ["2026-05-27", 20]), now);
    expect(at.daysSinceUpdate).toBe(14);
    expect(at.stale).toBe(false);
    expect(at.trend).toBe("progressing");

    const past = summariseProgress(series(["2026-05-20", 10], ["2026-05-26", 20]), now);
    expect(past.daysSinceUpdate).toBe(15);
    expect(past.stale).toBe(true);
    expect(past.trend).toBe("stalled");
  });

  // ── THE REGRESSION CASE ───────────────────────────────────────────────────
  it("PROGRESS CAN GO DOWN — a regression is reported, never suppressed", () => {
    // Rework, or a rejected inspection: 70% on Monday, 55% after the re-measure.
    const s = summariseProgress(series(["2026-06-02", 70], ["2026-06-09", 55]), now);
    expect(s.trend).toBe("regressed");
    expect(s.delta).toBe(-15);
    expect(s.percent).toBe(55);
    expect(PROGRESS_TREND_LABELS[s.trend]).toBe("Went backwards");
  });

  it("a regression is not clipped to the previous high anywhere in the series", () => {
    const s = summariseProgress(
      series(["2026-06-01", 40], ["2026-06-05", 80], ["2026-06-09", 60]),
      now,
    );
    expect(s.points.map((p) => p.percent)).toEqual([40, 80, 60]);
    expect(s.trend).toBe("regressed");
  });

  it("regressed OUTRANKS stalled, and staleness is still reported alongside", () => {
    const s = summariseProgress(series(["2026-03-01", 70], ["2026-03-05", 50]), now);
    expect(s.trend).toBe("regressed");
    // Nothing is hidden by that precedence — the UI still shows "last updated".
    expect(s.stale).toBe(true);
    expect(s.daysSinceUpdate).toBeGreaterThan(PROGRESS_STALE_AFTER_DAYS);
  });

  it("a regression to 0% is representable", () => {
    const s = summariseProgress(series(["2026-06-01", 25], ["2026-06-09", 0]), now);
    expect(s.percent).toBe(0);
    expect(s.trend).toBe("regressed");
    expect(s.delta).toBe(-25);
  });

  it("never reports a negative days-since for a future-dated report figure", () => {
    const s = summariseProgress(series(["2026-06-20", 80]), now);
    expect(s.daysSinceUpdate).toBe(0);
  });

  it("reports the span the series covers", () => {
    const s = summariseProgress(series(["2026-05-01", 10], ["2026-06-09", 40]), now);
    expect(s.spanDays).toBe(39);
  });
});

describe("buildProgressCurve — geometry, no charting dependency", () => {
  const pts = (...rows: Array<[string, number]>): ProgressPoint[] =>
    buildProgressSeries({
      observations: rows.map(([day, pct], i) => obs(`o${i}`, day, pct)),
    });

  it("returns an empty, still-renderable curve for an empty series", () => {
    const c = buildProgressCurve([]);
    expect(c.points).toEqual([]);
    expect(c.polyline).toBe("");
    expect(c.areaPath).toBe("");
    expect(c.domain).toBeNull();
    expect(c.gridlines).toHaveLength(5);
  });

  it("uses the FULL 0-100 y domain, never auto-scaling to the data", () => {
    // A 58→61% fortnight must not fill the panel and read as a surge.
    const flat = buildProgressCurve(pts(["2026-06-01", 58], ["2026-06-15", 61]), {
      width: 100,
      height: 100,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(flat.points[0]?.y).toBe(42); // 100 * (1 - 0.58)
    expect(flat.points[1]?.y).toBe(39); // 100 * (1 - 0.61)
    // The whole line occupies 3% of the height, exactly as reality does.
    expect(Math.abs(flat.points[0]!.y - flat.points[1]!.y)).toBe(3);
  });

  it("maps 0% to the bottom and 100% to the top of the plot area", () => {
    const c = buildProgressCurve(pts(["2026-06-01", 0], ["2026-06-02", 100]), {
      width: 200,
      height: 100,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(c.points[0]?.y).toBe(100);
    expect(c.points[1]?.y).toBe(0);
    expect(c.points[0]?.x).toBe(0);
    expect(c.points[1]?.x).toBe(200);
  });

  it("spaces x by ELAPSED DAYS, not by index", () => {
    // Readings on day 0, 1 and 11: the last gap is ten times the first.
    const c = buildProgressCurve(
      pts(["2026-06-01", 10], ["2026-06-02", 20], ["2026-06-12", 30]),
      { width: 110, height: 100, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    );
    expect(c.points.map((p) => p.x)).toEqual([0, 10, 110]);
  });

  it("centres a lone reading rather than pinning it to the left edge", () => {
    const c = buildProgressCurve(pts(["2026-06-01", 40]), {
      width: 200,
      height: 100,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(c.points[0]?.x).toBe(100);
    expect(c.areaPath).toBe("");
    expect(c.polyline).toBe("100,60");
  });

  it("draws a regression as a line that goes DOWN on screen", () => {
    const c = buildProgressCurve(pts(["2026-06-01", 70], ["2026-06-08", 55]), {
      width: 100,
      height: 100,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    // SVG y grows downward, so a fall in percent is a RISE in y.
    expect(c.points[1]!.y).toBeGreaterThan(c.points[0]!.y);
  });

  it("emits a closed area path only once there are two points", () => {
    const c = buildProgressCurve(pts(["2026-06-01", 20], ["2026-06-03", 40]), {
      width: 100,
      height: 100,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(c.areaPath.startsWith("M 0 100")).toBe(true);
    expect(c.areaPath.endsWith("Z")).toBe(true);
    expect(c.domain).toEqual({ from: "2026-06-01", to: "2026-06-03" });
  });

  it("emits NO planned/baseline series — there is no honest one to emit", () => {
    const c = buildProgressCurve(pts(["2026-06-01", 20], ["2026-06-03", 40]));
    expect(Object.keys(c).sort()).toEqual([
      "areaPath",
      "domain",
      "gridlines",
      "height",
      "points",
      "polyline",
      "width",
    ]);
  });
});

describe("toPortalProgress — the customer boundary", () => {
  const now = new Date("2026-06-10T09:00:00Z");

  const internal = () =>
    summariseProgress(
      buildProgressSeries({
        observations: [
          obs("o1", "2026-06-01", 40, {
            note: "MARGIN BLOWN, client must not see this",
            recorded_by: "11111111-1111-1111-1111-111111111111",
          }),
          obs("o2", "2026-06-09", 55, {
            note: "waiting on the glazier again",
            recorded_by: "22222222-2222-2222-2222-222222222222",
          }),
        ],
      }),
      now,
    );

  it("carries the percentage, the date and the movement wording", () => {
    const p = toPortalProgress(internal());
    expect(p.percent).toBe(55);
    expect(p.updatedOn).toBe("2026-06-09");
    expect(p.daysSinceUpdate).toBe(1);
    expect(p.movement).toBe(PORTAL_MOVEMENT_LABELS.progressing);
    expect(p.hasProgress).toBe(true);
  });

  it("STRIPS internal notes and author identity from the whole payload", () => {
    const serialised = JSON.stringify(toPortalProgress(internal()));
    expect(serialised).not.toContain("MARGIN BLOWN");
    expect(serialised).not.toContain("glazier");
    expect(serialised).not.toContain("11111111-1111-1111-1111-111111111111");
    expect(serialised).not.toContain("22222222-2222-2222-2222-222222222222");
    expect(serialised).not.toContain("note");
    expect(serialised).not.toContain("author");
  });

  it("readings are rebuilt, not spread — only day and percent survive", () => {
    const p = toPortalProgress(internal());
    for (const r of p.readings) {
      expect(Object.keys(r).sort()).toEqual(["day", "percent"]);
    }
    expect(p.readings.map((r) => r.percent)).toEqual([40, 55]);
  });

  it("uses FACTUAL wording, not the internal verdict", () => {
    const stalled = summariseProgress(
      buildProgressSeries({
        observations: [obs("a", "2026-06-01", 45), obs("b", "2026-06-09", 45)],
      }),
      now,
    );
    expect(PROGRESS_TREND_LABELS[stalled.trend]).toBe("Stalled");
    expect(toPortalProgress(stalled).movement).toBe(
      "No change since the last update",
    );

    const regressed = summariseProgress(
      buildProgressSeries({
        observations: [obs("a", "2026-06-01", 70), obs("b", "2026-06-09", 55)],
      }),
      now,
    );
    expect(PROGRESS_TREND_LABELS[regressed.trend]).toBe("Went backwards");
    expect(toPortalProgress(regressed).movement).toBe("Revised down");
  });

  it("reports nothing to show rather than a misleading 0%", () => {
    const p = toPortalProgress(summariseProgress([], now));
    expect(p.hasProgress).toBe(false);
    expect(p.percent).toBeNull();
    expect(p.readings).toEqual([]);
    expect(p.movement).toBe(PORTAL_MOVEMENT_LABELS.none);
  });

  it("limits how much history a client receives", () => {
    const many = summariseProgress(
      buildProgressSeries({
        observations: Array.from({ length: 12 }, (_, i) =>
          obs(`o${i}`, `2026-05-${String(i + 1).padStart(2, "0")}`, i * 5),
        ),
      }),
      now,
    );
    const p = toPortalProgress(many, { limit: 4 });
    expect(p.readings).toHaveLength(4);
    // The TAIL — the most recent readings, still oldest-first.
    expect(p.readings.map((r) => r.day)).toEqual([
      "2026-05-09",
      "2026-05-10",
      "2026-05-11",
      "2026-05-12",
    ]);
  });
});
